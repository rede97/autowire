// autowire web page controller (docs/workspace/web-ui.md). Runs in the browser only.
// Buttons and GET params share the same action chain: select → check → elaborate → run.
// Check has no prerequisite. Elaborate depends on a clean check. Run implies both.
// Nothing here writes the workspace. Save SV downloads the printed .sv text;
// Save HTML downloads the processed author face with aw-render stripped.
// #aw-source + #aw-hooks are the input workspace (CDP-editable). #aw-live is
// the pipeline output, replaced on each compile — hooks do not write back.

// The engine is served as a bundle at /aw.js (runtime URL); tsc cannot resolve
// rooted specifiers, so we import it untyped and re-type it from the source.
// @ts-expect-error runtime bundle URL
import * as AWruntime from "/aw.js";
import type * as AwEngine from "../core/aw.ts";
import {
	flattenModules,
	type PrintStyle,
	parseSnapshot,
	printSv,
} from "../core/printer.ts";

const AW = AWruntime as typeof AwEngine;

type Status = "idle" | "running" | "done" | "error";

interface UnitMeta {
	id: string;
	html: string;
	deps: string[];
	kind?: "connect" | "sim";
}

interface UnitEntry {
	/** Input workspace. Pipeline steps clone this; they never write it back. */
	source: HTMLElement;
	/** `<script type="aw/hook">` elements. Edited in place; re-read on compile. */
	hooks: HTMLElement;
	/** Processed workspace (clone after scripts / before-instances / elaborate). */
	doc: HTMLElement;
	container: HTMLElement;
	rendered: boolean;
	hooksRan?: boolean;
}

interface WrapperFacts {
	name: string | null;
	params: { name: string | null; value: string | null }[];
	ports: {
		name: string | null;
		dir: string;
		packed: string | null;
		unpacked: string | null;
	}[];
	imports: { package: string | null; symbol: string }[];
}

interface ChainActions {
	select?: string | null;
	check?: boolean;
	elaborate?: boolean;
	run?: boolean;
}

/** window extension: script-settle sentinel queue (loadUnit). */
const win = window as unknown as { __awScriptDone?: (() => void)[] };

AW.installGlobal(window);

const $ = <T extends Element = HTMLElement>(sel: string): T => {
	const el = document.querySelector<T>(sel);
	if (!el) throw new Error(`page shell missing ${sel}`);
	return el;
};
const statusEl = $("#aw-status");

const state: {
	workspace: string;
	style: { paramInline?: boolean } & PrintStyle;
	units: UnitMeta[]; // topo order: deps first
	unitMods: Map<string, string>; // mod name → unit id (top-level aw-mod of each unit)
	current: string | null; // current unit id
	docs: Map<string, UnitEntry>;
	leafCache: Map<string, AwEngine.ModFacts | null>;
	/** Last successful session step for the current unit. `run` is not stored. */
	phase: Map<
		string,
		"before-instances" | "check" | "elaborate" | "before-dump"
	>;
	/** Input edits since the last compile of that unit. */
	dirty: Set<string>;
	svText: string;
	htmlText: string;
} = {
	workspace: "",
	style: { paramInline: true },
	units: [],
	unitMods: new Map(),
	current: null,
	docs: new Map(),
	leafCache: new Map(),
	phase: new Map(),
	dirty: new Set(),
	svText: "",
	htmlText: "",
};

function showGenerated(text: string): void {
	const box = $("#aw-generated");
	box.hidden = false;
	box.textContent = text;
}

const minimal = document.documentElement.dataset.ui === "min";

/** Ignore input-workspace mutations caused by compile itself. */
let obsMute = 0;
function holdObs(): void {
	obsMute++;
}
function releaseObs(): void {
	queueMicrotask(() => {
		obsMute = Math.max(0, obsMute - 1);
	});
}

function watchInputs(): void {
	const obs = new MutationObserver((recs) => {
		if (obsMute > 0) return;
		for (const rec of recs) {
			const node =
				rec.target.nodeType === Node.ELEMENT_NODE
					? (rec.target as Element)
					: rec.target.parentElement;
			const unit = node?.closest("[data-unit]")?.getAttribute("data-unit");
			if (unit) state.dirty.add(unit);
		}
	});
	const opts: MutationObserverInit = {
		subtree: true,
		childList: true,
		attributes: true,
		characterData: true,
	};
	obs.observe($("#aw-source"), opts);
	obs.observe($("#aw-hooks"), opts);
}

function setAuthorTab(which: "source" | "processed"): void {
	const src = document.querySelector<HTMLElement>("#author-source");
	const proc = document.querySelector<HTMLElement>("#author-processed");
	if (!src || !proc) return;
	src.hidden = which !== "source";
	proc.hidden = which !== "processed";
	document
		.querySelector("#atab-source")
		?.setAttribute("aria-selected", String(which === "source"));
	document
		.querySelector("#atab-proc")
		?.setAttribute("aria-selected", String(which === "processed"));
}

