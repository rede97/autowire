// Leaf module facts from the RtlIndex (`.autowire/hdxml`): params + ports + imports
// for one module, parsed from its file XML. Read-only; the connect page and the
// check path share this shape (docs/workspace/web-ui.md §5: leaf facts come only from hdxml).

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadRtlIndex } from "./rtlindex.ts";

export interface LeafParam {
	name: string;
	kind: string;
	dataType: string;
	defaultText: string | null;
}

export interface LeafPort {
	name: string;
	dir: string;
	dataType: string;
	packed: string | null;
	unpacked: string | null;
	interface: string | null;
	modport: string | null;
}

export interface LeafModule {
	name: string;
	params: LeafParam[];
	ports: LeafPort[];
	imports: { package: string; symbol: string }[];
}

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

function arr(v: unknown): unknown[] {
	if (Array.isArray(v)) return v;
	return v === undefined || v === null ? [] : [v];
}

const PORT_DIRS = ["input", "output", "inout", "ref", "interface", "port"];

/** On-demand, cached leaf facts over an RtlIndex directory. */
export class LeafDb {
	private files = new Map<string, string>(); // module name → file XML rel path
	private cache = new Map<string, LeafModule | null>();
	private ready = false;

	constructor(private dir: string) {}

	private async ensure(): Promise<void> {
		if (this.ready) return;
		const index = await loadRtlIndex(this.dir);
		// moduleSource maps module → source path; the file XML mirrors it (§2).
		for (const f of index.files) {
			for (const [name, src] of index.moduleSource) {
				if (src === f.source) this.files.set(name, f.index);
			}
		}
		this.ready = true;
	}

	async has(name: string): Promise<boolean> {
		await this.ensure();
		return this.files.has(name);
	}

	async get(name: string): Promise<LeafModule | null> {
		await this.ensure();
		if (this.cache.has(name)) return this.cache.get(name) ?? null;
		const rel = this.files.get(name);
		if (!rel) {
			this.cache.set(name, null);
			return null;
		}
		const path = join(this.dir, rel);
		if (!existsSync(path)) {
			this.cache.set(name, null);
			return null;
		}
		const text = await readFile(path, "utf8");
		const doc: unknown = Bun.XML.parse(text);
		const root = isObj(doc) ? doc.fileIndex : undefined;
		let found: LeafModule | null = null;
		for (const m of arr(isObj(root) ? root.module : undefined)) {
			if (!isObj(m) || str(m["@name"]) !== name) continue;
			found = parseLeafModule(name, m);
			break;
		}
		this.cache.set(name, found);
		return found;
	}
}

function parseLeafModule(name: string, m: Record<string, unknown>): LeafModule {
	const params: LeafParam[] = [];
	const paramsEl = isObj(m.params) ? m.params : undefined;
	for (const p of arr(paramsEl?.param)) {
		if (!isObj(p)) continue;
		params.push({
			name: str(p["@name"]),
			kind: str(p["@kind"]) || "parameter",
			dataType: str(p["@dataType"]),
			defaultText: str(p["@default"]) || null,
		});
	}
	const ports: LeafPort[] = [];
	const portsEl = isObj(m.ports) ? m.ports : undefined;
	for (const dir of PORT_DIRS) {
		for (const p of arr(portsEl?.[dir])) {
			if (!isObj(p)) continue;
			ports.push({
				name: str(p["@name"]),
				dir,
				dataType: str(p["@dataType"]),
				packed: str(p["@packed"]) || null,
				unpacked: str(p["@unpacked"]) || null,
				interface: str(p["@interface"]) || null,
				modport: str(p["@modport"]) || null,
			});
		}
	}
	const imports: { package: string; symbol: string }[] = [];
	const impEl = isObj(m.imports) ? m.imports : undefined;
	for (const i of arr(impEl?.import)) {
		if (!isObj(i)) continue;
		imports.push({
			package: str(i["@package"]),
			symbol: str(i["@symbol"]) || "*",
		});
	}
	return { name, params, ports, imports };
}
