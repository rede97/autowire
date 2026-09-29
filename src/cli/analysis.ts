// `autowire init` and `autowire analysis` (docs/cli.md §3).
// analysis run writes the RtlIndex. deps, search, and info only read it.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Command } from "commander";
import { LeafDb } from "../rtl/leaf.ts";
import { loadRtlIndex, type RtlIndex } from "../rtl/rtlindex.ts";
import { renderSummary, renderTrees } from "../rtl/tree.ts";
import { defaultToml, hdxmlArgs, type WorkspaceConfig } from "../workspace.js";
import { ensureWishboneDsl, loadPack } from "./pack.ts";
import { findHdxml, requireWorkspace } from "./shared.ts";

export type DumpKind = "plugins" | "connect" | "sim";

/** Filelist paths under [workspace.dump] that are not on disk yet. */
export function generatedFilelistGaps(
	cfg: Pick<
		WorkspaceConfig,
		"root" | "filelists" | "pluginsDir" | "connectDir" | "simDir"
	>,
): { path: string; kind: DumpKind }[] {
	const gaps: { path: string; kind: DumpKind }[] = [];
	const seen = new Set<string>();
	const posix = (abs: string) => relative(cfg.root, abs).split(sep).join("/");
	const kindOf = (abs: string): DumpKind | null => {
		const rel = posix(abs);
		const under = (dirAbs: string) => {
			const dir = posix(dirAbs);
			return rel === dir || rel.startsWith(`${dir}/`);
		};
		if (under(cfg.pluginsDir)) return "plugins";
		if (under(cfg.connectDir)) return "connect";
		if (under(cfg.simDir)) return "sim";
		return null;
	};
	for (const list of cfg.filelists) {
		const listAbs = isAbsolute(list) ? list : join(cfg.root, list);
		if (seen.has(listAbs)) continue;
		seen.add(listAbs);
		let text: string;
		try {
			text = readFileSync(listAbs, "utf8");
		} catch {
			continue;
		}
		for (const raw of text.split("\n")) {
			const line = raw
				.replace(/\/\/.*/, "")
				.replace(/#.*/, "")
				.trim();
			if (!line || line.startsWith("-") || line.startsWith("+")) continue;
			const abs = isAbsolute(line) ? line : join(cfg.root, line);
			if (existsSync(abs)) continue;
			const kind = kindOf(abs);
			if (kind) gaps.push({ path: posix(abs), kind });
		}
	}
	return gaps;
}

/** What to run before analysis when the filelist names generated files. */
export function formatGeneratedGaps(
	gaps: readonly { path: string; kind: DumpKind }[],
): string {
	const plugins = gaps.some((gap) => gap.kind === "plugins");
	const connect = gaps.some(
		(gap) => gap.kind === "connect" || gap.kind === "sim",
	);
	const shown = gaps
		.slice(0, 8)
		.map((gap) => `  ${gap.path}`)
		.join("\n");
	const more = gaps.length > 8 ? `\n  ... and ${gaps.length - 8} more` : "";
	const writers = [
		plugins ? "`plugin wishbone run` writes plugins_dir" : "",
		connect
			? "`connect run` writes connect_dir and sim_dir, and the .autowire/connect snapshots that `connect check` needs"
			: "",
	]
		.filter((line) => line.length > 0)
		.join(". ");
	const noun = gaps.length === 1 ? "entry is" : "entries are";
	return [
		`analysis: ${gaps.length} filelist ${noun} under [workspace.dump] but not on disk yet:`,
		shown + more,
		`${writers}. Generate those, then re-run analysis.`,
	].join("\n");
}

export function registerAnalysis(program: Command): void {
	program
		.command("init")
		.description(
			"Create default autowire.toml and AGENTS-AUTOWIRE.md in the current directory (refuses to overwrite either)",
		)
		.argument(
			"<name>",
			"workspace name (C-identifier); names the wishbone umbrella files",
		)
		.action(async (name: string) => {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
				console.error(`init: name "${name}" must match [A-Za-z_][A-Za-z0-9_]*`);
				process.exit(1);
			}
			const tomlTarget = join(process.cwd(), "autowire.toml");
			const agentsTarget = join(process.cwd(), "AGENTS-AUTOWIRE.md");
			const existing = [tomlTarget, agentsTarget].filter((p) => existsSync(p));
			if (existing.length > 0) {
				console.error(`already exists: ${existing.join(", ")}`);
				process.exit(1);
			}
			const pack = await loadPack();
			const contract = pack.find((f) => f.path === "AGENTS.md");
			if (!contract) {
				console.error("docs pack has no AGENTS.md");
				process.exit(1);
			}
			await Bun.write(tomlTarget, defaultToml(name));
			await Bun.write(agentsTarget, contract.bytes);
			// RtlIndex lives here (fixed location); pre-create so first analysis
			// run has no surprise mkdir.
			const indexDir = join(process.cwd(), ".autowire", "hdxml");
			await mkdir(indexDir, { recursive: true });
			// DSL sources so standalone SoT can import from .autowire/dsl/
			// instead of a repo checkout (version travels with the bundle).
			const dslFiles = await ensureWishboneDsl(process.cwd());
			console.log(`created ${tomlTarget}`);
			console.log(`created ${agentsTarget}`);
			console.log(`created ${indexDir}/`);
			console.log(`created .autowire/dsl/ (${dslFiles.length} files)`);
		});

	const analysis = program
		.command("analysis")
		.description(
			"RtlIndex: run hdxml, then query deps, names, and module info",
		);

	analysis
		.command("run")
		.description(
			"Run hdxml analysis with args mapped from autowire.toml (docs/workspace/toml.md)",
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
		.option("--force", "rewrite the RtlIndex cache (full re-parse)")
		.action(
			async (opts: {
				workspace?: string;
				hdxml?: string;
				subBars?: boolean;
				force?: boolean;
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
				const gaps = generatedFilelistGaps(cfg);
				if (gaps.length > 0) {
					console.error(formatGeneratedGaps(gaps));
					process.exit(1);
				}
				const args = hdxmlArgs(cfg);
				if (opts.subBars) args.push("--sub-bars");
				if (opts.force) args.push("--refresh");
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
				if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);
			},
		);

	analysis
		.command("deps")
		.description("Print RTL module dependency trees from the existing RtlIndex")
		.argument("[module]", "print only this module; omit for every tree")
		.option("--depth <n>", "limit expand depth", (v) => Number(v))
		.option(
			"--workspace <path>",
			"workspace dir or autowire.toml path (default: search upward from CWD)",
		)
		.action(
			async (
				module: string | undefined,
				opts: { depth?: number; workspace?: string },
			) => {
				const cfg = await requireWorkspace(opts.workspace ?? process.cwd());
				const index = await readIndex(cfg.indexDir);
				for (const line of renderSummary(index)) console.log(line);
				for (const line of renderTrees(index, {
					top: module,
					depth: opts.depth,
				}))
					console.log(line);
			},
		);

	analysis
		.command("search")
		.description("Search the RtlIndex by fuzzy name or regex. Does not write.")
		.argument("<pattern>", "fuzzy substring, or a regex with --regex")
		.option("--module", "search module names (default)")
		.option("--port", "search port names")
		.option("--package", "search package names")
		.option("--enum", "search package localparam names (enum constants)")
		.option("--regex", "treat pattern as a regular expression")
		.option(
			"--workspace <path>",
			"workspace dir or autowire.toml path (default: search upward from CWD)",
		)
		.action(
			async (
				pattern: string,
				opts: {
					module?: boolean;
					port?: boolean;
					package?: boolean;
					enum?: boolean;
					regex?: boolean;
					workspace?: string;
				},
			) => {
				const kinds = [
					opts.module ? "module" : "",
					opts.port ? "port" : "",
					opts.package ? "package" : "",
					opts.enum ? "enum" : "",
				].filter((k) => k !== "");
				if (kinds.length > 1) {
					console.error(
						"analysis search: choose only one of --module --port --package --enum",
					);
					process.exit(1);
				}
				const kind = (kinds[0] ?? "module") as SearchKind;
				const cfg = await requireWorkspace(opts.workspace ?? process.cwd());
				const index = await readIndex(cfg.indexDir);
				const match = matcher(pattern, opts.regex ?? false);
				const hits = await searchIndex(cfg.indexDir, index, kind, match);
				if (hits.length === 0) {
					console.error(`no ${kind} matches ${pattern}`);
					process.exit(1);
				}
				for (const hit of hits) {
					const at = hit.line ? `:${hit.line}` : "";
					console.log(`${hit.name}\txml=${hit.xml}\trtl=${hit.rtl}${at}`);
				}
			},
		);

	analysis
		.command("info")
		.description("Print one module's params and ports from the RtlIndex")
		.argument("<module>", "exact module name")
		.option(
			"--workspace <path>",
			"workspace dir or autowire.toml path (default: search upward from CWD)",
		)
		.action(async (module: string, opts: { workspace?: string }) => {
			const cfg = await requireWorkspace(opts.workspace ?? process.cwd());
			const index = await readIndex(cfg.indexDir);
			if (!index.moduleSource.has(module)) {
				console.error(
					`module not in RtlIndex: ${module} (analysis search --module for a fuzzy name)`,
				);
				process.exit(1);
			}
			const leaf = await new LeafDb(cfg.indexDir).get(module);
			if (!leaf) {
				console.error(`module ${module} has no file XML in ${cfg.indexDir}`);
				process.exit(1);
			}
			console.log(`module ${module}`);
			console.log(`xml ${index.moduleIndex.get(module) ?? ""}`);
			console.log(`rtl ${index.moduleSource.get(module) ?? ""}`);
			console.log("params");
			if (leaf.params.length === 0) console.log("  (none)");
			for (const p of leaf.params) {
				console.log(
					`  ${p.kind} ${p.name}${p.dataType ? ` ${p.dataType}` : ""}${p.defaultText ? ` = ${p.defaultText}` : ""}`,
				);
			}
			console.log("ports");
			if (leaf.ports.length === 0) console.log("  (none)");
			for (const p of leaf.ports) {
				const width = [p.packed, p.unpacked].filter(Boolean).join(" ");
				console.log(`  ${p.dir} ${p.name}${width ? ` ${width}` : ""}`);
			}
		});
}

async function readIndex(dir: string): Promise<RtlIndex> {
	if (!existsSync(join(dir, "index.xml"))) {
		console.error(`no RtlIndex at ${dir} (run: autowire analysis run)`);
		process.exit(1);
	}
	return loadRtlIndex(dir);
}

type SearchKind = "module" | "port" | "package" | "enum";

interface SearchHit {
	name: string;
	xml: string;
	rtl: string;
	line?: number;
	/** RTL declaration to scan. Port and enum hits scan the owner, not the member. */
	owner?: string;
}

function matcher(pattern: string, regex: boolean): (name: string) => boolean {
	if (!regex) {
		const needle = pattern.toLowerCase();
		return (name) => name.toLowerCase().includes(needle);
	}
	let re: RegExp;
	try {
		re = new RegExp(pattern);
	} catch (e) {
		console.error(`bad regex: ${e instanceof Error ? e.message : e}`);
		process.exit(1);
	}
	return (name) => re.test(name);
}

async function searchIndex(
	dir: string,
	index: RtlIndex,
	kind: SearchKind,
	match: (name: string) => boolean,
): Promise<SearchHit[]> {
	if (kind === "module") {
		const hits = [...index.moduleSource.entries()]
			.filter(([name]) => match(name))
			.map(([name, rtl]) => ({
				name,
				xml: index.moduleIndex.get(name) ?? "",
				rtl,
			}));
		const lines = await declarationLines(hits.map((h) => [h.name, h.rtl]));
		return hits.map((h) => ({ ...h, line: lines.get(`${h.rtl}\0${h.name}`) }));
	}
	if (kind === "package") {
		const hits = [...index.packageSource.entries()]
			.filter(([name]) => match(name))
			.map(([name, rtl]) => ({
				name,
				xml: index.packageIndex.get(name) ?? "",
				rtl,
			}));
		const lines = await declarationLines(
			hits.map((h) => [h.name, h.rtl]),
			"package",
		);
		return hits.map((h) => ({ ...h, line: lines.get(`${h.rtl}\0${h.name}`) }));
	}
	const db = new LeafDb(dir);
	const hits: SearchHit[] = [];
	const names =
		kind === "enum"
			? [...index.packageSource.keys()]
			: [...index.moduleSource.keys()];
	for (const owner of names) {
		const leaf = await db.get(owner);
		if (!leaf) continue;
		const xml =
			(kind === "enum" ? index.packageIndex : index.moduleIndex).get(owner) ??
			"";
		const rtl =
			(kind === "enum" ? index.packageSource : index.moduleSource).get(owner) ??
			"";
		const items =
			kind === "enum"
				? leaf.params.filter((p) => p.kind === "localparam").map((p) => p.name)
				: leaf.ports.map((p) => p.name);
		for (const name of items) {
			if (match(name)) hits.push({ name: `${owner}.${name}`, xml, rtl, owner });
		}
	}
	const lines = await declarationLines(
		hits.map((h) => [h.owner ?? "", h.rtl]),
		kind === "enum" ? "localparam" : "port",
	);
	return hits.map((h) => ({
		name: h.name,
		xml: h.xml,
		rtl: h.rtl,
		line: lines.get(`${h.rtl}\0${h.owner}`),
	}));
}

/** Line of the declaration in the RTL file. One read per file, so several
 * modules declared in the same file each get their own line. Port and enum
 * hits use the owning module or package line: the index has no member span. */
async function declarationLines(
	items: readonly (readonly [string, string])[],
	kind: "module" | "package" | "port" | "localparam" = "module",
): Promise<Map<string, number>> {
	const byFile = new Map<string, string[]>();
	for (const [name, rtl] of items) {
		const names = byFile.get(rtl) ?? [];
		names.push(name);
		byFile.set(rtl, names);
	}
	const out = new Map<string, number>();
	for (const [rtl, names] of byFile) {
		let text = "";
		try {
			text = await readFile(rtl.replace(/^\\\\\?\\/, ""), "utf8");
		} catch {
			continue;
		}
		const lines = text.split(/\r?\n/);
		const keyword =
			kind === "package"
				? "package"
				: kind === "localparam"
					? "localparam"
					: "module";
		for (const name of names) {
			const re = new RegExp(`\\b${keyword}\\s+${name}\\b`);
			const line = lines.findIndex((row) => re.test(row));
			if (line >= 0) out.set(`${rtl}\0${name}`, line + 1);
		}
	}
	return out;
}