function setSideTab(which: "rtl" | "connect"): void {
	const rtl = document.querySelector<HTMLElement>("#pane-rtlindex");
	const connect = document.querySelector<HTMLElement>("#pane-connect");
	if (!rtl || !connect) return;
	rtl.hidden = which !== "rtl";
	connect.hidden = which !== "connect";
	document
		.querySelector("#tab-rtl")
		?.setAttribute("aria-selected", String(which === "rtl"));
	document
		.querySelector("#tab-connect")
		?.setAttribute("aria-selected", String(which === "connect"));
}

function showUnitWorkspace(): void {
	const unit = document.querySelector<HTMLElement>("#unit-view");
	const mod = document.querySelector<HTMLElement>("#module-view");
	if (!unit || !mod) return;
	unit.hidden = false;
	mod.hidden = true;
}

function showModuleWorkspace(): void {
	const unit = document.querySelector<HTMLElement>("#unit-view");
	const mod = document.querySelector<HTMLElement>("#module-view");
	if (!unit || !mod) return;
	unit.hidden = true;
	mod.hidden = false;
}

const SV_DIRS = new Set(["input", "output", "inout"]);
const SV_KW = new Set([
	"module",
	"endmodule",
	"logic",
	"wire",
	"reg",
	"assign",
	"parameter",
	"localparam",
	"interface",
	"modport",
	"import",
	"package",
	"endpackage",
	"generate",
	"endgenerate",
	"begin",
	"end",
	"if",
	"else",
	"for",
	"always",
	"always_ff",
	"always_comb",
	"always_latch",
	"posedge",
	"negedge",
	"or",
]);

function paintTokens(
	text: string,
	host: HTMLElement,
	re: RegExp,
	cls: (tok: string) => string,
): void {
	host.replaceChildren();
	let last = 0;
	for (const m of text.matchAll(re)) {
		const i = m.index ?? 0;
		if (i > last)
			host.appendChild(document.createTextNode(text.slice(last, i)));
		const tok = m[0];
		const span = document.createElement("span");
		const name = cls(tok);
		if (name) span.className = name;
		span.textContent = tok;
		host.appendChild(span);
		last = i + tok.length;
	}
	if (last < text.length)
		host.appendChild(document.createTextNode(text.slice(last)));
}

function highlightSv(text: string, host: HTMLElement): void {
	paintTokens(
		text,
		host,
		/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b\d+'[bodhBODH][0-9a-fA-FxXzZ_]+|\b\d+\b|\b[A-Za-z_][A-Za-z0-9_$]*\b/g,
		(tok) => {
			if (tok.startsWith("//") || tok.startsWith("/*")) return "sv-cmt";
			if (tok.startsWith('"') || tok.startsWith("'")) return "sv-str";
			if (SV_DIRS.has(tok)) return "sv-dir";
			if (SV_KW.has(tok)) return "sv-kw";
			if (/^\d/.test(tok)) return "sv-num";
			return "";
		},
	);
}

function highlightXml(text: string, host: HTMLElement): void {
	paintTokens(
		text,
		host,
		/<!--[\s\S]*?-->|<\/?[A-Za-z][\w:-]*|\/?>|[A-Za-z_:][\w:.-]*="[^"]*"/g,
		(tok) => {
			if (tok.startsWith("<!--")) return "xml-cmt";
			if (tok.includes("=")) return "xml-attr";
			return "xml-tag";
		},
	);
}

function paintResult(): void {
	const gen = $("#aw-generated");
	gen.hidden = false;
	const tabs = document.querySelector("#result-tabs");
	if (!tabs) {
		gen.textContent = state.svText || state.htmlText;
		return;
	}
	const sv =
		document.querySelector("#rtab-sv")?.getAttribute("aria-selected") !==
		"false";
	if (sv && state.svText) highlightSv(state.svText, gen);
	else if (!sv) highlightXml(state.htmlText, gen);
	else gen.textContent = state.htmlText;
}

function setResultTab(which: "sv" | "html"): void {
	document
		.querySelector("#rtab-sv")
		?.setAttribute("aria-selected", String(which === "sv"));
	document
		.querySelector("#rtab-html")
		?.setAttribute("aria-selected", String(which === "html"));
	paintResult();
}

function namesInErrors(errors: string[]): string[] {
	const out = new Set<string>();
	for (const e of errors) {
		for (const m of e.matchAll(/"([^"]+)"/g)) {
			const n = m[1] ?? "";
			if (n.length >= 2 && !/^\d+$/.test(n)) out.add(n);
		}
	}
	return [...out];
}

function markProcessed(names: string[]): void {
	const root = document.querySelector("#aw-live");
	if (!root) return;
	for (const el of root.querySelectorAll(".tn-err"))
		el.classList.remove("tn-err");
	if (names.length === 0) return;
	const want = new Set(names);
	const keys = ["name", "id", "port", "mod", "to", "match"];
	for (const el of root.querySelectorAll("*")) {
		if (keys.some((k) => want.has(el.getAttribute(k) ?? "")))
			el.classList.add("tn-err");
	}
}

function snapshotOf(id: string): string {
	const entry = state.docs.get(id);
	if (!entry?.doc) return "";
	return AW.serializeSnapshot(entry.doc as unknown as Document);
}

