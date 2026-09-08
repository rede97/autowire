// `autowire analysis` + `autowire init` (workspace bootstrap + hdxml sidecar run).

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { DEFAULT_TOML, hdxmlArgs } from "../workspace.js";
import { findHdxml, requireWorkspace } from "./shared.ts";

export function registerAnalysis(program: Command): void {
	program
		.command("init")
		.description(
			"Create default autowire.toml in the current directory (refuses to overwrite)",
		)
		.action(() => {
			const target = join(process.cwd(), "autowire.toml");
			if (existsSync(target)) {
				console.error(`autowire.toml already exists: ${target}`);
				process.exit(1);
			}
			Bun.write(target, DEFAULT_TOML);
			console.log(`created ${target}`);
		});

	program
		.command("analysis")
		.description(
			"Run hdxml analysis with args mapped from autowire.toml (docs/workspace-toml.md)",
		)
		.option(
			"--workspace <path>",
			"workspace dir or autowire.toml path (default: search upward from CWD)",
		)
		.option("--hdxml <bin>", "path to hdxml binary")
		.option(
			"--sub-bars",
			"per-thread sub progress bars (current file per worker)",
		)
		.option(
			"--refresh",
			"force full re-parse (analysis is incremental by default; this rewrites the cache)",
		)
		.action(
			async (opts: {
				workspace?: string;
				hdxml?: string;
				subBars?: boolean;
				refresh?: boolean;
			}) => {
				const cfg = await requireWorkspace(opts.workspace ?? process.cwd());
				if (
					cfg.filelists.length + cfg.walkDirs.length + cfg.sources.length ===
					0
				) {
					console.error(
						"autowire.toml: configure at least one of [analysis.rtl] filelists/walk_dirs/sources",
					);
					process.exit(1);
				}
				const args = hdxmlArgs(cfg);
				if (opts.subBars) args.push("--sub-bars");
				if (opts.refresh) args.push("--refresh");
				const proc = Bun.spawnSync({
					cmd: [findHdxml(opts.hdxml, cfg.hdxmlBin), ...args],
					stdout: "inherit",
					stderr: "inherit",
				});
				if (!existsSync(join(cfg.indexDir, "index.xml"))) {
					console.error(
						`hdxml analysis failed (exit ${proc.exitCode}); no index.xml`,
					);
					process.exit(1);
				}
				console.error(`RtlIndex dir: ${cfg.indexDir}`);
				if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1); // error files: index stays usable, exit code passes through (CI can gate)
			},
		);
}
