// happy-dom connect render. Same pipeline as the web page:
// classic scripts → static check → elaborate (on-init / on-template) → .sv.
// The web session does not call this. Scripts are classic <script> only.

import { mkdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { Window } from "happy-dom";
import type { LeafDb } from "../rtl/leaf.ts";
import {
	allUnits,
	type ConnectUnit,
	unitDumpDir,
	type WorkspaceConfig,
} from "../workspace.ts";
import { check, elaborate, installGlobal, serializeSnapshot } from "./aw.ts";
import { buildEngineCtx, connectDir, type WrapperFacts } from "./connect.ts";
import { connectXml } from "./connectxml.ts";
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

/** Document URL for one author HTML file, rooted at the workspace.
 *  Relative module src/import resolve against this URL. */
function authorModuleUrl(root: string, file: string): string {
	const parts = relative(root, file)
		.split(sep)
		.filter((seg) => seg.length > 0 && seg !== ".")
		.map((seg) => encodeURIComponent(seg));
	return `http://127.0.0.1/${parts.join("/")}`;
}

function isClassicScript(script: {
	getAttribute(name: string): string | null;
}): boolean {
	const type = (script.getAttribute("type") ?? "").trim().toLowerCase();
	return (
		type === "" ||
		type === "text/javascript" ||
		type === "application/javascript"
	);
}

/** Run classic <script> elements in document order.
 *  happy-dom does not put a classic `function name` onto `window` when the
 *  script is inserted as an element, and an inline script never fires load.
 *  Evaluating the source does both: declarations become window properties,
 *  and a relative src is fetched from the workspace virtual server. */
async function runClassicScripts(win: ScriptHost): Promise<void> {
	const scripts = [...win.document.querySelectorAll("script")];
	for (const script of scripts) script.remove();
	const modules = scripts.filter(
		(s) => (s.getAttribute("type") ?? "").trim().toLowerCase() === "module",
	);
	if (modules.length > 0)
		throw new Error(
			'author script must be a classic <script> (type="module" is not allowed)',
		);
	const classic = scripts.filter(isClassicScript);
	if (classic.length === 0) return;
	win.happyDOM.settings.enableJavaScriptEvaluation = true;
	for (const script of classic) {
		const src = script.getAttribute("src");
		const inline = script.textContent ?? "";
		if (!src && !inline.trim()) continue;
		let code = inline;
		if (src) {
			const url = new URL(src, win.location.href).href;
			const res = await win.fetch(url);
			if (!res.ok) throw new Error(`script failed to load ${src}`);
			code = await res.text();
		}
		win.eval(code);
	}
}

/** Live-dep facts straight from the parsed snapshot; mirrors the
 *  connectXml→parseConnectXml roundtrip (flatten+sort, dir default "input",
 *  empty dims → null, import symbol default "*") without the XML detour. */
function sessionFacts(snapshot: string): WrapperFacts[] {
	return flattenModules(parseSnapshot(snapshot))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((m) => ({
			name: m.name,
			params: m.params.map((p) => ({ name: p.name, value: p.value })),
			ports: m.ports.map((p) => ({
				name: p.name,
				dir: p.dir || "input",
				packed: p.packed || null,
				unpacked: p.unpacked || null,
				nettype: p.nettype || null,
			})),
			imports: m.imports.map((i) => ({
				package: i.package,
				symbol: i.symbol || "*",
			})),
		}));
}

/**
 * Load one unit's author HTML into happy-dom. `scripts` runs classic
 * <script> elements so window functions exist for elaborate. check passes
 * false: it does not execute scripts. Caller closes win.happyDOM.
 */
export async function loadLiveUnitDoc(
	ws: WorkspaceConfig,
	unit: ConnectUnit,
	opts: { scripts?: boolean } = {},
): Promise<{ win: ScriptHost; doc: Document }> {
	const root = resolve(ws.root);
	const path = resolve(root, unit.html);
	if (!path.startsWith(root))
		throw new Error(`unit "${unit.id}": html path escapes the workspace`);
	const html = await readFile(path, "utf8");
	const win = new Window({
		url: authorModuleUrl(root, path),
		settings: {
			enableJavaScriptEvaluation: false,
			suppressInsecureJavaScriptEnvironmentWarning: true,
			fetch: {
				virtualServers: [{ url: "http://127.0.0.1", directory: root }],
			},
		},
	}) as ScriptHost;
	installGlobal(win as never);
	win.document.write(html);
	if (!win.document.querySelector("autowire"))
		throw new Error(`unit "${unit.id}": author HTML has no <autowire> root`);
	if (opts.scripts !== false) await runClassicScripts(win);
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
	/** Pre-computed unitModNames for the whole workspace (loop callers pass
	 *  one shared map instead of re-parsing every unit's HTML per unit). */
	unitMods?: Map<string, string>,
): Promise<RenderedUnit> {
	const { win, doc } = await loadLiveUnitDoc(ws, unit);
	try {
		const built = await buildEngineCtx(
			ws,
			unit,
			allUnits(ws),
			leafDb,
			unitMods,
		);
		const sessionFactsByMod = new Map<string, WrapperFacts>();
		for (const dep of unit.deps) {
			const live = session.get(dep);
			if (!live) continue;
			for (const fact of sessionFacts(live.snapshot))
				sessionFactsByMod.set(fact.name, fact);
		}
		const sessionIds = [...session.keys()];
		const errors = built.errors.filter(
			(error) => !sessionIds.some((id) => error.includes(`"${id}"`)),
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