function showErrors(errors: string[]): void {
	const list = document.querySelector<HTMLElement>("#error-list");
	if (list) {
		list.hidden = false;
		list.textContent = errors.join("\n");
	}
	document.querySelector("#result-tabs")?.setAttribute("hidden", "");
	$("#aw-generated").hidden = true;
	markProcessed(namesInErrors(errors));
	setAuthorTab("processed");
}

function showResult(sv: string | null, html: string | null): void {
	if (sv !== null) state.svText = sv;
	if (html !== null) state.htmlText = html;
	const list = document.querySelector<HTMLElement>("#error-list");
	if (list) {
		list.hidden = true;
		list.textContent = "";
	}
	markProcessed([]);
	const tabs = document.querySelector("#result-tabs");
	if (tabs) {
		tabs.removeAttribute("hidden");
		const which = state.svText ? "sv" : "html";
		setResultTab(which);
		return;
	}
	const gen = $("#aw-generated");
	gen.hidden = false;
	gen.textContent = state.svText || state.htmlText;
}

/** Browser download. Does not write the workspace. */
function downloadText(text: string, filename: string): void {
	const blob = new Blob([text], { type: "text/plain" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

/** Save SV: download the printed .sv text shown after Run. No render XML. */
function saveSv(): string {
	const text = state.svText;
	if (!text) {
		setStatus("error", "save: run first; nothing generated");
		throw new Error("save: run first; nothing generated");
	}
	downloadText(text, `${state.current ?? "autowire"}.sv`);
	setStatus("done", "save: browser download (.sv)");
	return text;
}

/** Save HTML: the unit's live <autowire> author face with aw-render stripped
 *  (render is engine-owned and regenerable). For agent-edited author faces.
 *  Scripts are not part of the unit DOM tree; edit the author file for those. */
function saveHtml(): string {
	const id = state.current;
	if (!id) throw new Error("no unit selected");
	const entry = state.docs.get(id);
	if (!entry) throw new Error(`save-html: unit "${id}" not loaded`);
	const clone = entry.container.cloneNode(true) as HTMLElement;
	for (const r of clone.querySelectorAll("aw-render")) r.textContent = "";
	const face = clone.querySelector(":scope > autowire");
	const text = `<!-- live author face of unit "${id}"; aw-render stripped; <script> lives in the author file -->\n${face?.outerHTML ?? clone.innerHTML}\n`;
	downloadText(text, `${id}.html`);
	setStatus("done", "save-html: browser download (author face, no aw-render)");
	return text;
}

const SESSION_HELP = [
	"before-instances: compile #aw-source + #aw-hooks into #aw-live (does not write the input back)",
	"check: rule report; requires before-instances in this session",
	"elaborate: freeze aw-render; requires a clean check in this session",
	"before-dump: read-only hook; requires elaborate in this session",
	"run: the whole chain; same result as connect run, no file write; shows .sv",
	"save / save-sv: download the printed .sv text (browser download)",
	"save-html: download the live author HTML with aw-render stripped",
	"none of these steps write a file",
].join("\n");

async function sessionStep(step: string): Promise<string> {
	const id = state.current;
	if (!id) throw new Error("no unit selected");
	const phase = state.phase.get(id) ?? "none";
	if (step === "help") return SESSION_HELP;
	if (step === "before-instances") {
		const entry = await loadUnit(id);
		await compileUnit(entry, id, true);
		state.phase.set(id, "before-instances");
		setAuthorTab("processed");
		showGenerated($("#aw-live").textContent ?? "");
		return "before-instances";
	}
	if (step === "check") {
		if (phase === "none")
			throw new Error('session: run "before-instances" before "check"');
		const res = await runCheck(id);
		const text = [...res.errors, ...res.warnings].join("\n") || "check ok";
		if (res.errors.length === 0) {
			state.phase.set(id, "check");
			showResult("", snapshotOf(id));
			setAuthorTab("processed");
		} else showErrors(res.errors);
		return text;
	}
	if (step === "elaborate") {
		if (state.dirty.has(id))
			throw new Error(
				'session: input workspace changed; run "before-instances" and "check" again',
			);
		if (phase !== "check" && phase !== "elaborate" && phase !== "before-dump")
			throw new Error('session: "elaborate" requires a clean check');
		const res = await runRender(id);
		if (res.errors.length > 0) throw new Error(res.errors[0]);
		state.phase.set(id, "elaborate");
		showResult("", snapshotOf(id));
		setAuthorTab("processed");
		return "elaborate";
	}
	if (step === "before-dump") {
		if (state.dirty.has(id))
			throw new Error(
				'session: input workspace changed; run "before-instances" and "check" again',
			);
		if (phase !== "elaborate" && phase !== "before-dump")
			throw new Error('session: "before-dump" requires elaborate');
		const res = await runBeforeDumpOnly(id);
		state.phase.set(id, "before-dump");
		return res.files.join("\n");
	}
	if (step === "run") {
		const res = await runView(id);
		state.phase.set(id, "before-dump");
		return res.sv;
	}
	if (step === "save" || step === "save-sv") {
		return saveSv();
	}
	if (step === "save-html") {
		return saveHtml();
	}
	throw new Error(`unknown session step "${step}"`);
}

const pageAw = window as unknown as {
	aw?: { session?: (step: string) => Promise<string> };
};
if (pageAw.aw) pageAw.aw.session = sessionStep;

function setStatus(state_: Status, text: string): void {
	statusEl.dataset.state = state_;
	statusEl.textContent = text;
	const base = document.title.replace(/ \[(done|error)\]$/, "");
	if (state_ === "done" || state_ === "error")
		document.title = `${base} [${state_}]`;
	else document.title = base;
}

const unitOf = (id: string): UnitMeta | undefined =>
	state.units.find((u) => u.id === id);

interface UnitsMeta {
	workspace: string;
	style?: { paramInline?: boolean; localparamUpper?: boolean } & PrintStyle;
	units: UnitMeta[];
	defaultUnit: string | null;
}

interface RtlIndexSummary {
	tool: string;
	files: number;
	modules: number;
	errorFiles: string[];
	definesFp: string;
}

interface ModulesPayload {
	modules: { name: string; source: string; kind: string }[];
	packages: { name: string; source: string; kind: string }[];
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
	const res = await fetch(url, options);
	const data = (await res.json()) as T & { error?: string };
	if (!res.ok) throw new Error(data.error ?? `${res.status} ${url}`);
	return data;
}

// ---------------------------------------------------------------------------
// Unit loading: author HTML → live DOM; module scripts execute under a
// per-unit hook registry (aw.js beginUnitHooks/endUnitHooks).
// ---------------------------------------------------------------------------

async function execHookScripts(id: string, hooks: HTMLElement): Promise<void> {
	AW.beginUnitHooks(id);
	try {
		for (const h of hooks.querySelectorAll('script[type="aw/hook"]')) {
			const inline = h.textContent ?? "";
			const srcAttr = h.getAttribute("src");
			if (!inline.trim() && !srcAttr) continue;
			const el = document.createElement("script");
			el.type = "module";
			el.dataset.awInjected = id;
			let src = srcAttr ? new URL(srcAttr, location.href).href : "";
			if (inline.trim()) {
				// Obscura rejects data:/blob: module URLs. Serve the text from
				// an ephemeral loopback URL (not a workspace file).
				const posted = await fetch("/api/hook-script", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						text: `${inline}\n;window.__awScriptDone?.shift()?.();`,
					}),
				});
				if (!posted.ok) {
					const err = (await posted.json()) as { error?: string };
					throw new Error(err.error ?? "hook script upload failed");
				}
				const meta = (await posted.json()) as { url: string };
				src = new URL(meta.url, location.href).href;
			}
			const sentinel = new Promise<void>((res) => {
				const q = win.__awScriptDone ?? [];
				win.__awScriptDone = q;
				q.push(res);
			});
			const loaded = new Promise<void>((res, rej) => {
				el.addEventListener("load", () => res());
				el.addEventListener("error", () =>
					rej(new Error(`hook script failed to load ${src}`)),
				);
			});
			el.src = src;
			document.body.appendChild(el);
			// One script at a time so aw.on registration stays in source order.
			await Promise.race([sentinel, loaded]);
		}
	} finally {
		AW.endUnitHooks();
		for (const el of document.querySelectorAll(
			`script[data-aw-injected="${id}"]`,
		))
			el.remove();
	}
}

