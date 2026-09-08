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
	/** hdxml binary path ([hdxml] bin; null = default lookup: env/repo/PATH) */
	hdxmlBin: string | null;
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
	/** Param style ([style] param): "inline" (default) writes overrides into the
	 *  instance; "localparam" folds them into Mod__Inst__Param localparams. */
	styleParam: "inline" | "localparam";
	/** Named connect units ([connect.<id>] html + deps); DAG validated at load */
	connectUnits: ConnectUnit[];
}

/** One [connect.<id>] entry (docs/workspace-toml.md §4.1) */
export interface ConnectUnit {
	id: string;
	/** Absolute path to the connect HTML */
	html: string;
	/** Direct dependency ids (other connect unit ids) */
	deps: string[];
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

/** Parse [connect.<id>] tables; reject flat [connect] html=…; validate deps DAG (no cycles). */
export function parseConnectUnits(
	connect: Record<string, unknown>,
	rel: (p: string) => string,
): ConnectUnit[] {
	if (Object.hasOwn(connect, "html")) {
		throw new Error(
			"autowire.toml: flat [connect] html = [...] is removed — use [connect.<id>] with html= and optional deps=",
		);
	}
	const units: ConnectUnit[] = [];
	for (const [id, raw] of Object.entries(connect)) {
		if (!isObj(raw)) {
			throw new Error(
				`autowire.toml: [connect.${id}] must be a table (html=…, optional deps=)`,
			);
		}
		if (typeof raw.html !== "string" || raw.html.length === 0) {
			throw new Error(
				`autowire.toml: [connect.${id}] html must be a non-empty string`,
			);
		}
		const deps = strList(raw.deps, `connect.${id}.deps`);
		units.push({ id, html: rel(raw.html), deps });
	}
	units.sort((a, b) => a.id.localeCompare(b.id));
	assertConnectDepsDag(units);
	return units;
}

/** Fail on unknown dep ids, self-deps, or cycles. */
export function assertConnectDepsDag(units: ConnectUnit[]): void {
	const ids = new Set(units.map((u) => u.id));
	for (const u of units) {
		for (const d of u.deps) {
			if (d === u.id) {
				throw new Error(
					`autowire.toml: [connect.${u.id}] deps must not include itself`,
				);
			}
			if (!ids.has(d)) {
				throw new Error(
					`autowire.toml: [connect.${u.id}] deps unknown id "${d}"`,
				);
			}
		}
	}
	// Kahn topological sort — leftover nodes imply a cycle
	const indeg = new Map<string, number>();
	for (const id of ids) indeg.set(id, 0);
	for (const u of units) {
		for (const _d of u.deps) {
			// edge dep → u (u depends on dep; dep must come first)
			indeg.set(u.id, (indeg.get(u.id) ?? 0) + 1);
		}
	}
	const q = [...ids].filter((id) => indeg.get(id) === 0).sort();
	let seen = 0;
	while (q.length > 0) {
		const id = q.shift();
		if (id === undefined) break;
		seen++;
		for (const u of units) {
			if (!u.deps.includes(id)) continue;
			const n = (indeg.get(u.id) ?? 0) - 1;
			indeg.set(u.id, n);
			if (n === 0) {
				q.push(u.id);
				q.sort();
			}
		}
	}
	if (seen !== ids.size) {
		const cyclic = [...ids].filter((id) => (indeg.get(id) ?? 0) > 0).sort();
		throw new Error(
			`autowire.toml: [connect.*] deps form a cycle involving: ${cyclic.join(", ")}`,
		);
	}
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
	const connect = isObj(doc.connect) ? doc.connect : {};
	const style = isObj(doc.style) ? doc.style : {};
	if (
		style.param !== undefined &&
		style.param !== "inline" &&
		style.param !== "localparam"
	)
		throw new Error(
			`autowire.toml: [style] param must be "inline" or "localparam"`,
		);
	const hdxml = isObj(doc.hdxml) ? doc.hdxml : {};
	if (hdxml.bin !== undefined && typeof hdxml.bin !== "string")
		throw new Error("autowire.toml: [hdxml] bin must be a string");

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
		hdxmlBin: typeof hdxml.bin === "string" ? rel(hdxml.bin) : null,
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
		styleParam: style.param === "localparam" ? "localparam" : "inline",
		connectUnits: parseConnectUnits(connect, rel),
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
	args.push("--output-dir", cfg.indexDir);
	return args;
}

/** Default config written by init (aligned with docs/workspace-toml.md §4) */
export const DEFAULT_TOML = `# autowire workspace config (contract: docs/workspace-toml.md)
# hdxml never reads this file: autowire analysis maps it to hdxml CLI args.

[hdxml]
# hdxml binary path (relative to this file). Unset = default lookup:
# --hdxml CLI > $HDXML_BIN > repo hdxml/target/{release,debug} > PATH
# bin = "hdxml/target/release/hdxml"

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

[style]
# Param overrides: "inline" (default) writes the expression into the instance
# (#(.W(8))); "localparam" folds each override into a Mod__Inst__Param
# localparam (connect-rules §7).
# param = "inline"

# Named connect units (DAG). Do not use flat [connect] html = [...].
# Cross-unit references require deps=; cycles / unknown ids fail at load.
# Ready units with no pending deps can elaborate in parallel.
# [connect.phy_wrap]
# html = "connect/phy_wrap.html"
# [connect.phy_wrap_tb]
# html = "connect/phy_wrap_tb.html"
# deps = ["phy_wrap"]
`;
