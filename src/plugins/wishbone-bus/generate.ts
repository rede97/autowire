// wishbone-bus type-A generate: load SoT → emit → plugins_dir.

import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BusSource, WorkspaceConfig } from "../../workspace.ts";
import { type BusDef, isBusDef } from "./dsl.ts";
import { busModuleName, emitBusSv } from "./emit.ts";

export const PLUGIN_ID = "wishbone-bus";

export async function loadBusDef(
	tsPath: string,
	exportName: string,
): Promise<BusDef> {
	const abs = resolve(tsPath);
	const mod = (await import(pathToFileURL(abs).href)) as Record<
		string,
		unknown
	>;
	const v = mod[exportName];
	if (v === undefined) {
		throw new Error(`wishbone-bus: export "${exportName}" not found in ${abs}`);
	}
	if (!isBusDef(v)) {
		throw new Error(`wishbone-bus: export "${exportName}" is not a BusDef`);
	}
	if (v.name !== exportName) {
		throw new Error(
			`wishbone-bus: BusDef.name "${v.name}" must equal export "${exportName}"`,
		);
	}
	return v;
}

export async function loadBusDefsFromSource(
	source: BusSource,
): Promise<BusDef[]> {
	const abs = resolve(source.ts);
	const mod = (await import(pathToFileURL(abs).href)) as Record<
		string,
		unknown
	>;
	const names =
		source.exports ?? Object.keys(mod).filter((k) => isBusDef(mod[k]));
	if (names.length === 0) {
		throw new Error(
			`wishbone-bus: no BusDef exports in ${abs} (source "${source.id}")`,
		);
	}
	const defs: BusDef[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		if (seen.has(name)) {
			throw new Error(
				`wishbone-bus: duplicate export "${name}" in source "${source.id}"`,
			);
		}
		seen.add(name);
		defs.push(await loadBusDef(abs, name));
	}
	return defs;
}

export async function generateDef(
	ws: WorkspaceConfig,
	def: BusDef,
): Promise<string> {
	const sv = emitBusSv(def);
	const outDir = join(ws.pluginsDir, PLUGIN_ID);
	await mkdir(outDir, { recursive: true });
	const outPath = join(outDir, `${busModuleName(def)}.sv`);
	await Bun.write(outPath, sv);
	return outPath;
}

export async function generateAll(
	ws: WorkspaceConfig,
	sources: readonly BusSource[],
): Promise<string[]> {
	const paths: string[] = [];
	const leafNames = new Set<string>();
	for (const src of sources) {
		const defs = await loadBusDefsFromSource(src);
		for (const def of defs) {
			const mod = busModuleName(def);
			if (leafNames.has(mod)) {
				throw new Error(
					`wishbone-bus: duplicate module "${mod}" across sources`,
				);
			}
			leafNames.add(mod);
			paths.push(await generateDef(ws, def));
		}
	}
	return paths;
}
