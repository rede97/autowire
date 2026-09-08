// Shared connect-unit plumbing for `autowire check` and `autowire web`:
// author HTML loading (linkedom), cross-unit dep snapshots, and the ctx object
// the aw.js engine consumes. The checker/elaborator itself lives in web/aw.js
// (single source; the browser page and the server run the same code).

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseHTML } from "linkedom";
import { parseConnectXml } from "./connectxml.ts";
import type { LeafDb, LeafModule } from "./leaf.ts";
import type { ConnectUnit, WorkspaceConfig } from "./workspace.ts";

export interface WrapperFacts {
	name: string;
	params: { name: string; value: string }[];
	ports: {
		name: string;
		dir: string;
		packed: string | null;
		unpacked: string | null;
	}[];
	imports: { package: string; symbol: string }[];
}

export interface EngineCtx {
	/** [style] from autowire.toml (param inline/localparam). */
	style: { param: "inline" | "localparam" };
	unitId: string;
	unitDeps: string[];
	unitMods: Map<string, string>; // mod name → owning unit id (top-level mods)
	leaf: (mod: string) => LeafModule | null;
	wrapper: (mod: string) => WrapperFacts | null;
}

export interface UnitDoc {
	unit: ConnectUnit;
	doc: Document;
}

/** Parse an author HTML file into a linkedom document (path guarded to the workspace). */
export async function loadUnitDoc(
	ws: WorkspaceConfig,
	unit: ConnectUnit,
): Promise<UnitDoc> {
	const path = resolve(ws.root, unit.html);
	if (!path.startsWith(ws.root))
		throw new Error(`unit "${unit.id}": html path escapes the workspace`);
	if (!existsSync(path))
		throw new Error(`unit "${unit.id}": author HTML not found: ${unit.html}`);
	const text = await readFile(path, "utf8");
	const { document } = parseHTML(text);
	return { unit, doc: document };
}

/** Top-level aw-mod names per unit (for cross-unit reference checks). */
export async function unitModNames(
	ws: WorkspaceConfig,
	units: ConnectUnit[],
): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	for (const u of units) {
		try {
			const { doc } = await loadUnitDoc(ws, u);
			for (const el of doc.querySelectorAll("autowire > aw-mod")) {
				const name = el.getAttribute("name");
				if (name) map.set(name, u.id);
			}
		} catch {
			// Unreadable unit: its own check reports the file error.
		}
	}
	return map;
}

/** Snapshot dir: fixed generated temp (docs/workspace-toml.md §4.1). */
export const connectDir = (ws: WorkspaceConfig) =>
	join(ws.root, ".autowire", "connect");

/** Wrapper facts from a dep unit's elaborated snapshot: the abstract XML
 *  sidecar (.autowire/connect/<id>.xml) is the only on-disk form. Returns []
 *  when the snapshot is missing (callers report "snapshot missing"). */
export async function loadDepWrappers(
	ws: WorkspaceConfig,
	depId: string,
): Promise<WrapperFacts[]> {
	const xmlPath = join(connectDir(ws), `${depId}.xml`);
	if (!existsSync(xmlPath)) return [];
	const mods = parseConnectXml(await readFile(xmlPath, "utf8"));
	return mods.map((m) => ({
		name: m.name,
		params: m.params,
		ports: m.ports.map((p) => ({
			name: p.name,
			dir: p.dir,
			packed: p.packed,
			unpacked: p.unpacked,
		})),
		imports: m.imports,
	}));
}

export interface BuiltCtx {
	ctx: EngineCtx;
	/** Snapshot-missing errors detected while resolving dep wrappers. */
	errors: string[];
	/** Pre-fetch every referenced leaf module so ctx.leaf stays synchronous. */
	prewarm: (doc: Document) => Promise<void>;
}

/** Build the engine ctx for one unit: leaf tables + dep snapshots + unit mods. */
export async function buildEngineCtx(
	ws: WorkspaceConfig,
	unit: ConnectUnit,
	units: ConnectUnit[],
	leafDb: LeafDb,
): Promise<BuiltCtx> {
	const errors: string[] = [];
	const unitMods = await unitModNames(ws, units);
	const wrappers = new Map<string, WrapperFacts>();
	for (const dep of unit.deps) {
		const facts = await loadDepWrappers(ws, dep);
		if (facts.length === 0) {
			errors.push(
				`unit "${unit.id}" deps: snapshot for "${dep}" missing under .autowire/connect/ (render/dump "${dep}" first)`,
			);
		}
		for (const f of facts) wrappers.set(f.name, f);
	}
	const cache = new Map<string, LeafModule | null>();
	const leaf = (mod: string) => {
		// Sync facade for the engine; callers pre-warm via prewarmLeafs().
		return cache.get(mod) ?? null;
	};
	const ctx: EngineCtx = {
		style: { param: ws.styleParam },
		unitId: unit.id,
		unitDeps: unit.deps,
		unitMods,
		leaf,
		wrapper: (mod) => wrappers.get(mod) ?? null,
	};
	const prewarm = async (doc: Document) => {
		const wanted = new Set<string>();
		for (const el of doc.querySelectorAll("aw-inst")) {
			const mod = el.getAttribute("mod") ?? "";
			if (mod && !wrappers.has(mod) && unitMods.get(mod) !== unit.id)
				wanted.add(mod);
		}
		for (const mod of wanted) cache.set(mod, await leafDb.get(mod));
	};
	return { ctx, errors, prewarm };
}

/** Topo order of connect units (deps first); workspace load already rejects cycles. */
export function topoUnits(units: ConnectUnit[]): ConnectUnit[] {
	const byId = new Map(units.map((u) => [u.id, u]));
	const out: ConnectUnit[] = [];
	const done = new Set<string>();
	const visit = (u: ConnectUnit) => {
		if (done.has(u.id)) return;
		done.add(u.id);
		for (const d of u.deps) {
			const dep = byId.get(d);
			if (dep) visit(dep);
		}
		out.push(u);
	};
	for (const u of units) visit(u);
	return out;
}