/** Clone the input workspace into #aw-live and run scripts there.
 *  `runHooks` also runs before-instances. Source is detached while scripts
 *  run so they cannot write the input tree. */
async function compileUnit(
	entry: UnitEntry,
	id: string,
	runHooks: boolean,
): Promise<void> {
	holdObs();
	// Hide every input tree while scripts run. Otherwise a hook's
	// document.querySelector("aw-mod") can write the source workspace.
	const sourceRoot = $("#aw-source");
	const sourceParent = sourceRoot.parentElement;
	const sourceNext = sourceRoot.nextSibling;
	sourceRoot.remove();
	try {
		if (entry.doc !== entry.source) entry.doc.remove();
		AW.clearUnitHooks(id);
		const container = document.createElement("div");
		container.dataset.unit = id;
		const root = entry.source.querySelector(":scope > autowire");
		if (!root)
			throw new Error(`unit "${id}": source workspace has no <autowire>`);
		container.appendChild(root.cloneNode(true));
		$("#aw-live").appendChild(container);
		entry.doc = container;
		entry.container = container;
		entry.rendered = false;
		entry.hooksRan = false;
		await execHookScripts(id, entry.hooks);
		if (runHooks) {
			AW.runBeforeInstances(container as unknown as Document, id);
			entry.hooksRan = true;
		}
		state.dirty.delete(id);
	} finally {
		sourceParent?.insertBefore(sourceRoot, sourceNext);
		releaseObs();
	}
}

