// autowire.toml loading and hdxml argument mapping (contract: docs/workspace/toml.md).
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
	/** Workspace identity ([workspace] name): a C-identifier used for umbrella
	 *  file names and include guards. Required. */
	name: string;
	/** hdxml binary path ([analysis] hdxml_bin; null = default lookup: env/repo/PATH) */
	hdxmlBin: string | null;
	filelists: string[];
	walkDirs: string[];
	sources: string[];
	incdirs: string[];
	excludeFilenames: string[];
	/** Directory names to prune ([analysis.rtl] exclude_dirs) → --exclude-dirs */
	excludeDirs: string[];
	/** Expanding macros ([analysis.defines] with values) → -D NAME=VALUE */
	defines: Record<string, string>;
	/** Raw macros ([analysis].keep_raw) → --keep-raw */
	keepRaw: string[];
	/** Macro define headers (.svh; replaces the EDA ".f-head svh" global-macro trick) → --define-headers */
	defineHeaders: string[];
	/** RtlIndex output dir ([analysis.index] dir, default .autowire/hdxml) */
	indexDir: string;
	/**
	 * Legacy single dump sink ([dump] dir). Prefer connectDir/simDir/pluginsDir.
	 * When set without connect_dir, connect dumps still land here (compat).
	 */
	dumpDir: string;
	/** DE wrapper dump dir ([dump] connect_dir, default gen/connect) */
	connectDir: string;
	/** DV TB dump dir ([dump] sim_dir, default gen/sim) */
	simDir: string;
	/** Plugin generate root ([dump] plugins_dir, default gen/plugins) */
	pluginsDir: string;
	/** Param style ([style] param_inline, default true): inline simple overrides
	 *  into the instance; false folds every override into Mod__Inst__Param. */
	styleParamInline: boolean;
	/** [style] port_align: align module declaration port list columns
	 *  (dir / type / packed width; names left-aligned). Default false. */
	stylePortAlign: boolean;
	/** [style] param_align: align module declaration parameter names/=.
	 *  Default false. */
	styleParamAlign: boolean;
	/** [style] inst_port_align: pad instantiation port names and connections so
	 *  the ( and ) columns align across the whole file. Default false. */
	styleInstPortAlign: boolean;
	/** [style] inst_param_align: pad instantiation parameter names and values
	 *  so the ( and ) columns align across the whole file; shares columns with
	 *  inst_port_align when both are on. Default false. */
	styleInstParamAlign: boolean;
	/** [style] inst_port_dir: append a `// <dir>` comment to each instance
	 *  port-map row. Default false. */
	styleInstPortDir: boolean;
	/** [style] inst_port_dir_format: "full" (input/output/inout, default) or
	 *  "short" (i/o/io). */
	styleInstPortDirFormat: "full" | "short";
	/** [style] inst_port_width: append the target port width ([31:0]) to the
	 *  port-map comment, after the direction; 1-bit ports show none.
	 *  Default false. */
	styleInstPortWidth: boolean;
	/** [style] signal_align: align internal signal declaration columns
	 *  (nettype / packed width; names left-aligned). Default false. */
	styleSignalAlign: boolean;
	/** [style] localparam_upper: uppercase the generated Mod__Inst__Param
	 *  folding names (traditional RTL style); default false. */
	styleLocalparamUpper: boolean;
	/** Named connect units ([connect.<id>] html + deps); DAG validated at load */
	connectUnits: ConnectUnit[];
	/** DV sim units ([sim.<id>] html + deps); may depend on connect ids */
	simUnits: ConnectUnit[];
	/** Type-A wishbone SoT sources ([wishbone.<source_id>] ts=) */
	wishboneSources: WishboneSource[];
	/** Optional Excel workbook path ([plugins.wishbone] export); packed docs */
	wishboneExcelExport: string | null;
	/** Optional C header directory ([plugins.wishbone] c); packed layout+map */
	wishboneCExport: string | null;
	/** Optional uvm_reg SV directory ([plugins.wishbone] uvm); packed RAL */
	wishboneUvmExport: string | null;
}

