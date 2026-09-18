// wishbone-regfile type-A generate: load SoT → layout → emit → plugins_dir.

import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { RegfileSource, WorkspaceConfig } from "../../workspace.ts";
import { effectiveSheet, isRegfileDef, type RegfileDef } from "./dsl.ts";
import { emitRegfileSv } from "./emit.ts";
import { writeRegfileExcel } from "./emit-excel.ts";
import {
	emitRegfileC,
	emitRegfileUvm,
	swLayoutFingerprint,
} from "./emit-sw.ts";
import { type LaidRegfile, layoutRegfile } from "./layout.ts";

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
	swSheets: Map<string, string> = new Map(),
	excelBySheet: Map<string, LaidRegfile> = new Map(),
): Promise<string[]> {
	const laid = layoutRegfile(def);
	const paths: string[] = [];
	const svDir = join(ws.pluginsDir, PLUGIN_ID);
	await mkdir(svDir, { recursive: true });
	const svPath = join(svDir, `${def.name.toLowerCase()}_regfile.sv`);
	await Bun.write(svPath, emitRegfileSv(laid));
	paths.push(svPath);
	const table = effectiveSheet(def);
	const fp = swLayoutFingerprint(laid);
	const prev = swSheets.get(table);
	if (prev !== undefined) {
		if (prev !== fp) {
			throw new Error(
				`wishbone-regfile: sheet "${table}" reused by "${def.name}" with a different field layout`,
			);
		}
		return paths;
	}
	swSheets.set(table, fp);
	if (ws.regfileExcelExport) excelBySheet.set(table, laid);
	if (ws.regfileCExport) {
		await mkdir(ws.regfileCExport, { recursive: true });
		const cPath = join(ws.regfileCExport, `${table}.h`);
		await Bun.write(cPath, emitRegfileC(laid));
		paths.push(cPath);
	}
	if (ws.regfileUvmExport) {
		await mkdir(ws.regfileUvmExport, { recursive: true });
		const uPath = join(ws.regfileUvmExport, `ral_${table.toUpperCase()}.sv`);
		await Bun.write(uPath, emitRegfileUvm(laid));
		paths.push(uPath);
	}
	return paths;
}

export async function generateAll(
	ws: WorkspaceConfig,
	sources: readonly RegfileSource[],
): Promise<string[]> {
	const paths: string[] = [];
	const leafNames = new Set<string>();
	const swSheets = new Map<string, string>();
	const excelBySheet = new Map<string, LaidRegfile>();
	for (const src of sources) {
		const defs = await loadRegfileDefsFromSource(src);
		for (const def of defs) {
			if (leafNames.has(def.name)) {
				throw new Error(
					`wishbone-regfile: duplicate RegfileDef.name "${def.name}" across sources`,
				);
			}
			leafNames.add(def.name);
			paths.push(...(await generateDef(ws, def, swSheets, excelBySheet)));
		}
	}
	if (ws.regfileExcelExport) {
		await writeRegfileExcel(ws.regfileExcelExport, [...excelBySheet.values()]);
		paths.push(ws.regfileExcelExport);
	}
	return paths;
}