async function loadUnit(id: string): Promise<UnitEntry> {
	const cached = state.docs.get(id);
	if (cached) return cached;
	holdObs();
	try {
		const res = await fetch(`/api/author?id=${encodeURIComponent(id)}`);
		if (!res.ok)
			throw new Error(((await res.json()) as { error: string }).error);
		const html = await res.text();
		const parsed = new DOMParser().parseFromString(html, "text/html");
		const root = parsed.querySelector("autowire");
		if (!root)
			throw new Error(`unit "${id}": author HTML has no <autowire> root`);
		const source = document.createElement("div");
		source.dataset.unit = id;
		source.appendChild(document.importNode(root, true));
		$("#aw-source").appendChild(source);
		const hooks = document.createElement("div");
		hooks.dataset.unit = id;
		for (const s of parsed.querySelectorAll('script[type="module"]')) {
			const el = document.createElement("script");
			el.type = "aw/hook";
			const src = s.getAttribute("src");
			if (src) el.setAttribute("src", src);
			el.textContent = s.textContent ?? "";
			hooks.appendChild(el);
		}
		$("#aw-hooks").appendChild(hooks);
		const entry: UnitEntry = {
			source,
			hooks,
			doc: document.createElement("div"),
			container: source,
			rendered: false,
		};
		state.docs.set(id, entry);
		await compileUnit(entry, id, false);
		return entry;
	} finally {
		releaseObs();
	}
}

/** Wrapper facts of a dep unit: prefer this session's elaborated doc, else the
 *  abstract XML snapshot (.autowire/connect/<id>.xml via /api/connect). */
async function depWrappers(
	depId: string,
): Promise<{ facts: WrapperFacts[]; missing?: string }> {
	const session = state.docs.get(depId);
	if (session?.rendered) return { facts: renderFactsOf(session.container) };
	const res = await fetch(`/api/connect?id=${encodeURIComponent(depId)}`);
	if (res.status === 404) return { missing: depId, facts: [] };
	if (!res.ok) throw new Error(((await res.json()) as { error: string }).error);
	const xml = await res.text();
	const parsed = new DOMParser().parseFromString(xml, "text/xml");
	return { facts: xmlFactsOf(parsed) };
}

/** Abstract module facts from a <connectUnit> XML snapshot. */
function xmlFactsOf(doc: Document): WrapperFacts[] {
	const facts: WrapperFacts[] = [];
	for (const mod of doc.querySelectorAll("connectUnit > module")) {
		const ports: WrapperFacts["ports"] = [];
		for (const p of mod.querySelectorAll(":scope > ports > port")) {
			const dir = p.getAttribute("dir") ?? "input";
			ports.push({
				name: p.getAttribute("name"),
				dir,
				packed: p.getAttribute("packed"),
				unpacked: p.getAttribute("unpacked"),
			});
		}
		const params: WrapperFacts["params"] = [];
		for (const pr of mod.querySelectorAll(":scope > params > param")) {
			params.push({
				name: pr.getAttribute("name"),
				value: pr.getAttribute("value"),
			});
		}
		const imports: WrapperFacts["imports"] = [];
		for (const im of mod.querySelectorAll(":scope > imports > import")) {
			imports.push({
				package: im.getAttribute("package"),
				symbol: im.getAttribute("symbol") ?? "*",
			});
		}
		facts.push({ name: mod.getAttribute("name"), params, ports, imports });
	}
	return facts;
}

function renderFactsOf(rootEl: ParentNode): WrapperFacts[] {
	const facts: WrapperFacts[] = [];
	for (const mod of rootEl.querySelectorAll("autowire > aw-mod")) {
		const ports: WrapperFacts["ports"] = [];
		for (const p of mod.querySelectorAll(
			":scope > aw-render > aw-ports > aw-port",
		)) {
			ports.push({
				name: p.getAttribute("name"),
				dir: p.getAttribute("dir") ?? "input",
				packed: p.getAttribute("packed"),
				unpacked: p.getAttribute("unpacked"),
			});
		}
		const params: WrapperFacts["params"] = [];
		for (const pr of mod.querySelectorAll(
			":scope > aw-render > aw-params > aw-param",
		)) {
			params.push({
				name: pr.getAttribute("name"),
				value: pr.getAttribute("value"),
			});
		}
		const imports: WrapperFacts["imports"] = [];
		for (const im of mod.querySelectorAll(
			":scope > aw-render > aw-imports > aw-import",
		)) {
			imports.push({
				package: im.getAttribute("package"),
				symbol: im.getAttribute("symbol") ?? "*",
			});
		}
		facts.push({ name: mod.getAttribute("name"), params, ports, imports });
	}
	return facts;
}

/** Engine ctx for a unit: pre-fetched leaf tables + dep wrappers + unit mods. */
async function buildCtx(
	id: string,
): Promise<{ errors: string[]; ctx: AwEngine.EngineCtx }> {
	const unit = unitOf(id);
	if (!unit) throw new Error(`unknown unit "${id}"`);
	const { doc } = await loadUnit(id);
	const wrappers = new Map<string, WrapperFacts>();
	const missing: string[] = [];
	for (const dep of unit.deps) {
		const r = await depWrappers(dep);
		if (r.missing) missing.push(r.missing);
		for (const f of r.facts ?? []) wrappers.set(f.name ?? "", f);
	}
	// Pre-fetch leaf facts for every instantiated target that is not a wrapper.
	const wanted = new Set<string>();
	for (const inst of doc.querySelectorAll("aw-inst")) {
		const mod = inst.getAttribute("mod") ?? "";
		if (mod && !wrappers.has(mod) && state.unitMods.get(mod) !== id)
			wanted.add(mod);
	}
	for (const mod of wanted) {
		if (!state.leafCache.has(mod)) {
			const res = await fetch(`/api/module?name=${encodeURIComponent(mod)}`);
			state.leafCache.set(mod, res.ok ? await res.json() : null);
		}
	}
	const errors = missing.map(
		(d) =>
			`unit "${id}" deps: snapshot for "${d}" missing (connect run "${d}" first, or Run the parent so this session elaborates it)`,
	);
	return {
		errors,
		ctx: {
			style: state.style,
			unitId: id,
			unitKind: unit.kind ?? "connect",
			unitDeps: unit.deps,
			unitMods: state.unitMods,
			leaf: (m: string) => state.leafCache.get(m) ?? null,
			wrapper: (m: string) =>
				(wrappers.get(m) ?? null) as AwEngine.ModFacts | null,
		},
	};
}