/** One [connect.<id>] or [sim.<id>] entry */
export interface ConnectUnit {
	id: string;
	/** Absolute path to the author HTML */
	html: string;
	/** Direct dependency ids */
	deps: string[];
	kind: "connect" | "sim";
}

/**
 * One [wishbone.<source_id>] entry — a SoT .ts module that may export
 * RegfileDef and/or BusDef (types stay separate). toml id names the source
 * file slot, not a single leaf or fabric module.
 */
export interface WishboneSource {
	id: string;
	/** Absolute path to the .ts module */
	ts: string;
	/**
	 * Export names to generate; null/omit = every export that is a
	 * RegfileDef or BusDef.
	 */
	exports: string[] | null;
}

/** All units (connect then sim), for topo / lookup. */
export function allUnits(ws: WorkspaceConfig): ConnectUnit[] {
	return [...ws.connectUnits, ...ws.simUnits];
}

/** Resolve dump directory for a unit kind. */
export function unitDumpDir(
	ws: WorkspaceConfig,
	kind: "connect" | "sim",
): string {
	return kind === "sim" ? ws.simDir : ws.connectDir;
}

/** Find unit by id across connect + sim. */
export function findUnit(
	ws: WorkspaceConfig,
	id: string,
): ConnectUnit | undefined {
	return allUnits(ws).find((u) => u.id === id);
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

/** Parse [connect.<id>] or [sim.<id>] tables; reject flat html=…; validate deps later. */
export function parseNamedUnits(
	table: Record<string, unknown>,
	section: "connect" | "sim",
	rel: (p: string) => string,
): ConnectUnit[] {
	if (Object.hasOwn(table, "html")) {
		throw new Error(
			`autowire.toml: flat [${section}] html = [...] is removed — use [${section}.<id>] with html= and optional deps=`,
		);
	}
	const units: ConnectUnit[] = [];
	for (const [id, raw] of Object.entries(table)) {
		if (!isObj(raw)) {
			throw new Error(
				`autowire.toml: [${section}.${id}] must be a table (html=…, optional deps=)`,
			);
		}
		if (typeof raw.html !== "string" || raw.html.length === 0) {
			throw new Error(
				`autowire.toml: [${section}.${id}] html must be a non-empty string`,
			);
		}
		const deps = strList(raw.deps, `${section}.${id}.deps`);
		units.push({ id, html: rel(raw.html), deps, kind: section });
	}
	units.sort((a, b) => a.id.localeCompare(b.id));
	return units;
}

/** @deprecated use parseNamedUnits(..., "connect") */
export function parseConnectUnits(
	connect: Record<string, unknown>,
	rel: (p: string) => string,
): ConnectUnit[] {
	const units = parseNamedUnits(connect, "connect", rel);
	assertUnitDepsDag(units);
	return units;
}

/** Fail on unknown dep ids, self-deps, cycles; connect must not depend on sim. */
export function assertUnitDepsDag(units: ConnectUnit[]): void {
	const ids = new Set(units.map((u) => u.id));
	const byId = new Map(units.map((u) => [u.id, u]));
	for (const u of units) {
		for (const d of u.deps) {
			if (d === u.id) {
				throw new Error(
					`autowire.toml: [${u.kind}.${u.id}] deps must not include itself`,
				);
			}
			if (!ids.has(d)) {
				throw new Error(
					`autowire.toml: [${u.kind}.${u.id}] deps unknown id "${d}"`,
				);
			}
			const dep = byId.get(d);
			if (u.kind === "connect" && dep?.kind === "sim") {
				throw new Error(
					`autowire.toml: [connect.${u.id}] deps must not include sim unit "${d}"`,
				);
			}
		}
	}
	const indeg = new Map<string, number>();
	for (const id of ids) indeg.set(id, 0);
	for (const u of units) {
		for (const _d of u.deps) {
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
			`autowire.toml: unit deps form a cycle involving: ${cyclic.join(", ")}`,
		);
	}
}

/** @deprecated use assertUnitDepsDag */
export function assertConnectDepsDag(units: ConnectUnit[]): void {
	assertUnitDepsDag(units);
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
	if (doc.dump !== undefined)
		throw new Error("autowire.toml: [dump] is moved under [workspace.dump]");
	if (doc.style !== undefined)
		throw new Error("autowire.toml: [style] is moved under [workspace.style]");
	if (doc.hdxml !== undefined)
		throw new Error(
			"autowire.toml: [hdxml] is removed — set the binary via [analysis] hdxml_bin",
		);
	const workspace = isObj(doc.workspace) ? doc.workspace : {};
	const wsName = workspace.name;
	if (typeof wsName !== "string" || wsName.length === 0)
		throw new Error(
			"autowire.toml: [workspace] name is required (a C-identifier string)",
		);
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(wsName))
		throw new Error(
			`autowire.toml: [workspace] name "${wsName}" must match [A-Za-z_][A-Za-z0-9_]* (used for file names and C include guards)`,
		);
	const dump = isObj(workspace.dump) ? workspace.dump : {};
	const connect = isObj(doc.connect) ? doc.connect : {};
	const sim = isObj(doc.sim) ? doc.sim : {};
	const style = isObj(workspace.style) ? workspace.style : {};
	if (style.param !== undefined)
		throw new Error(
			`autowire.toml: [workspace.style] param is renamed to param_inline (boolean, default true)`,
		);
	for (const key of [
		"param_inline",
		"port_align",
		"param_align",
		"inst_port_align",
		"inst_param_align",
		"inst_port_dir",
		"inst_port_width",
		"signal_align",
		"localparam_upper",
	]) {
		const v = (style as Record<string, unknown>)[key];
		if (v !== undefined && typeof v !== "boolean")
			throw new Error(
				`autowire.toml: [workspace.style] ${key} must be a boolean`,
			);
	}
	const dirFormat = style.inst_port_dir_format;
	if (dirFormat !== undefined && dirFormat !== "full" && dirFormat !== "short")
		throw new Error(
			`autowire.toml: [workspace.style] inst_port_dir_format must be "full" or "short"`,
		);
	const hdxmlBinRaw = analysis.hdxml_bin;
	if (
		hdxmlBinRaw !== undefined &&
		(typeof hdxmlBinRaw !== "string" || hdxmlBinRaw.length === 0)
	)
		throw new Error(
			"autowire.toml: [analysis] hdxml_bin must be a non-empty string",
		);

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
	const hasLegacyDir = typeof dump.dir === "string";
	const hasConnectDir = typeof dump.connect_dir === "string";
	const hasSimDir = typeof dump.sim_dir === "string";
	const hasPluginsDir = typeof dump.plugins_dir === "string";
	const legacyDir = hasLegacyDir ? (dump.dir as string) : null;
	// Compat: lone [dump] dir= keeps connect dumps in that sink; otherwise thirds.
	const connectDirRel = hasConnectDir
		? (dump.connect_dir as string)
		: (legacyDir ?? "gen/connect");
	const simDirRel = hasSimDir
		? (dump.sim_dir as string)
		: legacyDir
			? join(legacyDir, "sim")
			: "gen/sim";
	const pluginsDirRel = hasPluginsDir
		? (dump.plugins_dir as string)
		: legacyDir
			? join(legacyDir, "plugins")
			: "gen/plugins";
	const connectUnits = parseNamedUnits(connect, "connect", rel);
	const simUnits = parseNamedUnits(sim, "sim", rel);
	const dup = connectUnits.find((c) => simUnits.some((s) => s.id === c.id));
	if (dup) {
		throw new Error(
			`autowire.toml: unit id "${dup.id}" used in both [connect.*] and [sim.*]`,
		);
	}
	assertUnitDepsDag([...connectUnits, ...simUnits]);
	if (doc.regfile !== undefined) {
		throw new Error(
			"autowire.toml: [regfile.*] is removed — use [wishbone.<source>] ts=",
		);
	}
	if (doc.bus !== undefined) {
		throw new Error(
			"autowire.toml: [bus.*] is removed — use [wishbone.<source>] ts=",
		);
	}
	const wishbone = isObj(doc.wishbone) ? doc.wishbone : {};
	const wishboneSources = parseWishboneSources(wishbone, rel);
	const plugins = isObj(doc.plugins) ? doc.plugins : {};
	if (plugins.regfile !== undefined) {
		throw new Error(
			"autowire.toml: [plugins.regfile] is removed — use [plugins.wishbone]",
		);
	}
	if (plugins.bus !== undefined) {
		throw new Error(
			"autowire.toml: [plugins.bus] is removed — use [plugins.wishbone]",
		);
	}
	const pluginsWishbone = isObj(plugins.wishbone) ? plugins.wishbone : {};
	const wishboneExcelExport = optPluginPath(pluginsWishbone, "export", rel);
	const wishboneCExport = optPluginPath(pluginsWishbone, "c", rel);
	const wishboneUvmExport = optPluginPath(pluginsWishbone, "uvm", rel);
	return {
		name: wsName,
		hdxmlBin:
			typeof analysis.hdxml_bin === "string" ? rel(analysis.hdxml_bin) : null,
		root,
		filelists: strList(rtl.filelists, "analysis.rtl.filelists").map(rel),
		walkDirs: strList(rtl.walk_dirs, "analysis.rtl.walk_dirs").map(rel),
		sources: strList(rtl.sources, "analysis.rtl.sources").map(rel),
		incdirs: strList(rtl.incdirs, "analysis.rtl.incdirs").map(rel),
		excludeFilenames: strList(
			rtl.exclude_filenames,
			"analysis.rtl.exclude_filenames",
		),
		excludeDirs: strList(rtl.exclude_dirs, "analysis.rtl.exclude_dirs"),
		defines,
		keepRaw: strList(analysis.keep_raw, "analysis.keep_raw"),
		defineHeaders: strList(
			analysis.define_headers,
			"analysis.define_headers",
		).map(rel),
		indexDir: rel(
			typeof index.dir === "string" ? index.dir : ".autowire/hdxml",
		),
		dumpDir: rel(legacyDir ?? connectDirRel),
		connectDir: rel(connectDirRel),
		simDir: rel(simDirRel),
		pluginsDir: rel(pluginsDirRel),
		styleParamInline: style.param_inline !== false,
		stylePortAlign: style.port_align === true,
		styleParamAlign: style.param_align === true,
		styleInstPortAlign: style.inst_port_align === true,
		styleInstParamAlign: style.inst_param_align === true,
		styleInstPortDir: style.inst_port_dir === true,
		styleInstPortDirFormat: dirFormat === "short" ? "short" : "full",
		styleInstPortWidth: style.inst_port_width === true,
		styleSignalAlign: style.signal_align === true,
		styleLocalparamUpper: style.localparam_upper === true,
		connectUnits,
		simUnits,
		wishboneSources,
		wishboneExcelExport,
		wishboneCExport,
		wishboneUvmExport,
	};
}

