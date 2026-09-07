// autowire.toml loading and hdxml argument mapping (contract: docs/workspace-toml.md).
// hdxml never reads the toml: everything is mapped to hdxml CLI args by this module.
// Lookup: nearest autowire.toml upward from CWD (or --workspace); relative paths in the
// toml resolve against its own directory (the workspace root).

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse } from "smol-toml";

export interface WorkspaceConfig {
	/** Directory containing autowire.toml (the workspace root) */
	root: string;
	filelists: string[];
	walkDirs: string[];
	sources: string[];
	incdirs: string[];
	excludeFilenames: string[];
	/** Expanding macros ([analysis.defines] with values) → -D NAME=VALUE */
	defines: Record<string, string>;
	/** Raw macros ([analysis].keep_raw) → --keep-raw */
	keepRaw: string[];
	/** Macro define headers (.svh; replaces the EDA ".f-head svh" global-macro trick) → --define-headers */
	defineHeaders: string[];
	/** RtlIndex output dir ([analysis.index] dir, default .autowire/hdxml) */
	indexDir: string;
	/** Dump RTL output dir ([dump] dir, default gen) */
	dumpDir: string;
}

/** Find autowire.toml upward from startDir; returns the file path or null */
export function findWorkspace(startDir: string): string | null {
	let dir = resolve(startDir);
	for (;;) {
		const candidate = join(dir, "autowire.toml");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strList(v: unknown, key: string): string[] {
	if (v === undefined) return [];
	if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
		throw new Error(`autowire.toml: ${key} must be a list of strings`);
	}
	return v as string[];
}

export async function loadWorkspace(
	tomlPath: string,
): Promise<WorkspaceConfig> {
	const root = dirname(tomlPath);
	const doc: unknown = parse(await readFile(tomlPath, "utf8"));
	if (!isObj(doc))
		throw new Error("autowire.toml: parse failed (not a TOML table)");

	const analysis = isObj(doc.analysis) ? doc.analysis : {};
	const rtl = isObj(analysis.rtl) ? analysis.rtl : {};
	const index = isObj(analysis.index) ? analysis.index : {};
	const dump = isObj(doc.dump) ? doc.dump : {};

	const defines: Record<string, string> = {};
	if (analysis.defines !== undefined) {
		if (!isObj(analysis.defines))
			throw new Error("autowire.toml: [analysis.defines] must be a table");
		for (const [k, v] of Object.entries(analysis.defines)) {
			if (typeof v === "string" && v.length > 0) defines[k] = v;
			else if (typeof v === "number" || typeof v === "boolean")
				defines[k] = String(v);
			else if (v === "") {
				throw new Error(
					`autowire.toml: [analysis.defines] ${k} empty value is removed — list raw macros under analysis.keep_raw`,
				);
			} else {
				throw new Error(
					`autowire.toml: [analysis.defines] ${k} must be a string/number/boolean`,
				);
			}
		}
	}

	const rel = (p: string) => (isAbsolute(p) ? p : join(root, p));
	return {
		root,
		filelists: strList(rtl.filelists, "analysis.rtl.filelists").map(rel),
		walkDirs: strList(rtl.walk_dirs, "analysis.rtl.walk_dirs").map(rel),
		sources: strList(rtl.sources, "analysis.rtl.sources").map(rel),
		incdirs: strList(rtl.incdirs, "analysis.rtl.incdirs").map(rel),
		excludeFilenames: strList(
			rtl.exclude_filenames,
			"analysis.rtl.exclude_filenames",
		),
		defines,
		keepRaw: strList(analysis.keep_raw, "analysis.keep_raw"),
		defineHeaders: strList(
			analysis.define_headers,
			"analysis.define_headers",
		).map(rel),
		indexDir: rel(
			typeof index.dir === "string" ? index.dir : ".autowire/hdxml",
		),
		dumpDir: rel(typeof dump.dir === "string" ? dump.dir : "gen"),
	};
}

/** WorkspaceConfig → hdxml argv (hdxml has no subcommand; order is stable for tests) */
export function hdxmlArgs(cfg: WorkspaceConfig): string[] {
	const args: string[] = [];
	const group = (flag: string, values: string[]) => {
		if (values.length > 0) args.push(flag, ...values);
	};
	group("-f", cfg.filelists);
	group("-s", cfg.sources);
	group("-w", cfg.walkDirs);
	group("--exclude-filenames", cfg.excludeFilenames);
	group("-I", cfg.incdirs);
	group("--define-headers", cfg.defineHeaders);
	group(
		"-D",
		Object.entries(cfg.defines)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([n, v]) => `${n}=${v}`),
	);
	group("--keep-raw", [...cfg.keepRaw].sort());
	args.push("--xml", cfg.indexDir);
	return args;
}

/** Default config written by init (aligned with docs/workspace-toml.md §4) */
export const DEFAULT_TOML = `# autowire workspace config (contract: docs/workspace-toml.md)
# hdxml never reads this file: autowire analysis maps it to hdxml CLI args.

[analysis]
# Macro define headers (same as hdxml --define-headers): replaces the traditional EDA
# ".f-head .svh" global-macro trick — per-file parallel preprocessing cannot carry
# macros across files. Extracted macros stay RAW (sentinel) by default; override
# per-name with an expanding entry in [analysis.defines].
# define_headers = ["rtl/include/project_defines.svh"]

# Raw macros (port expressions keep \`NAME verbatim, \`ifdef stays true,
# restored at dump; passed as --keep-raw)
# keep_raw = ["WIDTH", "ENV_MACRO"]

[analysis.rtl]
# All three sources may coexist; union-deduplicated
filelists = []
walk_dirs = ["rtl"]
sources = []
# include search paths (+incdir)
incdirs = []
exclude_filenames = []

[analysis.defines]
# With value = expand (same as -D); do NOT put raw macros here — use keep_raw above
# SYNTHESIS = "1"

[analysis.index]
# RtlIndex XML dir; lives under the fixed generated temp dir .autowire
dir = ".autowire/hdxml"

[dump]
# Dumped RTL output dir (product for DV; not under .autowire)
dir = "gen"

[connect]
# Optional: default author HTML / logical connect top
# html = "connect/phy_wrap.html"
# top = "phy_wrap"
`;