// ---------------------------------------------------------------------------
// Actions (shared by buttons and GET params).
// ---------------------------------------------------------------------------

/** Compile source → processed when hooks have not run, or the input changed.
 *  before-instances writes only the processed clone. */
async function ensureAuthorMutations(
	entry: UnitEntry,
	id: string,
): Promise<void> {
	if (entry.hooksRan && !state.dirty.has(id)) return;
	await compileUnit(entry, id, true);
	setAuthorTab("processed");
}

async function runCheck(id: string): Promise<AwEngine.CheckResult> {
	const entry = await loadUnit(id);
	// lifecycle §3.1: author-face mutators before check (hook-generated insts visible).
	await ensureAuthorMutations(entry, id);
	const { errors: ctxErrors, ctx } = await buildCtx(id);
	const res = AW.check(entry.doc as unknown as Document, ctx);
	return { errors: [...ctxErrors, ...res.errors], warnings: res.warnings };
}

async function runRender(id: string): Promise<AwEngine.CheckResult> {
	const entry = await loadUnit(id);
	await ensureAuthorMutations(entry, id);
	const { errors: ctxErrors, ctx } = await buildCtx(id);
	if (ctxErrors.length > 0) return { errors: ctxErrors, warnings: [] };
	const res = AW.elaborate(entry.doc as unknown as Document, ctx);
	if (res.errors.length === 0) entry.rendered = true;
	return res;
}

async function runView(id: string): Promise<{ files: string[]; sv: string }> {
	if (!unitOf(id)) throw new Error(`unknown unit "${id}"`);
	const chain: string[] = [];
	const visit = (uid: string): void => {
		if (chain.includes(uid)) return;
		for (const d of unitOf(uid)?.deps ?? []) visit(d);
		chain.push(uid);
	};
	visit(id);
	const files: { uid: string; text: string }[] = [];
	for (const uid of chain) {
		const checkRes = await runCheck(uid);
		if (checkRes.errors.length > 0) {
			throw new Error(`check failed for "${uid}": ${checkRes.errors[0]}`);
		}
		const renderRes = await runRender(uid);
		if (renderRes.errors.length > 0) {
			throw new Error(`render failed for "${uid}": ${renderRes.errors[0]}`);
		}
		const entry = state.docs.get(uid);
		if (!entry) throw new Error(`unit "${uid}" not loaded`);
		AW.runBeforeDump(entry.doc as unknown as Document, uid);
		files.push({
			uid,
			text: AW.serializeSnapshot(entry.doc as unknown as Document),
		});
	}
	// Show and return the same .sv text connect run writes (page rule:
	// display == written text). Snapshots stay visible in #aw-live.
	const chunks: string[] = [];
	for (const { uid, text } of files) {
		for (const m of flattenModules(parseSnapshot(text))) {
			chunks.push(
				`// --- ${uid}/${m.name}.sv ---\n${printSv(m, uid, state.style)}`,
			);
		}
	}
	const sv = chunks.join("\n");
	showResult(sv, files.map((f) => f.text).join("\n"));
	setAuthorTab("processed");
	return { files: files.map((f) => f.text), sv };
}

/** Read-only before-dump on a unit this session already elaborated. */
async function runBeforeDumpOnly(id: string): Promise<{ files: string[] }> {
	const entry = state.docs.get(id);
	if (!entry?.rendered) throw new Error(`session: "${id}" is not elaborated`);
	AW.runBeforeDump(entry.doc as unknown as Document, id);
	const text = AW.serializeSnapshot(entry.doc as unknown as Document);
	showGenerated(text);
	return { files: [text] };
}

