// happy-dom connect render. Same pipeline as the web page:
// module scripts → before-instances → check → elaborate → before-dump,
// then write the snapshot as .sv. The web session does not call this.

import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Window } from "happy-dom";
import type { LeafDb } from "../rtl/leaf.ts";
import {
	allUnits,
	type ConnectUnit,
	unitDumpDir,
	type WorkspaceConfig,
} from "../workspace.ts";
import {
	beginUnitHooks,
	check,
	clearUnitHooks,
	elaborate,
	endUnitHooks,
	installGlobal,
	runBeforeDump,
	runBeforeInstances,
	serializeSnapshot,
} from "./aw.ts";
import { buildEngineCtx, connectDir, type WrapperFacts } from "./connect.ts";
import { connectXml, parseConnectXml } from "./connectxml.ts";
import {
	assertModuleNames,
	assertPrintable,
	flattenModules,
	type PrintStyle,
	parseSnapshot,
	printSv,
} from "./printer.ts";
import { writeIfChanged } from "./write.ts";

export interface RenderedUnit {
	id: string;
	snapshot: string;
	warnings: string[];
	files: string[];
}

interface ScriptHost extends Window {}

/** Execute author module scripts while this unit owns the hook registry. */
async function runModuleScripts(
	win: ScriptHost,
	unitId: string,
): Promise<void> {
	const scripts = [
		...new Set(win.document.querySelectorAll('script[type="module"]')),
	];
	clearUnitHooks(unitId);
	beginUnitHooks(unitId);
	try {
		for (const script of scripts) {
			const AsyncFunction = Object.getPrototypeOf(async () => {})
				.constructor as new (
				...args: string[]
			) => (...values: unknown[]) => Promise<void>;
			const fn = new AsyncFunction(
				"window",
				"document",
				"aw",
				script.textContent ?? "",
			);
			await fn(win, win.document, (win as unknown as { aw: unknown }).aw);
		}
	} finally {
		endUnitHooks();
	}
}

function sessionFacts(dep: string, snapshot: string): WrapperFacts[] {
	return parseConnectXml(connectXml(dep, parseSnapshot(snapshot))).map((m) => ({
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

/**
 * Load one unit's author HTML into happy-dom and run the author-face
 * mutations: module scripts → before-instances. The returned DOM is what
 * check/elaborate must see (lifecycle §3.1: mutations happen before check).
 * Caller closes win.happyDOM.
 */
export async function loadLiveUnitDoc(
	ws: WorkspaceConfig,
	unit: ConnectUnit,
): Promise<{ win: ScriptHost; doc: Document }> {
	const root = resolve(ws.root);
	const path = resolve(root, unit.html);
	if (!path.startsWith(root))
		throw new Error(`unit "${unit.id}": html path escapes the workspace`);
	const html = await readFile(path, "utf8");
	const win = new Window({ url: "http://127.0.0.1/" }) as ScriptHost;
	installGlobal(win as never);
	win.document.write(html);
	if (!win.document.querySelector("autowire"))
		throw new Error(`unit "${unit.id}": author HTML has no <autowire> root`);
	await runModuleScripts(win, unit.id);
	runBeforeInstances(win.document as never, unit.id);
	return { win, doc: win.document as unknown as Document };
}

/**
 * Render one unit in happy-dom. A dep rendered in this session overrides its
 * on-disk snapshot, matching the web page.
 */
export async function renderUnit(
	ws: WorkspaceConfig,
	unit: ConnectUnit,
	leafDb: LeafDb,
	session: Map<string, RenderedUnit>,
	force = false,
	write = true,
): Promise<RenderedUnit> {
	const { win, doc } = await loadLiveUnitDoc(ws, unit);
	try {
		const built = await buildEngineCtx(ws, unit, allUnits(ws), leafDb);
		const sessionFactsByMod = new Map<string, WrapperFacts>();
		for (const dep of unit.deps) {
			const live = session.get(dep);
			if (!live) continue;
			for (const fact of sessionFacts(dep, live.snapshot))
				sessionFactsByMod.set(fact.name, fact);
		}
		const errors = built.errors.filter(
			(error) => ![...session.keys()].some((id) => error.includes(`"${id}"`)),
		);
		const ctx = {
			...built.ctx,
			wrapper: (mod: string) =>
				sessionFactsByMod.get(mod) ?? built.ctx.wrapper(mod),
		};
		await built.prewarm(doc as never).catch((error: unknown) => {
			if (
				error instanceof Error &&
				"code" in error &&
				(error as NodeJS.ErrnoException).code === "ENOENT"
			)
				return;
			throw error;
		});
		const checked = check(doc as never, ctx);
		const allErrors = [...errors, ...checked.errors];
		if (allErrors.length > 0)
			throw new Error(`render check failed for "${unit.id}": ${allErrors[0]}`);
		const rendered = elaborate(doc as never, ctx);
		if (rendered.errors.length > 0)
			throw new Error(`render failed for "${unit.id}": ${rendered.errors[0]}`);
		runBeforeDump(doc as never, unit.id);
		const snapshot = serializeSnapshot(doc as never);
		const files = write ? await writeSnapshot(ws, unit, snapshot, force) : [];
		return {
			id: unit.id,
			snapshot,
			warnings: [...checked.warnings, ...rendered.warnings],
			files,
		};
	} finally {
		await win.happyDOM.close();
	}
}

/** connect run write: connect XML snapshot, then .sv files. The web session does not call this. */
async function writeSnapshot(
	ws: WorkspaceConfig,
	unit: ConnectUnit,
	snapshot: string,
	force = false,
): Promise<string[]> {
	assertPrintable(snapshot);
	const mods = parseSnapshot(snapshot);
	assertModuleNames(mods);
	if (mods.length === 0)
		throw new Error(`render dump: "${unit.id}" snapshot has no module`);
	if (unit.kind === "connect") {
		await mkdir(connectDir(ws), { recursive: true });
		await writeIfChanged(
			join(connectDir(ws), `${unit.id}.xml`),
			`${connectXml(unit.id, mods)}\n`,
			force,
		);
	}
	// Write each flattened module as <name>.sv (was printer.writeSvFiles;
	// printer.ts is now pure so the page bundle can print too).
	const style: PrintStyle = {
		portAlign: ws.stylePortAlign,
		paramAlign: ws.styleParamAlign,
		instPortAlign: ws.styleInstPortAlign,
		instParamAlign: ws.styleInstParamAlign,
		instPortDir: ws.styleInstPortDir,
		instPortDirFormat: ws.styleInstPortDirFormat,
		instPortWidth: ws.styleInstPortWidth,
		signalAlign: ws.styleSignalAlign,
	};
	const outDir = resolve(ws.root, unitDumpDir(ws, unit.kind));
	await mkdir(outDir, { recursive: true });
	const written: string[] = [];
	for (const m of flattenModules(mods)) {
		const path = join(outDir, `${m.name}.sv`);
		if (await writeIfChanged(path, printSv(m, unit.id, style), force))
			written.push(path);
	}
	return written;
}
