// autowire CLI entry (bun). Commands:
//   help [topic]  command index (default); Agent contract: help agent
//   init          create default autowire.toml in CWD
//   analysis      run hdxml analysis with args from autowire.toml
//   deps <path>   print RTL module dependency tree (RtlIndex dir, or RTL sources via hdxml sidecar)

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { renderHelp } from "./src/help.js";
import { loadRtlIndex } from "./src/rtlindex.js";
import { renderSummary, renderTrees } from "./src/tree.js";
import {
	DEFAULT_TOML,
	findWorkspace,
	hdxmlArgs,
	loadWorkspace,
} from "./src/workspace.js";

/** Resolve hdxml binary: --hdxml > toml [hdxml] bin > $HDXML_BIN > repo target/{release,debug} > PATH */
function findHdxml(explicit?: string, tomlBin?: string | null): string {
	if (tomlBin && !existsSync(tomlBin)) {
		console.error(`autowire.toml: [hdxml] bin not found: ${tomlBin}`);
		process.exit(1);
	}
	const candidates = [
		explicit,
		tomlBin ?? undefined,
		process.env.HDXML_BIN,
		join(import.meta.dir, "hdxml/target/release/hdxml"),
		join(import.meta.dir, "hdxml/target/debug/hdxml"),
	].filter((c): c is string => typeof c === "string" && c.length > 0);
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	return "hdxml"; // fall back to PATH; spawn fails if missing
}

/** When path is an RTL source dir, run the hdxml sidecar into .autowire/hdxml (autowire-owned fixed temp dir; GC keeps it clean). */
function analyzeWithSidecar(
	rtlDir: string,
	hdxmlBin: string,
	incdirs: string[],
): string {
	const outDir = join(import.meta.dir, ".autowire/hdxml");
	const args = ["-w", rtlDir, "--xml", outDir];
	for (const i of incdirs) args.push("-I", i);
	const proc = Bun.spawnSync({
		cmd: [hdxmlBin, ...args],
		stdout: "inherit",
		stderr: "inherit",
	});
	if (!existsSync(join(outDir, "index.xml"))) {
		console.error(
			`hdxml analysis failed (exit ${proc.exitCode}); no index.xml`,
		);
		process.exit(1);
	}
	console.error(`RtlIndex dir: ${outDir}`);
	return outDir;
}

const program = new Command();
program
	.name("autowire")
	.description(
		"RTL register and connectivity tool. Agents: run `help agent`; do not invent a project prompt.",
	)
	.addHelpText(
		"after",
		"\nCommands:  bun index.ts help\nAgent contract:  bun index.ts help agent\nTopics:  bun index.ts help topics\n",
	);

program.addHelpCommand(false);
program
	.command("help")
	.description("Command index (default) or topic help; Agents: help agent")
	.argument(
		"[topic]",
		"agent | status | workspace | analysis | connect | web | dump | cli | deps | dont | topics",
	)
	.action((topic?: string) => {
		try {
			console.log(renderHelp(topic));
		} catch (e) {
			console.error(e instanceof Error ? e.message : e);
			process.exit(1);
		}
	});

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
			opts: { top?: string; depth?: number; incdir?: string[]; hdxml?: string },
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
	.action(
		async (opts: { workspace?: string; hdxml?: string; subBars?: boolean }) => {
			const start = opts.workspace ?? process.cwd();
			const tomlPath = start.endsWith(".toml") ? start : findWorkspace(start);
			if (!tomlPath || !existsSync(tomlPath)) {
				console.error(
					`autowire.toml not found from ${start} (run: autowire init)`,
				);
				process.exit(1);
			}
			const cfg = await loadWorkspace(tomlPath);
			if (
				cfg.filelists.length + cfg.walkDirs.length + cfg.sources.length ===
				0
			) {
				console.error(
					`autowire.toml: configure at least one of [analysis.rtl] filelists/walk_dirs/sources (${tomlPath})`,
				);
				process.exit(1);
			}
			const args = hdxmlArgs(cfg);
			if (opts.subBars) args.push("--sub-bars");
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

if (process.argv.slice(2).length === 0) {
	console.log(renderHelp());
} else {
	program.parse();
}
