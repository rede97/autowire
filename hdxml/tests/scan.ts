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

/** 含 .svh 的目录及其父目录（覆盖 "regs.svh" 源相对式与 "common_cells/regs.svh" 前缀式 include） */
function includeDirs(base: string): string[] {
	const dirs = new Set<string>();
	for (const f of walk(base)) {
		if (!f.endsWith(".svh")) continue;
		dirs.add(dirname(f));
		dirs.add(dirname(dirname(f)));
	}
	return [...dirs].sort();
}

const siblingIncdirs = includeDirs(join(root, "projects"));

interface TargetCfg {
	/** projects 组共享全部 include 目录并排除验证侧目录 */
	excludeDirs?: string[];
	/** 真展开的全局宏头文件（EDA .f 头部 svh 等价物；ASSERT 等模块项宏） */
	expandHeaders?: string[];
	/** 额外 -D（如 VERILATOR 选 prim_assert 假宏分支） */
	defines?: string[];
}

const perTarget: Record<string, TargetCfg> = {
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

for (const group of ["projects", "corpus"]) {
	for (const e of readdirSync(join(root, group), { withFileTypes: true })) {
		if (!e.isDirectory()) continue;
		const dir = join(root, group, e.name);
		const name = `${group}/${dir.replace(/\/$/, "").split("/").pop()}`;
		const dest = join(outDir, name.replace("/", "-"));
		const cfg = perTarget[name] ?? {};
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
		if (cfg.expandHeaders) {
			args.push(
				"--expand-headers",
				...cfg.expandHeaders.map((h) => join(dir, h)),
			);
		}
		if (group === "projects") {
			// 验证侧目录（UVM/FPV 库不在分析范围）——剩余错误即真 RTL 问题
			args.push("--exclude-dirs", "dv", "verif", "tb", "testbench");
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
