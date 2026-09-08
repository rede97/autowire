// `autowire deps <path>` — RTL module dependency tree.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { loadRtlIndex } from "../rtl/rtlindex.ts";
import { renderSummary, renderTrees } from "../rtl/tree.ts";
import { analyzeWithSidecar, findHdxml } from "./shared.ts";

export function registerDeps(program: Command): void {
	program
		.command("deps")
		.description(
			"Print RTL module dependency tree (colored); <path> is RtlIndex or RTL sources",
		)
		.argument("<path>", "RtlIndex dir (with index.xml) or RTL source dir")
		.option("--top <name>", "print only the named top module tree")
		.option("--depth <n>", "limit expand depth", (v) => Number(v))
		.option(
			"-I, --incdir <dir...>",
			"source mode: include search paths (passed to hdxml)",
		)
		.option("--hdxml <bin>", "source mode: path to hdxml binary")
		.action(
			async (
				path: string,
				opts: {
					top?: string;
					depth?: number;
					incdir?: string[];
					hdxml?: string;
				},
			) => {
				const indexDir = existsSync(join(path, "index.xml"))
					? path
					: analyzeWithSidecar(path, findHdxml(opts.hdxml), opts.incdir ?? []);
				const index = await loadRtlIndex(indexDir);
				for (const line of renderSummary(index)) console.log(line);
				for (const line of renderTrees(index, {
					top: opts.top,
					depth: opts.depth,
				}))
					console.log(line);
			},
		);
}