/** One action chain: select → check → elaborate → run (docs/workspace/web-ui.md §3). */
async function runChain({
	select,
	check,
	elaborate,
	run,
}: ChainActions): Promise<void> {
	setStatus("running", "running…");
	try {
		if (select) await selectModule(select);
		const id = state.current;
		if (!id) throw new Error("no unit selected");
		const summary: string[] = [];
		if (run) {
			const res = await runView(id);
			summary.push(
				`check: ok; elaborate: ok; source: ${res.files.length} unit(s) as .sv in view`,
			);
		} else {
			if (check || elaborate) {
				const res = await runCheck(id);
				summary.push(
					res.errors.length > 0
						? `check: ${res.errors.length} error(s)`
						: `check: ok${res.warnings.length > 0 ? ` (${res.warnings.length} warning(s))` : ""}`,
				);
				if (res.errors.length > 0) {
					showErrors(res.errors);
					throw new Error(res.errors[0]);
				}
				showResult("", snapshotOf(id));
				setAuthorTab("processed");
				if (res.warnings.length > 0)
					console.warn("[autowire check warnings]", res.warnings);
			}
			if (elaborate) {
				const res = await runRender(id);
				if (res.errors.length > 0) {
					showErrors(res.errors);
					throw new Error(res.errors[0]);
				}
				summary.push("elaborate: ok");
				showResult("", snapshotOf(id));
				setAuthorTab("processed");
				refreshRightIfRendered();
			}
		}
		setStatus("done", summary.join("; ") || "done");
	} catch (e) {
		setStatus("error", (e as Error).message);
	}
}

// ---------------------------------------------------------------------------
// Panels.
// ---------------------------------------------------------------------------

async function buildSummary(): Promise<void> {
	const db = document.querySelector("#db-summary");
	if (!db) return;
	try {
		const idx = await fetchJson<RtlIndexSummary>("/api/rtlindex");
		db.innerHTML = "";
		const rows: [string, unknown][] = [
			["tool", idx.tool],
			["files", idx.files],
			["modules", idx.modules],
			["errorFiles", idx.errorFiles.length],
			["definesFp", `${idx.definesFp.slice(0, 12)}…`],
		];
		const table = document.createElement("table");
		for (const [k, v] of rows) {
			const tr = document.createElement("tr");
			const th = document.createElement("th");
			th.textContent = k;
			const td = document.createElement("td");
			td.textContent = String(v);
			tr.append(th, td);
			table.appendChild(tr);
		}
		db.appendChild(table);
	} catch (e) {
		db.textContent = (e as Error).message;
	}
}

async function buildRtlList(): Promise<void> {
	const list = document.querySelector("#rtl-list");
	if (!list) return;
	let rows: { name: string; kind: string }[] = [];
	try {
		const data = await fetchJson<ModulesPayload>("/api/modules");
		rows = [
			...data.modules.map((m) => ({ name: m.name, kind: "module" })),
			...data.packages.map((m) => ({ name: m.name, kind: "package" })),
		];
	} catch (e) {
		list.textContent = (e as Error).message;
		return;
	}
	const paint = (q: string) => {
		list.replaceChildren();
		const needle = q.trim().toLowerCase();
		for (const row of rows) {
			if (needle && !row.name.toLowerCase().includes(needle)) continue;
			const div = document.createElement("div");
			div.textContent = row.name;
			div.dataset.mod = row.name;
			if (row.kind === "package") div.className = "pkg";
			div.addEventListener("click", () => {
				void selectModule(row.name);
			});
			list.appendChild(div);
		}
	};
	paint("");
	document.querySelector("#rtl-search")?.addEventListener("input", (e) => {
		paint((e.target as HTMLInputElement).value);
	});
}

function buildUnitList(): void {
	const list = document.querySelector("#unit-list");
	if (!list) return;
	list.replaceChildren();
	for (const u of state.units) {
		const a = document.createElement("a");
		a.href = `/?unit=${encodeURIComponent(u.id)}`;
		a.textContent = u.id;
		if (u.id === state.current) a.setAttribute("aria-current", "true");
		const kind = document.createElement("span");
		kind.className = "kind";
		kind.textContent = ` ${u.kind ?? "connect"}`;
		a.appendChild(kind);
		list.appendChild(a);
	}
}

async function selectModule(name: string): Promise<void> {
	showModuleWorkspace();
	$("#right-title").textContent = name;
	const body = $("#right-body");
	body.innerHTML = "";
	// Prefer a loaded connect unit's aw-mod (render preview); else RtlIndex leaf facts.
	for (const [, entry] of state.docs) {
		const mod = entry.container.querySelector(
			`aw-mod[name="${CSS.escape(name)}"]`,
		);
		if (mod) {
			const render = mod.querySelector(":scope > aw-render");
			const pre = document.createElement("pre");
			pre.textContent = render
				? serializeForView(render)
				: "(not rendered yet)";
			body.appendChild(pre);
			return;
		}
	}
	const res = await fetch(`/api/module?name=${encodeURIComponent(name)}`);
	if (!res.ok) {
		body.textContent = (await res.json()).error;
		return;
	}
	const leaf = await res.json();
	body.appendChild(
		tableOf("params", leaf.params, ["name", "kind", "dataType", "defaultText"]),
	);
	body.appendChild(
		tableOf("ports", leaf.ports, [
			"name",
			"dir",
			"dataType",
			"packed",
			"unpacked",
		]),
	);
}

function serializeForView(render: Element): string {
	const lines: string[] = [];
	const walk = (el: Element, depth: number): void => {
		const attrs = [...el.attributes]
			.map((a) => `${a.name}="${a.value}"`)
			.join(" ");
		lines.push(
			`${"  ".repeat(depth)}<${el.tagName.toLowerCase()}${attrs ? ` ${attrs}` : ""}>`,
		);
		for (const c of el.children) walk(c, depth + 1);
	};
	walk(render, 0);
	return lines.join("\n");
}

