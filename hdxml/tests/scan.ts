#!/usr/bin/env bun
// 全量扫描测试（docs/hdxml/testing.md）：逐目标独立 hdxml 进程、进度条原生渲染、
// 统计走 hdxml --summary 报告文件，末尾统一打印汇总。
// 用法: bun hdxml/tests/scan.ts [--refresh] [额外 hdxml 参数...]
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = import.meta.dir;
const outDir = join(root, "out/scan");
const hdxml = [
	join(root, "../target/debug/hdxml"),
	join(root, "../target/release/hdxml"),
].find(existsSync);
if (!hdxml) {
	console.error("hdxml binary not found; run: cargo build");
	process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const refresh = process.argv.slice(2).includes("--refresh");
const extra = process.argv.slice(2).filter((a) => a !== "--refresh");

/** 递归列出目录（跳过 .git） */
function* walk(dir: string): Generator<string> {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.name === ".git") continue;
		const p = join(dir, e.name);
		if (e.isDirectory()) yield* walk(p);
		else yield p;
	}
}

/** incdirs 探测：含 .svh 的目录 ∪ 名为 include 的目录（前者覆盖源相对式 include，
 *  后者覆盖 cv32e40p bhv/include 这类只放 .sv 被 include 文件的目录）；
 *  各级目录的父目录一并加入（覆盖 "common_cells/regs.svh" 前缀式 include） */
function includeDirs(base: string): string[] {
	const dirs = new Set<string>();
	for (const f of walk(base)) {
		if (!f.endsWith(".svh") && !f.endsWith(".vh") && !f.includes("/include/"))
			continue;
		dirs.add(dirname(f));
		dirs.add(dirname(dirname(f)));
	}
	return [...dirs].sort();
}

const siblingIncdirs = includeDirs(join(root, "projects"));

interface TargetCfg {
	/** 排除文件名（实现变体二选一，如 cv32e40p register_file ff/latch 取 ff） */
	excludeFilenames?: string[];
	/** 追加排除目录名（合并进 projects 组全局排除；如 hpdcache SRAM 工艺变体） */
	excludeDirs?: string[];
	/** 真展开的全局宏头文件（EDA .f 头部 svh 等价物；ASSERT 等模块项宏） */
	expandHeaders?: string[];
	/** 额外 -D（如 VERILATOR 选 prim_assert 假宏分支） */
	defines?: string[];
	/** 生成步骤（marker 缺失时执行一次；如 veer-el2 的 el2_param.vh 由 veer.config 生成） */
	gen?: { cmd: string[]; marker: string };
	/** 追加扫描目录（相对目标目录；如 cva6 的 hpdcache 子模块独立克隆在兄弟目录） */
	extraWalkDirs?: string[];
}

const perTarget: Record<string, TargetCfg> = {
	"projects/cv32e40p": {
		excludeFilenames: ["cv32e40p_register_file_latch.sv"],
	},
	"projects/cva6": {
		extraWalkDirs: ["../cv-hpdcache/rtl/src"],
		excludeDirs: ["blackbox"],
	},
	"projects/cv-hpdcache": {
		excludeDirs: ["blackbox", "syn"],
	},
	"projects/veer-el2": {
		gen: {
			cmd: [
				"sh",
				"-c",
				"perl configs/veer.config >/dev/null && tools/picmap -t 31 > snapshots/default/pic_map_auto.h",
			],
			marker: "snapshots/default/pic_map_auto.h",
		},
		expandHeaders: ["design/lib/el2_assert.sv"],
		defines: ["TEC_RV_ICG=el2_beh_icg"],
		excludeDirs: ["riscv-dv"],
	},
	"projects/opentitan": {
		expandHeaders: [
			"hw/ip/prim/rtl/prim_assert.sv",
			"hw/ip/prim/rtl/prim_flop_macros.sv",
		],
		defines: ["VERILATOR"],
	},
	"projects/ibex": {
		expandHeaders: [
			"vendor/lowrisc_ip/ip/prim/rtl/prim_assert.sv",
			"vendor/lowrisc_ip/ip/prim/rtl/prim_flop_macros.sv",
		],
		defines: ["VERILATOR"],
	},
};

