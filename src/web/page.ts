// autowire web page controller (docs/workspace/web-ui.md). Runs in the browser only.
// Buttons and GET params share the same action chain: select → check → elaborate → run.
// Check has no prerequisite. Elaborate depends on a clean check. Run implies both.
// Nothing here writes the workspace. Save SV downloads the printed .sv text;
// Save HTML downloads the live author HTML with aw-render stripped.

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
} = {
	workspace: "",
	style: { paramInline: true },
	units: [],
	unitMods: new Map(),
	current: null,
	docs: new Map(),
	leafCache: new Map(),
	phase: new Map(),
};

function showGenerated(text: string): void {
	const box = $("#aw-generated");
	if (box) box.textContent = text;
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
	const text = $("#aw-generated")?.textContent ?? "";
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
	"before-instances: run author scripts on the current unit",
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
		await loadUnit(id);
		state.phase.set(id, "before-instances");
		showGenerated($("#aw-live").textContent ?? "");
		return "before-instances";
	}
	if (step === "check") {
		if (phase === "none")
			throw new Error('session: run "before-instances" before "check"');
		const res = await runCheck(id);
		if (res.errors.length === 0) state.phase.set(id, "check");
		const text = [...res.errors, ...res.warnings].join("\n") || "check ok";
		showGenerated(text);
		return text;
	}
	if (step === "elaborate") {
		if (phase !== "check" && phase !== "elaborate" && phase !== "before-dump")
			throw new Error('session: "elaborate" requires a clean check');
		const res = await runRender(id);
		if (res.errors.length > 0) throw new Error(res.errors[0]);
		state.phase.set(id, "elaborate");
		showGenerated($("#aw-live").textContent ?? "");
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
	hierarchy: HierNode[];
}

interface HierNode {
	module: string;
	blackbox?: boolean;
	cycle?: boolean;
	children?: HierNode[];
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

async function loadUnit(id: string): Promise<UnitEntry> {
	const cached = state.docs.get(id);
	if (cached) return cached;
	const res = await fetch(`/api/author?id=${encodeURIComponent(id)}`);
	if (!res.ok) throw new Error(((await res.json()) as { error: string }).error);
	const html = await res.text();
	const parsed = new DOMParser().parseFromString(html, "text/html");
	const root = parsed.querySelector("autowire");
	if (!root)
		throw new Error(`unit "${id}": author HTML has no <autowire> root`);
	const container = document.createElement("div");
	container.dataset.unit = id;
	const adopted = document.importNode(root, true);
	container.appendChild(adopted);
	$("#aw-live").appendChild(container);
	// Re-create module scripts so they execute; hooks bind to this unit.
	AW.beginUnitHooks(id);
	try {
		const pending: Promise<void>[] = [];
		for (const s of parsed.querySelectorAll('script[type="module"]')) {
			const el = document.createElement("script");
			el.type = "module";
			// Inline module scripts do not fire a load event; append a sentinel
			// line that resolves after the author script's top level executed
			// (document order), so hook registration lands before we close the
			// unit registry.
			const done = new Promise<void>((res) => {
				const q = win.__awScriptDone ?? [];
				win.__awScriptDone = q;
				q.push(res);
			});
			pending.push(done);
			el.textContent = `${s.textContent}\n;window.__awScriptDone?.shift()?.();`;
			document.body.appendChild(el);
		}
		await Promise.all(pending);
	} finally {
		AW.endUnitHooks();
	}
	const entry = { doc: container, container, rendered: false };
	state.docs.set(id, entry);
	return entry;
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
		for (const dir of ["input", "output", "inout", "interface"]) {
			for (const p of mod.querySelectorAll(`:scope > ports > ${dir}`)) {
				ports.push({
					name: p.getAttribute("name"),
					dir,
					packed: p.getAttribute("packed"),
					unpacked: p.getAttribute("unpacked"),
				});
			}
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

/** Run before-instances once per loaded unit (mutates aw-content). Must precede check. */
function ensureAuthorMutations(entry: UnitEntry, id: string): void {
	if (entry.hooksRan) return;
	entry.hooksRan = true;
	AW.runBeforeInstances(entry.doc as unknown as Document, id);
}

async function runCheck(id: string): Promise<AwEngine.CheckResult> {
	const entry = await loadUnit(id);
	// lifecycle §3.1: author-face mutators before check (hook-generated insts visible).
	ensureAuthorMutations(entry, id);
	const { errors: ctxErrors, ctx } = await buildCtx(id);
	const res = AW.check(entry.doc as unknown as Document, ctx);
	return { errors: [...ctxErrors, ...res.errors], warnings: res.warnings };
}

async function runRender(id: string): Promise<AwEngine.CheckResult> {
	const entry = await loadUnit(id);
	ensureAuthorMutations(entry, id);
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
	showGenerated(sv);
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
				if (res.errors.length > 0) throw new Error(res.errors[0]);
				if (res.warnings.length > 0)
					console.warn("[autowire check warnings]", res.warnings);
			}
			if (elaborate) {
				const res = await runRender(id);
				if (res.errors.length > 0) throw new Error(res.errors[0]);
				summary.push("elaborate: ok");
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

function hierNode(node: HierNode): HTMLElement {
	const det = document.createElement("details");
	const sum = document.createElement("summary");
	const span = document.createElement("span");
	span.className = `mod-node${node.blackbox ? " blackbox" : ""}`;
	span.textContent = node.blackbox ? `${node.module} (blackbox)` : node.module;
	span.dataset.mod = node.module;
	sum.appendChild(span);
	if (node.cycle) sum.appendChild(document.createTextNode(" (cycle)"));
	det.appendChild(sum);
	for (const c of node.children ?? []) det.appendChild(hierNode(c));
	return det;
}

async function buildLeft(): Promise<void> {
	const db = $("#db-summary");
	const tree = $("#dep-tree");
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
		tree.innerHTML = "";
		for (const top of idx.hierarchy) tree.appendChild(hierNode(top));
	} catch (e) {
		db.textContent = (e as Error).message;
	}
}

async function selectModule(name: string): Promise<void> {
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
	for (const [id] of state.docs) AW.clearUnitHooks(id);
	state.docs.clear();
	state.phase.clear();
	$("#aw-live").innerHTML = "";
	showGenerated("");
	if (!state.current) throw new Error("no unit selected");
	await loadUnit(state.current);
	setStatus("idle", "idle");
}

async function init(): Promise<void> {
	const meta = await fetchJson<UnitsMeta>("/api/units");
	state.units = meta.units;
	state.workspace = meta.workspace;
	if (meta.style) state.style = meta.style;
	$("#ws-name").textContent = meta.workspace.split("/").pop() ?? "";
	const sel = $<HTMLSelectElement>("#unit-select");
	for (const u of state.units) {
		const opt = document.createElement("option");
		opt.value = u.id;
		opt.textContent =
			u.deps.length > 0 ? `${u.id} (deps: ${u.deps.join(",")})` : u.id;
		sel.appendChild(opt);
	}
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
	sel.value = state.current;
	sel.addEventListener("change", async () => {
		state.current = sel.value;
		await resetAll();
	});
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
	$("#dep-tree").addEventListener("click", (e) => {
		const mod = (e.target as HTMLElement | null)?.dataset?.mod;
		if (mod) void selectModule(mod);
	});
	await buildLeft();
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
