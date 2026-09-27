// wishbone-regfile SV (+ optional per-sheet C/uvm_reg). Packed Excel/C/UVM
// umbrellas live in src/plugins/wishbone/generate.ts.

import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeIfChanged } from "../../core/write.ts";
import type { WorkspaceConfig } from "../../workspace.ts";
import { PLUGIN_ID } from "../wishbone/id.ts";
import { effectiveSheet, isRegfileDef, type RegfileDef } from "./dsl.ts";
import { emitRegfileSv } from "./emit.ts";
import {
	emitRegfileC,
	emitRegfileUvm,
	swLayoutFingerprint,
} from "./emit-sw.ts";
import { type LaidRegfile, layoutRegfile } from "./layout.ts";

export { PLUGIN_ID };

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
		throw new Error(`wishbone: export "${exportName}" not found in ${abs}`);
	}
	if (!isRegfileDef(v)) {
		throw new Error(`wishbone: export "${exportName}" is not a RegfileDef`);
	}
	if (v.name !== exportName) {
		throw new Error(
			`wishbone: RegfileDef.name "${v.name}" must equal export "${exportName}"`,
		);
	}
	return v;
}

export async function generateDef(
	ws: WorkspaceConfig,
	def: RegfileDef,
	swSheets: Map<string, string> = new Map(),
	excelBySheet: Map<string, LaidRegfile> = new Map(),
	force = false,
): Promise<string[]> {
	const laid = layoutRegfile(def);
	const paths: string[] = [];
	const svDir = join(ws.pluginsDir, PLUGIN_ID);
	await mkdir(svDir, { recursive: true });
	const svPath = join(svDir, `${def.name.toLowerCase()}_regfile.sv`);
	if (await writeIfChanged(svPath, emitRegfileSv(laid), force))
		paths.push(svPath);
	const table = effectiveSheet(def);
	const fp = swLayoutFingerprint(laid);
	const prev = swSheets.get(table);
	if (prev !== undefined) {
		if (prev !== fp) {
			throw new Error(
				`wishbone: sheet "${table}" reused by "${def.name}" with a different field layout`,
			);
		}
		return paths;
	}
	swSheets.set(table, fp);
	excelBySheet.set(table, laid);
	if (ws.wishboneCExport) {
		await mkdir(ws.wishboneCExport, { recursive: true });
		const cPath = join(ws.wishboneCExport, `${table}.h`);
		if (await writeIfChanged(cPath, emitRegfileC(laid), force))
			paths.push(cPath);
	}
	if (ws.wishboneUvmExport) {
		await mkdir(ws.wishboneUvmExport, { recursive: true });
		const uPath = join(ws.wishboneUvmExport, `ral_${table.toUpperCase()}.sv`);
		if (await writeIfChanged(uPath, emitRegfileUvm(laid), force))
			paths.push(uPath);
	}
	return paths;
}
