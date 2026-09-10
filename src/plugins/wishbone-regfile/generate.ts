// wishbone-regfile type-A generate: load SoT → layout → emit → plugins_dir.

import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { RegfileSource, WorkspaceConfig } from "../../workspace.ts";
import { isRegfileDef, type RegfileDef } from "./dsl.ts";
import { emitRegfileSv } from "./emit.ts";
import { layoutRegfile } from "./layout.ts";

export const PLUGIN_ID = "wishbone-regfile";

/** Load one named export; must be RegfileDef with name === exportName. */
export async function loadRegfileDef(
	tsPath: string,
	exportName: string,
): Promise<RegfileDef> {
	const abs = resolve(tsPath);
	const mod = (await import(pathToFileURL(abs).href)) as Record<
		string,
		unknown
	>;
	const v = mod[exportName];
	if (v === undefined) {
		throw new Error(
			`wishbone-regfile: export "${exportName}" not found in ${abs}`,
		);
	}
	if (!isRegfileDef(v)) {
		throw new Error(
			`wishbone-regfile: export "${exportName}" is not a RegfileDef`,
		);
	}
	if (v.name !== exportName) {
		throw new Error(
			`wishbone-regfile: RegfileDef.name "${v.name}" must equal export "${exportName}"`,
		);
	}
	return v;
}

/** All RegfileDef exports from a SoT module (optionally filtered). */
export async function loadRegfileDefsFromSource(
	source: RegfileSource,
): Promise<RegfileDef[]> {
	const abs = resolve(source.ts);
	const mod = (await import(pathToFileURL(abs).href)) as Record<
		string,
		unknown
	>;
	const names =
		source.exports ?? Object.keys(mod).filter((k) => isRegfileDef(mod[k]));
	if (names.length === 0) {
		throw new Error(
			`wishbone-regfile: no RegfileDef exports in ${abs} (source "${source.id}")`,
		);
	}
	const defs: RegfileDef[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		if (seen.has(name)) {
			throw new Error(
				`wishbone-regfile: duplicate export "${name}" in source "${source.id}"`,
			);
		}
		seen.add(name);
		defs.push(await loadRegfileDef(abs, name));
	}
	return defs;
}

export async function generateDef(
	ws: WorkspaceConfig,
	def: RegfileDef,
): Promise<string> {
	const laid = layoutRegfile(def);
	const sv = emitRegfileSv(laid);
	const outDir = join(ws.pluginsDir, PLUGIN_ID);
	await mkdir(outDir, { recursive: true });
	const outPath = join(outDir, `${def.name.toLowerCase()}_regfile.sv`);
	await Bun.write(outPath, sv);
	return outPath;
}

export async function generateAll(
	ws: WorkspaceConfig,
	sources: readonly RegfileSource[],
): Promise<string[]> {
	const paths: string[] = [];
	const leafNames = new Set<string>();
	for (const src of sources) {
		const defs = await loadRegfileDefsFromSource(src);
		for (const def of defs) {
			if (leafNames.has(def.name)) {
				throw new Error(
					`wishbone-regfile: duplicate RegfileDef.name "${def.name}" across sources`,
				);
			}
			leafNames.add(def.name);
			paths.push(await generateDef(ws, def));
		}
	}
	return paths;
}