function tableOf(
	title: string,
	rows: Record<string, unknown>[],
	cols: string[],
): HTMLElement {
	const wrap = document.createElement("div");
	const h = document.createElement("h3");
	h.textContent = title;
	wrap.appendChild(h);
	const table = document.createElement("table");
	const head = document.createElement("tr");
	for (const c of cols) {
		const th = document.createElement("th");
		th.textContent = c;
		head.appendChild(th);
	}
	table.appendChild(head);
	for (const row of rows ?? []) {
		const tr = document.createElement("tr");
		for (const c of cols) {
			const td = document.createElement("td");
			td.textContent = String(row[c] ?? "");
			tr.appendChild(td);
		}
		table.appendChild(tr);
	}
	wrap.appendChild(table);
	return wrap;
}

function refreshRightIfRendered(): void {
	const title = $("#right-title").textContent;
	if (title && title !== "(no module selected)") void selectModule(title);
}

// ---------------------------------------------------------------------------
// Init.
// ---------------------------------------------------------------------------

async function resetAll(): Promise<void> {
	holdObs();
	try {
		for (const [id] of state.docs) AW.clearUnitHooks(id);
		state.docs.clear();
		state.phase.clear();
		state.dirty.clear();
		state.svText = "";
		state.htmlText = "";
		$("#aw-live").innerHTML = "";
		$("#aw-source").innerHTML = "";
		$("#aw-hooks").innerHTML = "";
		const gen = $("#aw-generated");
		gen.hidden = false;
		gen.textContent = "";
		const list = document.querySelector<HTMLElement>("#error-list");
		if (list) {
			list.hidden = true;
			list.textContent = "";
		}
		document.querySelector("#result-tabs")?.setAttribute("hidden", "");
		showUnitWorkspace();
		setAuthorTab("source");
		if (!state.current) throw new Error("no unit selected");
		await loadUnit(state.current);
		setStatus("idle", "idle");
	} finally {
		releaseObs();
	}
}

async function init(): Promise<void> {
	const meta = await fetchJson<UnitsMeta>("/api/units");
	state.units = meta.units;
	state.workspace = meta.workspace;
	if (meta.style) state.style = meta.style;
	$("#ws-name").textContent = meta.workspace.split("/").pop() ?? "";
	// Top-level mod names per unit (cross-unit reference checks).
	for (const u of state.units) {
		const res = await fetch(`/api/author?id=${encodeURIComponent(u.id)}`);
		if (!res.ok) continue;
		const parsed = new DOMParser().parseFromString(
			await res.text(),
			"text/html",
		);
		for (const m of parsed.querySelectorAll("autowire > aw-mod")) {
			const name = m.getAttribute("name");
			if (name) state.unitMods.set(name, u.id);
		}
	}
	const params = new URLSearchParams(location.search);
	const unitParam = params.get("unit");
	state.current =
		unitParam && unitOf(unitParam)
			? unitParam
			: (meta.defaultUnit ?? state.units[0]?.id ?? null);
	if (!state.current) {
		setStatus("error", "no connect units in autowire.toml");
		return;
	}
	$("#unit-name").textContent = state.current;
	buildUnitList();
	$("#btn-check").addEventListener("click", () => runChain({ check: true }));
	$("#btn-elaborate").addEventListener("click", () =>
		runChain({ elaborate: true }),
	);
	$("#btn-run").addEventListener("click", () => runChain({ run: true }));
	$("#btn-save-sv").addEventListener("click", () => {
		try {
			saveSv();
		} catch {
			/* status already set */
		}
	});
	$("#btn-save-html").addEventListener("click", () => {
		try {
			saveHtml();
		} catch (e) {
			setStatus("error", e instanceof Error ? e.message : String(e));
		}
	});
	$("#btn-reset").addEventListener("click", () => resetAll());
	document
		.querySelector("#tab-rtl")
		?.addEventListener("click", () => setSideTab("rtl"));
	document
		.querySelector("#tab-connect")
		?.addEventListener("click", () => setSideTab("connect"));
	document
		.querySelector("#atab-source")
		?.addEventListener("click", () => setAuthorTab("source"));
	document
		.querySelector("#atab-proc")
		?.addEventListener("click", () => setAuthorTab("processed"));
	document
		.querySelector("#rtab-sv")
		?.addEventListener("click", () => setResultTab("sv"));
	document
		.querySelector("#rtab-html")
		?.addEventListener("click", () => setResultTab("html"));
	watchInputs();
	await buildSummary();
	if (!minimal) await buildRtlList();
	if (!state.current) throw new Error("no unit selected");
	await loadUnit(state.current);
	// GET action contract (docs/workspace/web-ui.md §3.2): select → check → elaborate → run.
	const actions = {
		select: params.get("select"),
		check: params.get("check") === "1",
		elaborate: params.get("elaborate") === "1" || params.get("render") === "1",
		run: params.get("run") === "1" || params.get("dump") === "1",
	};
	if (actions.select || actions.check || actions.elaborate || actions.run)
		await runChain(actions);
}

try {
	await init();
} catch (error) {
	setStatus("error", `init: ${error instanceof Error ? error.message : error}`);
	throw error;
}
