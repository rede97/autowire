// RtlIndex reader: parses index.xml produced by hdxml (format contract: docs/hdxml/rtlindex-xml.md; semantics: docs/hdxml/module-info.md §5).
// Read-only consumer; module→source mapping comes from the <files> index→source map, no per-file XML needed.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface FileEntry {
	source: string;
	index: string;
	status: "ok" | "error";
	modules: number;
	mtime: number;
}

export interface HierNode {
	module: string;
	blackbox: boolean;
	cycle: boolean;
	children: HierNode[];
}

export interface RtlIndex {
	tool: string;
	generated: number;
	/** Macro fingerprint: consumer macro set mismatch ⇒ the whole index is invalid (rtlindex-xml.md §6) */
	definesFp: string;
	/** Macros used during analysis (sorted by name); null = raw keep-raw macro (rtlindex-xml.md §4.2) */
	defines: Record<string, string | null>;
	files: FileEntry[];
	/** Module name → source file path */
	moduleSource: Map<string, string>;
	tops: HierNode[];
	errorFiles: FileEntry[];
}

// --- External input guards (Bun.XML returns untyped shapes; narrow layer by layer) ---

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

/** Bun.XML: repeated elements become arrays, single ones objects — always wrap as array */
function arr(v: unknown): unknown[] {
	if (Array.isArray(v)) return v;
	return v === undefined || v === null ? [] : [v];
}

function toHier(v: unknown): HierNode | null {
	if (!isObj(v)) return null;
	const module = str(v["@module"]);
	if (module.length === 0) return null;
	return {
		module,
		blackbox: v["@blackbox"] === "true",
		cycle: v["@cycle"] === "true",
		children: arr(v.node)
			.map(toHier)
			.filter((n): n is HierNode => n !== null),
	};
}

export async function loadRtlIndex(dir: string): Promise<RtlIndex> {
	const text = await readFile(join(dir, "index.xml"), "utf8");
	const doc: unknown = Bun.XML.parse(text);
	const root = isObj(doc) ? doc.rtlIndex : undefined;
	if (!isObj(root)) {
		throw new Error(
			`${dir}/index.xml is not a valid RtlIndex (missing <rtlIndex>)`,
		);
	}

	const defines: Record<string, string | null> = {};
	const definesEl = isObj(root.defines) ? root.defines : undefined;
	for (const d of arr(definesEl?.define)) {
		if (!isObj(d)) continue;
		defines[str(d["@name"])] =
			str(d["@raw"]) === "true" ? null : str(d["@value"]);
	}

	const files: FileEntry[] = [];
	const filesEl = isObj(root.files) ? root.files : undefined;
	for (const f of arr(filesEl?.file)) {
		if (!isObj(f)) continue;
		files.push({
			source: str(f["@source"]),
			index: str(f["@index"]),
			status: f["@status"] === "error" ? "error" : "ok",
			modules: Number(f["@modules"] ?? 0),
			mtime: Number(f["@mtime"] ?? 0),
		});
	}
	const sourceByIndex = new Map(files.map((f) => [f.index, f.source]));

	const moduleSource = new Map<string, string>();
	const modulesEl = isObj(root.modules) ? root.modules : undefined;
	for (const m of arr(modulesEl?.module)) {
		if (!isObj(m)) continue;
		const src = sourceByIndex.get(str(m["@index"]));
		if (src) moduleSource.set(str(m["@name"]), src);
	}

	const hierEl = isObj(root.hierarchy) ? root.hierarchy : undefined;
	const tops = arr(hierEl?.top)
		.map(toHier)
		.filter((n): n is HierNode => n !== null);

	return {
		tool: str(root["@tool"]) || "unknown",
		generated: Number(root["@generated"] ?? 0),
		definesFp: str(root["@definesFp"]),
		defines,
		files,
		moduleSource,
		tops,
		errorFiles: files.filter((f) => f.status === "error"),
	};
}
