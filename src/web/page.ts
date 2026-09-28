// autowire web page controller (docs/workspace/web-ui.md). Runs in the browser only.
// Buttons and GET params share the same action chain: select → check → elaborate → run.
// Check has no prerequisite. Elaborate depends on a clean check. Run implies both.
// Nothing here writes the workspace. Save SV downloads the printed .sv text;
// Save HTML downloads the processed author face with aw-render stripped.
// #aw-source is the author HTML, including classic <script>. #aw-live is the
// pipeline output, replaced on each elaborate — scripts do not write back.
// check is static and does not run scripts. elaborate runs scripts, on-init,
// and on-template on the processed clone only.

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
	/** Processed workspace (clone after scripts / elaborate). */
	doc: HTMLElement;
	container: HTMLElement;
	rendered: boolean;
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
	leavesLoaded: boolean;
	/** Last successful session step for the current unit. `run` is not stored. */
	phase: Map<string, "check" | "elaborate" | "before-dump">;
	/** Input edits since the last compile of that unit. */
	dirty: Set<string>;
	svText: string;
	htmlText: string;
	/** Per-stage error text routed into the result tabs (empty = none). */
	renderError: string;
	svError: string;
	/** RtlIndex module currently shown in the RtlIndex author tab (full page). */
	rtlModule: string | null;
} = {
	workspace: "",
	style: { paramInline: true },
	units: [],
	unitMods: new Map(),
	current: null,
	docs: new Map(),
	leafCache: new Map(),
	leavesLoaded: false,
	phase: new Map(),
	dirty: new Set(),
	svText: "",
	htmlText: "",
	renderError: "",
	svError: "",
	rtlModule: null,
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
}

/** Park every unit tree except the processed container for `id`. */
function parkOtherUnits(id: string): () => void {
	const parked: { node: Element; parent: Node; next: ChildNode | null }[] = [];
	for (const pane of ["#aw-source", "#aw-live"]) {
		const root = document.querySelector(pane);
		if (!root) continue;
		for (const el of [...root.children]) {
			if (!(el instanceof HTMLElement) || !el.dataset.unit) continue;
			if (pane === "#aw-live" && el.dataset.unit === id) continue;
			parked.push({ node: el, parent: root, next: el.nextSibling });
			el.remove();
		}
	}
	return () => {
		// Reverse: a node's next sibling may itself be parked.
		for (const item of parked.reverse())
			item.parent.insertBefore(item.node, item.next);
	};
}

function withCurrentUnit<T>(id: string, fn: () => T): T {
	holdObs();
	const restore = parkOtherUnits(id);
	try {
		return fn();
	} finally {
		restore();
		releaseObs();
	}
}