/** Optional [plugins.wishbone] path. */
function optPluginPath(
	table: Record<string, unknown>,
	key: string,
	rel: (p: string) => string,
): string | null {
	const v = table[key];
	if (v === undefined) return null;
	if (typeof v !== "string" || v.length === 0) {
		throw new Error(
			`autowire.toml: [plugins.wishbone] ${key} must be a non-empty string`,
		);
	}
	return rel(v);
}

function parseWishboneSources(
	table: Record<string, unknown>,
	rel: (p: string) => string,
): WishboneSource[] {
	const out: WishboneSource[] = [];
	for (const [id, raw] of Object.entries(table)) {
		if (!isObj(raw)) {
			throw new Error(`autowire.toml: [wishbone.${id}] must be a table`);
		}
		if (typeof raw.ts !== "string" || raw.ts.length === 0) {
			throw new Error(
				`autowire.toml: [wishbone.${id}] ts= is required (path to SoT .ts)`,
			);
		}
		if (raw.html !== undefined) {
			throw new Error(
				`autowire.toml: [wishbone.${id}] html= is forbidden (SoT is ts= only)`,
			);
		}
		if (raw.export !== undefined) {
			throw new Error(
				`autowire.toml: [wishbone.${id}] export= is removed — use exports = ["a","b"] or omit to take all RegfileDef and BusDef exports`,
			);
		}
		let exports: string[] | null = null;
		if (raw.exports !== undefined) {
			if (!Array.isArray(raw.exports) || raw.exports.length === 0) {
				throw new Error(
					`autowire.toml: [wishbone.${id}] exports must be a non-empty string array`,
				);
			}
			exports = [];
			for (const e of raw.exports) {
				if (typeof e !== "string" || e.length === 0) {
					throw new Error(
						`autowire.toml: [wishbone.${id}] exports entries must be non-empty strings`,
					);
				}
				exports.push(e);
			}
		}
		out.push({ id, ts: rel(raw.ts), exports });
	}
	out.sort((a, b) => a.id.localeCompare(b.id));
	return out;
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
	group("--exclude-dirs", cfg.excludeDirs);
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

/** Default config written by init (aligned with docs/workspace/toml.md §4) */
export function defaultToml(name: string): string {
	return `# autowire workspace config (contract: docs/workspace/toml.md)
# hdxml never reads this file: autowire analysis maps it to hdxml CLI args.

[workspace]
name = "${name}"

[analysis]
# hdxml binary path (relative to this file). Unset = default lookup:
# --hdxml CLI > $HDXML_BIN > repo hdxml/target/{release,debug} > PATH
# hdxml_bin = "hdxml/target/release/hdxml"
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
# directory names to prune (any path component match); e.g. ["dv", "tb"]
exclude_dirs = []

[analysis.defines]
# With value = expand (same as -D); do NOT put raw macros here — use keep_raw above
# SYNTHESIS = "1"

[analysis.index]
# RtlIndex XML dir; lives under the fixed generated temp dir .autowire
dir = ".autowire/hdxml"

[workspace.dump]
# Product dirs (docs/workspace/toml.md §4.0). Prefer these over legacy dir=.
connect_dir = "gen/connect"
sim_dir = "gen/sim"
plugins_dir = "gen/plugins"
# dir = "gen"  # deprecated single sink (compat only)

# Type-A wishbone (RegfileDef + BusDef stay separate types).
# [plugins.wishbone]
# export = "fw/gen/wishbone/bus_regfiles.xlsx"
# c = "fw/gen/wishbone"   # regfile/<sheet>.h + bus/<bus>_map.h + ${name}.h umbrella
# uvm = "dv/ral"          # regfile/ral_<SHEET>.sv + bus/ral_block_<bus>.sv + ral_${name}.sv umbrella
# [wishbone.soc]
# ts = "sot/wb_bus_soc.ts"

[workspace.style]
# Param overrides: param_inline = true (default) writes simple overrides into
# the instance (#(.W(8))); false folds each override into Mod__Inst__Param.
# inst_port_dir = true appends "// input" to each instance port-map row
# (inst_port_dir_format = "short" prints "// i" / "// o" / "// io");
# inst_port_width = true adds the port width after it ("// input [31:0]").

# Named DE units (DAG). Do not use flat [connect] html = [...].
# [connect.sha256wb]
# html = "sot/connect/sha256wb.html"
# [connect.soc_top]
# html = "sot/connect/soc_top.html"
# deps = ["sha256wb"]

# DV TB tops (aw-tb-mod); dump → sim_dir. May deps= connect ids.
# [sim.soc_tb]
# html = "sim/soc_tb.html"
# deps = ["soc_top"]
`;
}
