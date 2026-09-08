// autowire web page controller (docs/workspace/web-ui.md). Runs in the browser only.
// Buttons and GET params share the same action chain: select → check → render → dump.
// Check has no prerequisite; Render depends on Check; Dump depends on Render.

// The engine is served as a bundle at /aw.js (runtime URL); tsc cannot resolve
// rooted specifiers, so we import it untyped and re-type it from the source.
// @ts-expect-error runtime bundle URL
import * as AWruntime from "/aw.js";
import type * as AwEngine from "../core/aw.ts";

const AW = AWruntime as typeof AwEngine;

type Status = "idle" | "running" | "done" | "error";

interface UnitMeta {
	id: string;
	html: string;
	deps: string[];
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
	render?: boolean;
	dump?: boolean;
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
	style: { param: "inline" | "localparam" };
	units: UnitMeta[]; // topo order: deps first
	unitMods: Map<string, string>; // mod name → unit id (top-level aw-mod of each unit)
	current: string | null; // current unit id
	docs: Map<string, UnitEntry>;
	leafCache: Map<string, AwEngine.ModFacts | null>;
} = {
	workspace: "",
	style: { param: "inline" },
	units: [],
	unitMods: new Map(),
	current: null,
	docs: new Map(),
	leafCache: new Map(),
};

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
	style?: { param: "inline" | "localparam" };
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
			`unit "${id}" deps: snapshot for "${d}" missing (render/dump "${d}" first)`,
	);
	return {
		errors,
		ctx: {
			style: state.style,
			unitId: id,
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
	const { errors: ctxErrors, ctx } = await buildCtx(id);
	const { doc } = await loadUnit(id);
	const res = AW.check(doc as unknown as Document, ctx);
	return { errors: [...ctxErrors, ...res.errors], warnings: res.warnings };
}

async function runRender(id: string): Promise<AwEngine.CheckResult> {
	const entry = await loadUnit(id);
	// before-instances prepass once per document; then leaf tables cover
	// hook-generated instances too (elaborate() itself does not run hooks).
	if (!entry.hooksRan) {
		entry.hooksRan = true;
		AW.runBeforeInstances(entry.doc as unknown as Document, id);
	}
	const { errors: ctxErrors, ctx } = await buildCtx(id);
	if (ctxErrors.length > 0) return { errors: ctxErrors, warnings: [] };
	const res = AW.elaborate(entry.doc as unknown as Document, ctx);
	if (res.errors.length === 0) entry.rendered = true;
	return res;
}

async function runDump(id: string): Promise<{ files: string[] }> {
	if (!unitOf(id)) throw new Error(`unknown unit "${id}"`);
	// Dump collects every related unit: deps first, then this unit.
	const chain: string[] = [];
	const visit = (uid: string): void => {
		if (chain.includes(uid)) return;
		for (const d of unitOf(uid)?.deps ?? []) visit(d);
		chain.push(uid);
	};
	visit(id);
	const files: string[] = [];
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
		const html = AW.serializeSnapshot(entry.doc as unknown as Document);
		const data = await fetchJson<{ files?: string[] }>("/api/dump", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: uid, html }),
		});
		files.push(...(data.files ?? []));
	}
	return { files };
}

/** One action chain: select → check → render → dump (docs/workspace/web-ui.md §3). */
async function runChain({
	select,
	check,
	render,
	dump,
}: ChainActions): Promise<void> {
	setStatus("running", "running…");
	try {
		if (select) await selectModule(select);
		const id = state.current;
		if (!id) throw new Error("no unit selected");
		const summary: string[] = [];
		if (dump) {
			// Dump implies check → render per unit in deps topo order (runDump);
			// a missing dep snapshot is fine here because the chain renders the
			// dep in-session first.
			const res = await runDump(id);
			summary.push(
				`check: ok; render: ok; dump: ${res.files.length} file(s) written`,
			);
		} else {
			if (check || render) {
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
			if (render) {
				const res = await runRender(id);
				if (res.errors.length > 0) throw new Error(res.errors[0]);
				summary.push("render: ok");
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
	$("#aw-live").innerHTML = "";
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
	$("#btn-render").addEventListener("click", () => runChain({ render: true }));
	$("#btn-dump").addEventListener("click", () => runChain({ dump: true }));
	$("#btn-save").addEventListener("click", async () => {
		// Debug drop (docs/mcp/README.md): persist the live DOM to
		// .autowire/save/<unit>.html; never writes the author HTML.
		const entry = state.current ? state.docs.get(state.current) : undefined;
		const root = entry?.container.querySelector(":scope > autowire");
		if (!root) {
			setStatus("error", `save: unit "${state.current}" not loaded`);
			return;
		}
		try {
			const res = await fetchJson<{ file: string }>("/api/save", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: state.current, html: root.outerHTML }),
			});
			setStatus("done", `saved → ${res.file}`);
		} catch (e) {
			setStatus("error", `save: ${(e as Error).message}`);
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
	// GET action contract (docs/workspace/web-ui.md §3.2): fixed order select → check → render → dump.
	const actions = {
		select: params.get("select"),
		check: params.get("check") === "1",
		render: params.get("render") === "1",
		dump: params.get("dump") === "1",
	};
	if (actions.select || actions.check || actions.render || actions.dump)
		await runChain(actions);
}

await init();
