#!/usr/bin/env bun
// corpus 错误分类（docs/hdxml/testing.md §3）：把 scan 产物的错误文件按 oracle
// 交叉解析分为 真·解析器差距（oracle 接受、hdxml 拒绝）与 故意非法/伪代码
// （oracle 同样拒绝）。依赖 verible-verilog-syntax（smoke 已验证其可用）。
// 用法: bun hdxml/tests/triage.ts [corpus 目标名...]  （默认全部 corpus/*）
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const scanOut = join(root, "out/scan");

function* walkXml(dir: string): Generator<string> {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) yield* walkXml(p);
		else if (p.endsWith(".xml")) yield p;
	}
}

interface Counts {
	parseGap: number;
	parseIntentional: number;
	preprocess: number;
	redefined: number;
}

const targets = process.argv.slice(2);
for (const e of readdirSync(scanOut, { withFileTypes: true })) {
	if (!e.isDirectory() || !e.name.startsWith("corpus-")) continue;
	const name = e.name.slice("corpus-".length);
	if (targets.length > 0 && !targets.includes(name)) continue;

	const files: { path: string; kinds: Set<string> }[] = [];
	for (const x of walkXml(join(scanOut, e.name))) {
		const body = readFileSync(x, "utf8");
		if (!body.includes("<error ")) continue;
		const src = body.match(/<fileIndex source="([^"]+)"/)?.[1];
		if (!src || !existsSync(src)) continue;
		const kinds = new Set<string>();
		if (body.includes("parse failed")) kinds.add("parse");
		if (body.includes("preprocess failed")) kinds.add("preprocess");
		if (body.includes("module redefined")) kinds.add("redefined");
		files.push({ path: src, kinds });
	}

	// parse 失败的文件逐个过 oracle（verible 接受 = sv-parser 语法覆盖差距）
	const counts: Counts = { parseGap: 0, parseIntentional: 0, preprocess: 0, redefined: 0 };
	const gaps: string[] = [];
	const jobs = files.map(async (f) => {
		if (f.kinds.has("redefined")) counts.redefined++;
		if (f.kinds.has("preprocess")) counts.preprocess++;
		if (!f.kinds.has("parse")) return;
		const code = await Bun.spawn({
			cmd: ["verible-verilog-syntax", f.path],
			stdout: "ignore",
			stderr: "ignore",
		}).exited;
		if (code === 0) {
			counts.parseGap++;
			gaps.push(f.path);
		} else {
			counts.parseIntentional++;
		}
	});
	await Promise.all(jobs);

	console.log(
		`${`corpus/${name}`.padEnd(22)} gap=${String(counts.parseGap).padStart(3)}  intentional=${String(counts.parseIntentional).padStart(3)}  preprocess=${String(counts.preprocess).padStart(3)}  redefined=${String(counts.redefined).padStart(3)}`,
	);
	for (const g of gaps.sort()) console.log(`    gap: ${g.split(`/corpus/${name}/`)[1] ?? g}`);
}
