#!/usr/bin/env bun
import { createHash } from "node:crypto";
// 测试环境冒烟（docs/hdxml/testing.md）：工具链存在性 + 语料抽样交叉解析基线。
// 用法: bun hdxml/tests/smoke.ts [抽样数，默认 60]
import { readdirSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const n = Number(process.argv[2] ?? 60);

console.log("== 工具链");
let ok = true;
for (const t of [
	"verilator",
	"verible-verilog-syntax",
	"verible-verilog-lint",
	"git",
]) {
	const found = Bun.which(t) !== null;
	console.log(`   [${found ? "ok" : "MISSING"}] ${t}`);
	if (!found) ok = false;
}
const pyslang =
	Bun.spawnSync({ cmd: ["python3", "-c", "import pyslang"] }).exitCode === 0;
console.log(`   [${pyslang ? "ok" : "MISSING"}] pyslang (slang)`);
if (!(ok && pyslang)) {
	console.error("工具链不完整，中止");
	process.exit(1);
}

/** 稳定抽样：按路径哈希排序取前 n（跨运行可复现） */
function* walk(dir: string): Generator<string> {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (e.name === ".git") continue;
		const p = join(dir, e.name);
		if (e.isDirectory()) yield* walk(p);
		else if (p.endsWith(".sv")) yield p;
	}
}
const files = [...walk(join(root, "corpus"))]
	.map((f) => ({ f, h: createHash("sha256").update(f).digest("hex") }))
	.sort((a, b) => a.h.localeCompare(b.h))
	.slice(0, n)
	.map((x) => x.f);

const oracles: Record<string, (f: string) => number> = {
	"verible-verilog-syntax": (f) =>
		Bun.spawnSync({
			cmd: ["verible-verilog-syntax", f],
			stdout: "ignore",
			stderr: "ignore",
		}).exitCode,
	"verilator --lint-only": (f) =>
		Bun.spawnSync({
			cmd: [
				"verilator",
				"--lint-only",
				"-Wno-fatal",
				"-Wno-lint",
				"--timing",
				f,
			],
			stdout: "ignore",
			stderr: "ignore",
		}).exitCode,
};

console.log(`\n== 语料抽样交叉解析 (n=${files.length}/oracle)`);
for (const [name, run] of Object.entries(oracles)) {
	const passed = files.filter((f) => run(f) === 0).length;
	console.log(`   ${name}: ${passed}/${files.length} 通过`);
}
console.log(
	"   （语料含单文件不可独立编译/故意非法的用例，各 oracle 成功率不必一致；",
);
console.log("    该基线用于校验环境，后续 CI 用固定清单而非随机抽样）");