function setAuthorTab(which: "source" | "processed" | "rtl"): void {
	const src = document.querySelector<HTMLElement>("#author-source");
	const proc = document.querySelector<HTMLElement>("#author-processed");
	const rtl = document.querySelector<HTMLElement>("#author-rtl");
	if (!src || !proc) return;
	src.hidden = which !== "source";
	proc.hidden = which !== "processed";
	if (rtl) rtl.hidden = which !== "rtl";
	document
		.querySelector("#atab-source")
		?.setAttribute("aria-selected", String(which === "source"));
	document
		.querySelector("#atab-proc")
		?.setAttribute("aria-selected", String(which === "processed"));
	document
		.querySelector("#atab-rtl")
		?.setAttribute("aria-selected", String(which === "rtl"));
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

/** Rebuild the display tree next to a real workspace pane. The real aw-* nodes
 *  stay untouched (the engine and Playwright read them); only the sibling view
 *  is painted. No-op on the minimal page, which has no view element. */
function refreshView(realId: "#aw-source" | "#aw-live"): void {
	const view = document.querySelector(
		realId === "#aw-source" ? "#aw-source-view" : "#aw-live-view",
	);
	const real = document.querySelector(realId);
	if (!view || !real) return;
	const open = new Set<string>();
	for (const d of view.querySelectorAll("details:not([open])")) {
		const key = d.getAttribute("data-path");
		if (key) open.add(key);
	}
	view.replaceChildren();
	let n = 0;
	const walk = (node: Element, host: HTMLElement, path: string): void => {
		for (const child of [...node.children]) {
			// The per-unit <div data-unit> is a page wrapper, not author HTML.
			if (child.hasAttribute("data-unit")) {
				walk(child, host, path);
				continue;
			}
			const key = `${path}/${n++}`;
			host.appendChild(viewNode(child, key, open));
		}
	};
	walk(real, view as HTMLElement, realId);
}

/** One real element becomes either a collapsible <details> (it has element
 *  children) or a single leaf row. A marker exists only on a real container. */
function viewNode(el: Element, path: string, closed: Set<string>): HTMLElement {
	const tag = el.tagName.toLowerCase();
	const kids = [...el.children];
	if (kids.length === 0) return leafRow(el, tag);
	const box = document.createElement("details");
	box.open = !closed.has(path);
	box.dataset.path = path;
	const summary = document.createElement("summary");
	fillTag(summary, el, tag, true);
	box.appendChild(summary);
	if (tag === "script") {
		const body = document.createElement("span");
		body.className = "script-body";
		body.textContent = (el.textContent ?? "")
			.replace(/^\n/, "")
			.replace(/\s+$/, "");
		box.appendChild(body);
	}
	const rules = tag === "aw-template";
	const body = rules ? document.createElement("div") : box;
	if (rules) {
		body.className = "rules";
		box.appendChild(body);
	}
	let n = 0;
	for (const child of kids)
		body.appendChild(viewNode(child, `${path}/${n++}`, closed));
	return box;
}

function leafRow(el: Element, tag: string): HTMLElement {
	if (
		tag === "aw-connect" ||
		tag === "aw-rewrite" ||
		tag === "aw-param" ||
		tag === "aw-localparam"
	) {
		const row = document.createElement("div");
		row.className = "leaf";
		for (const text of ruleCols(el, tag)) {
			const col = document.createElement("span");
			col.className = "col";
			col.textContent = text;
			row.appendChild(col);
		}
		return row;
	}
	const row = document.createElement("div");
	row.className = "leaf";
	fillTag(row, el, tag, false);
	if (tag === "script" && (el.textContent ?? "").trim()) {
		const body = document.createElement("span");
		body.className = "script-body";
		body.textContent = (el.textContent ?? "")
			.replace(/^\n/, "")
			.replace(/\s+$/, "");
		const wrap = document.createElement("div");
		wrap.appendChild(row);
		wrap.appendChild(body);
		return wrap;
	}
	return row;
}

/** Paint one element the way the DevTools Elements panel does: an opening tag
 *  with each attribute as name="value", and for a container the collapsed form
 *  `<tag ...></tag>` plus a closing tag shown only while it is expanded. */
function fillTag(
	host: HTMLElement,
	el: Element,
	tag: string,
	container: boolean,
): void {
	const open = document.createElement("span");
	open.className = "tg";
	open.textContent = `<${tag}`;
	host.appendChild(open);
	for (const attr of el.attributes) {
		host.appendChild(document.createTextNode(" "));
		const name = document.createElement("span");
		name.className = "an";
		name.textContent = attr.name;
		host.appendChild(name);
		const eq = document.createElement("span");
		eq.className = "punct";
		eq.textContent = "=";
		host.appendChild(eq);
		const value = document.createElement("span");
		value.className = "av";
		value.textContent = `"${attr.value}"`;
		host.appendChild(value);
	}
	const end = document.createElement("span");
	end.className = "tg";
	end.textContent = container || (el.textContent ?? "").trim() ? ">" : " />";
	host.appendChild(end);
	if (!container) return;
	const ellipsis = document.createElement("span");
	ellipsis.className = "ellipsis";
	ellipsis.textContent = "...";
	host.appendChild(ellipsis);
	const close = document.createElement("span");
	close.className = "close";
	close.textContent = `</${tag}>`;
	host.appendChild(close);
}

/** Column-aligned rule cells: type, content, target, trailing qualifiers. */
function ruleCols(el: Element, tag: string): string[] {
	const a = (name: string) => el.getAttribute(name) ?? "";
	const extra = [
		a("packed") && `packed=${a("packed")}`,
		a("unpacked") && `unpacked=${a("unpacked")}`,
		a("width") && `width=${a("width")}`,
		a("part") && `part=${a("part")}`,
		a("nettype") && a("nettype"),
	]
		.filter(Boolean)
		.join("  ");
	if (tag === "aw-connect")
		return [
			a("type") || "net",
			`.${a("port")}`,
			a("to") || (a("type") === "open" ? "(open)" : ""),
			extra,
		];
	if (tag === "aw-rewrite")
		return [
			"rewrite",
			a("match"),
			a("to") || (a("type") === "open" ? "(open)" : ""),
			extra,
		];
	return [
		tag === "aw-localparam" ? "localparam" : "param",
		a("name"),
		a("expr"),
		extra,
	];
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

/** Paint the currently-selected result tab: its product, or its stage error.
 *  The minimal page (no #result-tabs) keeps a plain-text #aw-generated. */
function paintResult(): void {
	const gen = $("#aw-generated");
	const list = document.querySelector<HTMLElement>("#error-list");
	const tabs = document.querySelector("#result-tabs");
	if (!tabs) {
		const err = state.renderError || state.svError;
		if (err) {
			if (list) {
				list.hidden = false;
				list.textContent = err;
			}
			gen.hidden = true;
		} else {
			if (list) {
				list.hidden = true;
				list.textContent = "";
			}
			gen.hidden = false;
			gen.textContent = state.svText || state.htmlText;
		}
		return;
	}
	const render =
		document.querySelector("#rtab-render")?.getAttribute("aria-selected") ===
		"true";
	const err = render ? state.renderError : state.svError;
	if (err) {
		if (list) {
			list.hidden = false;
			list.textContent = err;
		}
		gen.hidden = true;
		return;
	}
	if (list) {
		list.hidden = true;
		list.textContent = "";
	}
	gen.hidden = false;
	if (render) highlightXml(state.htmlText, gen);
	else highlightSv(state.svText, gen);
}

function setResultTab(which: "render" | "sv"): void {
	document
		.querySelector("#rtab-render")
		?.setAttribute("aria-selected", String(which === "render"));
	document
		.querySelector("#rtab-sv")
		?.setAttribute("aria-selected", String(which === "sv"));
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
	const view = document.querySelector("#aw-live-view");
	if (!view) return;
	for (const el of view.querySelectorAll(".err")) el.classList.remove("err");
	if (names.length === 0) return;
	const want = new Set(names);
	for (const row of view.querySelectorAll(".leaf, details")) {
		const text =
			row.querySelector(":scope > summary, :scope")?.textContent ?? "";
		if ([...want].some((n) => text.includes(n))) row.classList.add("err");
	}
}

function snapshotOf(id: string): string {
	const entry = state.docs.get(id);
	if (!entry?.doc) return "";
	return AW.serializeSnapshot(entry.doc);
}

/** Route a check / elaborate / render stage error into the Rendered tab. */
function showErrors(errors: string[]): void {
	state.renderError = errors.join("\n");
	markProcessed(namesInErrors(errors));
	setAuthorTab("processed");
	const tabs = document.querySelector("#result-tabs");
	if (tabs) {
		tabs.removeAttribute("hidden");
		setResultTab("render");
	} else paintResult();
}

/** Route a `.sv` print stage error into the SystemVerilog tab. */
function showSvError(message: string): void {
	state.svError = message;
	const tabs = document.querySelector("#result-tabs");
	if (tabs) {
		tabs.removeAttribute("hidden");
		setResultTab("sv");
	} else paintResult();
}

function showResult(sv: string | null, html: string | null): void {
	if (sv !== null) state.svText = sv;
	if (html !== null) state.htmlText = html;
	// A freshly produced product clears the matching stage error.
	if (sv !== null) state.svError = "";
	if (html !== null) state.renderError = "";
	markProcessed([]);
	const tabs = document.querySelector("#result-tabs");
	if (tabs) {
		tabs.removeAttribute("hidden");
		// After Run (sv present) default to SystemVerilog; else Rendered.
		setResultTab(state.svText ? "sv" : "render");
		return;
	}
	paintResult();
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
	"check: static author-face rules; does not run scripts",
	"elaborate: classic scripts, then on-init / on-template, then freeze aw-render (does not write the input back)",
	"before-dump: snapshot of the frozen render; requires elaborate in this session",
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
	if (step === "check") {
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
		const res = await runRender(id);
		if (res.errors.length > 0) throw new Error(res.errors[0]);
		state.phase.set(id, "elaborate");
		showResult("", snapshotOf(id));
		setAuthorTab("processed");
		return "elaborate";
	}
	if (step === "before-dump") {
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
// Unit loading: author HTML → source workspace. Classic scripts stay in the
// source tree and run only on the processed clone.
// ---------------------------------------------------------------------------

function isClassicScript(script: Element): boolean {
	const type = (script.getAttribute("type") ?? "").trim().toLowerCase();
	return (
		type === "" ||
		type === "text/javascript" ||
		type === "application/javascript"
	);
}

/** Run classic scripts from the processed clone so functions land on window.
 *  `src` resolves relative to the author HTML via /raw/. */
async function runClassicScripts(
	root: ParentNode,
	unitHtml: string,
): Promise<void> {
	const scripts = [...root.querySelectorAll("script")];
	for (const script of scripts) {
		const type = (script.getAttribute("type") ?? "").trim().toLowerCase();
		if (type === "module")
			throw new Error(
				'author script must be a classic <script> (type="module" is not allowed)',
			);
		if (!isClassicScript(script)) continue;
		const srcAttr = script.getAttribute("src");
		const inline = script.textContent ?? "";
		if (!srcAttr && !inline.trim()) continue;
		const el = document.createElement("script");
		el.dataset.awInjected = "1";
		if (srcAttr) {
			const base = new URL(unitHtml, `${location.origin}/raw/`);
			el.src = new URL(srcAttr, base).href;
			await new Promise<void>((resolve, reject) => {
				el.addEventListener("load", () => resolve());
				el.addEventListener("error", () =>
					reject(new Error(`script failed to load ${srcAttr}`)),
				);
				document.body.appendChild(el);
			});
		} else {
			el.textContent = inline;
			document.body.appendChild(el);
		}
		el.remove();
	}
}

/** Clone the input workspace into #aw-live. Scripts run only when asked. */
async function compileUnit(
	entry: UnitEntry,
	id: string,
	runScripts: boolean,
): Promise<void> {
	holdObs();
	try {
		if (entry.doc !== entry.source) entry.doc.remove();
		const container = document.createElement("div");
		container.dataset.unit = id;
		for (const child of [...entry.source.children])
			container.appendChild(child.cloneNode(true));
		$("#aw-live").appendChild(container);
		entry.doc = container;
		entry.container = container;
		entry.rendered = false;
		if (runScripts) await runClassicScripts(container, unitOf(id)?.html ?? "");
		state.dirty.delete(id);
		refreshView("#aw-live");
	} finally {
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
		for (const child of [...parsed.body.children]) {
			const tag = child.tagName.toLowerCase();
			if (tag === "script" || tag === "autowire")
				source.appendChild(document.importNode(child, true));
		}
		$("#aw-source").appendChild(source);
		refreshView("#aw-source");
		const entry: UnitEntry = {
			source,
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
	await loadUnit(id);
	const wrappers = new Map<string, WrapperFacts>();
	const missing: string[] = [];
	for (const dep of unit.deps) {
		const r = await depWrappers(dep);
		if (r.missing) missing.push(r.missing);
		for (const f of r.facts ?? []) wrappers.set(f.name ?? "", f);
	}
	// Every leaf, so on-init can instantiate a module the HTML never named.
	if (!state.leavesLoaded) {
		const res = await fetch("/api/leaves");
		if (res.ok) {
			const data = (await res.json()) as { modules: AwEngine.ModFacts[] };
			for (const mod of data.modules) {
				if (mod.name) state.leafCache.set(mod.name, mod);
			}
		}
		state.leavesLoaded = true;
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

async function runCheck(id: string): Promise<AwEngine.CheckResult> {
	const entry = await loadUnit(id);
	const { errors: ctxErrors, ctx } = await buildCtx(id);
	// Static rules on the author HTML. Scripts and on-init are not run.
	const res = AW.check(entry.source, ctx);
	return { errors: [...ctxErrors, ...res.errors], warnings: res.warnings };
}

async function runRender(id: string): Promise<AwEngine.CheckResult> {
	const entry = await loadUnit(id);
	await compileUnit(entry, id, true);
	setAuthorTab("processed");
	const { errors: ctxErrors, ctx } = await buildCtx(id);
	if (ctxErrors.length > 0) return { errors: ctxErrors, warnings: [] };
	const res = withCurrentUnit(id, () => AW.elaborate(entry.doc, ctx));
	if (res.errors.length === 0) entry.rendered = true;
	refreshView("#aw-live");
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
		files.push({
			uid,
			text: AW.serializeSnapshot(entry.doc),
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
	const text = AW.serializeSnapshot(entry.doc);
	showGenerated(text);
	return { files: [text] };
}

/** Reflect one step's status on its own action button (docs/workspace/web-ui.md §1/§4). */
type ActionButton = "check" | "elaborate" | "run";
function setBtnState(which: ActionButton, s: Status): void {
	document.querySelector(`#btn-${which}`)?.setAttribute("data-state", s);
}
function resetBtnStates(): void {
	for (const b of ["check", "elaborate", "run"] as ActionButton[])
		setBtnState(b, "idle");
}

/** One action chain: select → check → elaborate → run (docs/workspace/web-ui.md §3). */
async function runChain({
	select,
	check,
	elaborate,
	run,
}: ChainActions): Promise<void> {
	setStatus("running", "running…");
	resetBtnStates();
	try {
		if (select) await selectModule(select);
		const id = state.current;
		if (!id) throw new Error("no unit selected");
		const summary: string[] = [];
		if (run) {
			setBtnState("check", "running");
			try {
				const res = await runView(id);
				setBtnState("check", "done");
				setBtnState("elaborate", "done");
				setBtnState("run", "done");
				summary.push(
					`check: ok; elaborate: ok; source: ${res.files.length} unit(s) as .sv in view`,
				);
			} catch (e) {
				const msg = (e as Error).message;
				// runView tags upstream failures; a print failure is anything else.
				if (msg.startsWith("check failed")) {
					setBtnState("check", "error");
					showErrors([msg]);
				} else if (msg.startsWith("render failed")) {
					setBtnState("check", "done");
					setBtnState("elaborate", "error");
					showErrors([msg]);
				} else {
					setBtnState("check", "done");
					setBtnState("elaborate", "done");
					setBtnState("run", "error");
					showSvError(msg);
				}
				throw e;
			}
		} else {
			if (check || elaborate) {
				setBtnState("check", "running");
				const res = await runCheck(id);
				summary.push(
					res.errors.length > 0
						? `check: ${res.errors.length} error(s)`
						: `check: ok${res.warnings.length > 0 ? ` (${res.warnings.length} warning(s))` : ""}`,
				);
				if (res.errors.length > 0) {
					setBtnState("check", "error");
					showErrors(res.errors);
					throw new Error(res.errors[0]);
				}
				setBtnState("check", "done");
				showResult("", snapshotOf(id));
				setAuthorTab("processed");
				if (res.warnings.length > 0)
					console.warn("[autowire check warnings]", res.warnings);
			}
			if (elaborate) {
				setBtnState("elaborate", "running");
				const res = await runRender(id);
				if (res.errors.length > 0) {
					setBtnState("elaborate", "error");
					showErrors(res.errors);
					throw new Error(res.errors[0]);
				}
				setBtnState("elaborate", "done");
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
	state.rtlModule = name;
	const rtlPane = document.querySelector<HTMLElement>("#aw-rtl");
	if (rtlPane) {
		// Full page: the RtlIndex author tab (peer of Source / Processed).
		setAuthorTab("rtl");
		await renderRtlDetail(name, rtlPane);
		return;
	}
	// Minimal page: legacy right-title / right-body (MIN_HTML is unchanged).
	const title = document.querySelector<HTMLElement>("#right-title");
	const body = document.querySelector<HTMLElement>("#right-body");
	if (!title || !body) return;
	title.textContent = name;
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

/** Render one RtlIndex module's detail (leaf facts from /api/module) into the
 *  RtlIndex author tab, as collapsible sections consistent with Source /
 *  Processed. RtlIndex is read-only; the page never reparses RTL. */
async function renderRtlDetail(name: string, host: HTMLElement): Promise<void> {
	host.replaceChildren();
	host.classList.add("aw-tree");
	const title = document.createElement("div");
	title.className = "rtl-title";
	title.textContent = name;
	host.appendChild(title);
	const res = await fetch(`/api/module?name=${encodeURIComponent(name)}`);
	if (!res.ok) {
		const err = document.createElement("div");
		err.textContent =
			((await res.json()) as { error?: string }).error ?? "unknown module";
		host.appendChild(err);
		return;
	}
	const leaf = (await res.json()) as {
		params?: Record<string, unknown>[];
		imports?: Record<string, unknown>[];
		ports?: Record<string, unknown>[];
		instances?: Record<string, unknown>[];
	};
	host.appendChild(
		rtlSection("params", leaf.params ?? [], [
			"name",
			"kind",
			"dataType",
			"defaultText",
		]),
	);
	host.appendChild(
		rtlSection("imports", leaf.imports ?? [], ["package", "symbol"]),
	);
	host.appendChild(
		rtlSection("ports", leaf.ports ?? [], [
			"name",
			"dir",
			"dataType",
			"packed",
			"unpacked",
		]),
	);
	if (leaf.instances && leaf.instances.length > 0)
		host.appendChild(
			rtlSection("instances", leaf.instances, ["id", "mod", "module"]),
		);
}

/** One collapsible section for the RtlIndex tab, same <details> shape as the
 *  Source / Processed view trees. */
function rtlSection(
	title: string,
	rows: Record<string, unknown>[],
	cols: string[],
): HTMLElement {
	const sec = document.createElement("details");
	sec.open = true;
	const head = document.createElement("summary");
	const mk = document.createElement("span");
	mk.className = "mk";
	mk.textContent = String(rows.length);
	head.appendChild(mk);
	head.appendChild(document.createTextNode(title));
	sec.appendChild(head);
	const table = document.createElement("table");
	const hr = document.createElement("tr");
	for (const c of cols) {
		const th = document.createElement("th");
		th.textContent = c;
		hr.appendChild(th);
	}
	table.appendChild(hr);
	for (const row of rows) {
		const tr = document.createElement("tr");
		for (const c of cols) {
			const td = document.createElement("td");
			td.textContent = String(row[c] ?? "");
			tr.appendChild(td);
		}
		table.appendChild(tr);
	}
	sec.appendChild(table);
	return sec;
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
	// The RtlIndex tab shows static leaf facts; only the minimal page's aw-mod
	// render preview benefits from a refresh after elaborate.
	const title = document.querySelector("#right-title");
	if (title?.textContent && title.textContent !== "(no module selected)")
		void selectModule(title.textContent);
}

// ---------------------------------------------------------------------------
// Init.
// ---------------------------------------------------------------------------

async function resetAll(): Promise<void> {
	holdObs();
	try {
		state.docs.clear();
		state.phase.clear();
		state.dirty.clear();
		state.svText = "";
		state.htmlText = "";
		state.renderError = "";
		state.svError = "";
		state.rtlModule = null;
		$("#aw-live").innerHTML = "";
		$("#aw-source").innerHTML = "";
		const gen = $("#aw-generated");
		gen.hidden = false;
		gen.textContent = "";
		const list = document.querySelector<HTMLElement>("#error-list");
		if (list) {
			list.hidden = true;
			list.textContent = "";
		}
		document.querySelector("#result-tabs")?.setAttribute("hidden", "");
		const rtl = document.querySelector<HTMLElement>("#aw-rtl");
		if (rtl) rtl.replaceChildren();
		resetBtnStates();
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
		.querySelector("#atab-rtl")
		?.addEventListener("click", () => setAuthorTab("rtl"));
	document
		.querySelector("#rtab-render")
		?.addEventListener("click", () => setResultTab("render"));
	document
		.querySelector("#rtab-sv")
		?.addEventListener("click", () => setResultTab("sv"));
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