interface Row {
	name: string;
	stats: Record<string, string> | null;
	note: string;
}

const rows: Row[] = [];
let failed = false;

// verilog-mode 是 Emacs 缩进模式仓库，夹具含大量伪代码（tests_ok/ 也非合法 SV），
// 其错误纯噪音——只留在 smoke 的 oracle 抽样中，不进扫描基线
const skipTargets: Record<string, true> = { "corpus/verilog-mode": true };

for (const group of ["projects", "corpus"]) {
	for (const e of readdirSync(join(root, group), { withFileTypes: true })) {
		if (!e.isDirectory()) continue;
		const dir = join(root, group, e.name);
		const name = `${group}/${dir.replace(/\/$/, "").split("/").pop()}`;
		if (skipTargets[name]) continue;
		const dest = join(outDir, name.replace("/", "-"));
		const cfg = perTarget[name] ?? {};
		if (cfg.gen && !existsSync(join(dir, cfg.gen.marker))) {
			console.log(`  gen: ${cfg.gen.cmd.join(" ")}`);
			const g = Bun.spawnSync({
				cmd: cfg.gen.cmd,
				cwd: dir,
				stdout: "inherit",
				stderr: "inherit",
			});
			if (g.exitCode !== 0) console.error(`  gen failed (exit ${g.exitCode})`);
		}
		const incdirs = includeDirs(dir);
		const args = [
			"-w",
			dir,
			"-o",
			dest,
			"--summary",
			join(dest, "summary.txt"),
		];
		for (const i of incdirs) args.push("-I", i);
		for (const d of cfg.defines ?? []) args.push("-D", d);
		if (cfg.excludeFilenames)
			args.push("--exclude-filenames", ...cfg.excludeFilenames);
		if (cfg.extraWalkDirs) {
			for (const w of cfg.extraWalkDirs) args.push("-w", join(dir, w));
		}
		if (cfg.expandHeaders) {
			args.push(
				"--expand-headers",
				...cfg.expandHeaders.map((h) => join(dir, h)),
			);
		}
		if (group === "projects") {
			// 验证侧目录（UVM/FPV 库不在分析范围）——剩余错误即真 RTL 问题
			args.push(
				"--exclude-dirs",
				"dv",
				"verif",
				"tb",
				"testbench",
				"generic_dv",
				...(cfg.excludeDirs ?? []),
			);
			for (const i of siblingIncdirs)
				if (!incdirs.includes(i)) args.push("-I", i);
		}
		console.log(`================ ${name} ================`);
		console.log(
			`+ hdxml ${args.join(" ")} --sub-bars${refresh ? " --refresh" : ""}`,
		);
		const proc = Bun.spawn(
			[
				hdxml,
				...args,
				"--sub-bars",
				...(refresh ? ["--refresh"] : []),
				...extra,
			],
			{
				stdout: "inherit",
				stderr: "inherit",
			},
		);
		const code = await proc.exited;
		console.log();
		const summaryPath = join(dest, "summary.txt");
		if (!existsSync(join(dest, "index.xml")) || !existsSync(summaryPath)) {
			rows.push({ name, stats: null, note: `FAILED (exit ${code})` });
			failed = true;
			continue;
		}
		const stats: Record<string, string> = {};
		for (const line of readFileSync(summaryPath, "utf8").split("\n")) {
			const m = line.match(/^(\w+): (.+)$/);
			if (m) stats[m[1]] = m[2];
		}
		rows.push({
			name,
			stats,
			note: code === 0 ? "ok" : `exit ${code} (error files)`,
		});
	}
}

const cols = ["files", "modules", "tops", "blackbox", "error_files"] as const;
console.log("================ summary ================");
console.log(
	"target".padEnd(22) +
		cols.map((c) => c.replace("error_files", "errors").padStart(9)).join("") +
		"  note",
);
for (const r of rows) {
	const cells = cols.map((c) => (r.stats?.[c] ?? "-").padStart(9)).join("");
	console.log(`${r.name.padEnd(22)}${cells}  ${r.note}`);
}
process.exit(failed ? 1 : 0);
