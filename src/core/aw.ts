// aw.ts — autowire connect engine (browser + linkedom compatible, no Node APIs).
// web/aw.js is GENERATED: `bun run build:web` (bun build src/core/aw.ts). Never edit it.

// --- Shared shapes (browser page, server check, and tests all consume these) ---

export interface CheckResult {
	errors: string[];
	warnings: string[];
}

export interface PortFacts {
	name: string;
	dir: string;
	dataType?: string | null;
	packed?: string | null;
	unpacked?: string | null;
	interface?: string | null;
	modport?: string | null;
}

export interface ParamFacts {
	name: string;
	kind?: string;
	defaultText?: string | null;
	value?: string | null;
}

export interface ModFacts {
	name?: string;
	params: ParamFacts[];
	ports: PortFacts[];
	imports?: { package: string; symbol: string }[];
}

/** Engine inputs: leaf tables (RtlIndex), elaborated wrapper facts, unit deps. */
export interface EngineCtx {
	/** [style] from autowire.toml; paramInline defaults to true. */
	style?: { paramInline?: boolean; localparamUpper?: boolean };
	unitId?: string;
	unitDeps?: string[];
	unitMods?: Map<string, string>;
	leaf?: (mod: string) => ModFacts | null;
	wrapper?: (mod: string) => ModFacts | null;
}

/** Lifecycle hook payloads (docs/connect/lifecycle.md). */
export interface HookArgs {
	mod?: Element;
	doc?: Document;
	inst?: Element;
	template?: Element | null;
	connects?: Record<string, unknown>[];
}

export type HookFn = (args: HookArgs) => void;
export type HookPhase = "before-instances" | "on-template" | "before-dump";

/** Minimal structural window for installGlobal (works in Bun/linkedom/ Chromium). */
export interface AwWindow {
	customElements?: {
		get(name: string): unknown;
		define(name: string, ctor: new () => HTMLElement): void;
	};
	HTMLElement: new () => HTMLElement;
	aw?: unknown;
}

// --- Internal working shapes ---

interface ScopeEntry {
	value: string;
	folded: boolean;
	resolved?: string;
}

interface ModScope {
	params: Map<string, ScopeEntry>;
	localparams: Map<string, ScopeEntry>;
}

/** One expanded connect rule (net / const / open). */
interface RuleConnect {
	to: string | null;
	packed: string | null;
	width: string | null;
	unpacked: string | null;
	part: string | null;
	nettype: string | null;
	isConst: boolean;
	open?: boolean;
}

interface RenderInstDraft {
	id: string;
	mod: string;
	params: Map<string, { expr: string; uniq: string; renderValue: string }>;
	connects: Map<string, RuleConnect>;
	order: string[];
	leafParams: Map<string, ParamFacts>;
}

interface SignalEntry {
	name: string;
	packed: string | null;
	unpacked: string | null;
	nettype: string | null;
	interface?: string | null;
}

interface UniqLp {
	name: string;
	value: string;
	folded: boolean;
	forInst: string;
	forParam: string;
}

interface PortOut {
	name: string;
	dir: string;
	packed: string | null;
	unpacked: string | null;
	nettype?: string | null;
	interface?: string | null;
	modport?: string | null;
	auto?: boolean;
}

interface WriteModel {
	scope: ModScope;
	imports: { package: string; symbol: string }[];
	uniqLocalparams: UniqLp[];
	portsOut: PortOut[];
	signals: Map<string, SignalEntry>;
	renderInsts: RenderInstDraft[];
}

/** Evaluate a fully-constant arithmetic expression (part-selects after ${…} substitution). Returns null when any identifier/macro remains. */
function evalConst(expr: string): number | null {
	const s = expr.trim();
	if (
		s === "" ||
		/[A-Za-z_`$]/.test(s.replace(/\d+'[bodhBODH][0-9a-fA-FxXzZ?]+/g, ""))
	)
		return null;
	let i = 0;
	const peek = () => s[i] as string | undefined;
	const skip = (): void => {
		while (/\s/.test(s[i] ?? "")) i++;
	};
	const num = (): number | null => {
		skip();
		const m = /^(\d+'[bodhBODH][0-9a-fA-FxXzZ?]+|\d+)/.exec(s.slice(i));
		if (!m) return null;
		i += m[0].length;
		const based = /^(\d+)'([bodhBODH])([0-9a-fA-FxXzZ?]+)$/.exec(m[0]);
		if (!based) return Number(m[0]);
		const base = ({ b: 2, o: 8, d: 10, h: 16 } as Record<string, number>)[
			based[2]!.toLowerCase()
		];
		return Number.parseInt(based[3]!.replace(/[xXzZ?]/g, "0"), base);
	};
	const prim = (): number | null => {
		skip();
		if (peek() === "(") {
			i++;
			const v = addsub();
			skip();
			if (peek() !== ")") return null;
			i++;
			return v;
		}
		return num();
	};
	const mul = (): number | null => {
		let v: number | null = prim();
		if (v == null) return null;
		for (;;) {
			skip();
			if (peek() === "*" || peek() === "/" || peek() === "%") {
				const op = s[i++];
				const r = prim();
				if (r == null) return null;
				v = op === "*" ? v * r : op === "/" ? Math.trunc(v / r) : v % r;
			} else return v;
		}
	};
	const addsub = (): number | null => {
		let v: number | null = mul();
		if (v == null) return null;
		for (;;) {
			skip();
			if (peek() === "+" || peek() === "-") {
				const op = s[i++];
				const r = mul();
				if (r == null) return null;
				v = op === "+" ? v + r : v - r;
			} else return v;
		}
	};
	const v = addsub();
	skip();
	return i === s.length ? v : null;
}

/** Evaluate every `a:b` / single segment of a part-select when fully constant. */
function evalPart(part: string | null): string | null {
	if (!part) return part;
	const segs = part.split(":").map((seg: string) => {
		const v = evalConst(seg);
		return v == null ? seg.trim() : String(v);
	});
	return segs.join(":");
}

/** Canonical packed/unpacked form: bare ranges get brackets ("15:0" → "[15:0]"). */
function canonicalDims(t: string | null): string | null {
	return t && !t.startsWith("[") ? `[${t}]` : t;
}

/** Fold dimension text: substitute known constant values, collapse constant
 *  arithmetic per segment. Exported port dims must not reference another
 *  module's uniquified localparams — folding keeps them self-contained. */
function foldDims(
	text: string | null,
	vals: Map<string, string>,
): string | null {
	if (!text) return text;
	const evalSeg = (seg: string) =>
		seg
			.split(":")
			.map((p: string) => {
				const v = evalConst(p);
				return v == null ? p.trim() : String(v);
			})
			.join(":");
	let t = text;
	// Fixpoint: substituted text may itself name another localparam.
	for (let i = 0; i < 4; i++) {
		const next = t.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (s) =>
			vals.has(s) ? `(${vals.get(s)})` : s,
		);
		if (next === t) break;
		t = next;
	}
	t = t.replace(/\[([^\]]+)\]/g, (_m, inner) => `[${evalSeg(inner)}]`);
	if (!t.includes("[")) t = evalSeg(t);
	return t;
}

// Contract: docs/connect/html.md, docs/connect/rules.md, docs/connect/lifecycle.md.
// Two faces: aw-content (author) → elaboration → aw-render (frozen, dump SoT).
// The engine is synchronous: callers pre-fetch leaf port tables into ctx.

const CONTENT_GROUPS = [
	"aw-imports",
	"aw-params",
	"aw-localparams",
	"aw-ports",
	"aw-templates",
	"aw-insts",
];
const GROUP_CHILD = {
	"aw-imports": "aw-import",
	"aw-params": "aw-param",
	"aw-localparams": "aw-localparam",
	"aw-ports": "aw-port",
	"aw-templates": "aw-template",
	"aw-insts": "aw-inst",
};
const RENDER_GROUPS = [
	"aw-params",
	"aw-imports",
	"aw-localparams",
	"aw-ports",
	"aw-signals",
	"aw-insts",
];
const HOOK_PHASES: HookPhase[] = [
	"before-instances",
	"on-template",
	"before-dump",
];
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LITERAL = /^(\d+('[bodhBODH][0-9a-fA-F_xXzZ?]+)?|\d+("[^"]*")?|"[^"]*")$/;

/** Classify an aw-connect@to text (after ${…} substitution): "net" or "const".
 *  Rules (docs/connect/to-rules.md §2.2): a plain identifier is a net,
 *  unless it names a module param/localparam (constant reference); texts
 *  starting with a digit / ' / { / ` are constant literals; expression texts
 *  are constants only when every identifier is a known param/localparam.
 *  Returns null for anything else (caller reports). */
function classifyTo(text: string, scope?: ModScope): "net" | "const" | null {
	const t = text.trim();
	if (t === "") return null;
	if (IDENT.test(t)) {
		return scope && (scope.params.has(t) || scope.localparams.has(t))
			? "const"
			: "net";
	}
	if (/^[\d'{`]/.test(t)) return "const";
	const ids = t.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
	if (
		ids.length > 0 &&
		scope &&
		ids.every((s) => scope.params.has(s) || scope.localparams.has(s))
	) {
		return "const";
	}
	return null;
}

/** Direct element children with the given (lowercase) tag name. */
function children(el: Element | Document, tag: string): Element[] {
	const out = [];
	for (const c of el.children ?? []) {
		if ((c.tagName ?? "").toLowerCase() === tag) out.push(c);
	}
	return out;
}

/** First direct child with the given tag, or null. */
function child(el: Element | Document, tag: string): Element | null {
	for (const c of el.children ?? []) {
		if ((c.tagName ?? "").toLowerCase() === tag) return c;
	}
	return null;
}

/** Element descendants with the given tag (document order). */
function all(el: Element | Document, tag: string): Element[] {
	return [...el.querySelectorAll(tag)];
}

function attr(el: Element, name: string): string | null {
	return el.getAttribute(name);
}

// ---------------------------------------------------------------------------
// Hook registry. Author <script type="module"> registers via aw.on(phase, fn).
// Registries are per connect unit: the page brackets script execution with
// beginUnitHooks(id) / endUnitHooks() so dep units never leak hooks into
// each other's documents.
// ---------------------------------------------------------------------------

const unitHooks = new Map<string, Record<HookPhase, HookFn[]>>(); // unitId → {phase: [fn]}
let currentUnit = "";

export function beginUnitHooks(unitId: string): void {
	currentUnit = unitId;
	if (!unitHooks.has(unitId)) {
		unitHooks.set(unitId, {
			"before-instances": [],
			"on-template": [],
			"before-dump": [],
		});
	}
}

export function endUnitHooks(): void {
	currentUnit = "";
}

export function clearUnitHooks(unitId: string): void {
	unitHooks.delete(unitId);
}

export function on(phase: HookPhase, fn: HookFn): void {
	if (!HOOK_PHASES.includes(phase)) {
		throw new Error(
			`aw.on: unknown phase "${phase}" (expected ${HOOK_PHASES.join(" | ")})`,
		);
	}
	if (typeof fn !== "function")
		throw new Error("aw.on: callback must be a function");
	if (!currentUnit)
		throw new Error(
			"aw.on: no active unit (scripts run inside a connect unit)",
		);
	unitHooks.get(currentUnit)?.[phase].push(fn);
	if (!unitHooks.has(currentUnit)) {
		// Defensive: beginUnitHooks normally ran first.
		beginUnitHooks(currentUnit);
		unitHooks.get(currentUnit)![phase].push(fn);
	}
}

function hooksFor(unitId: string): Record<HookPhase, HookFn[]> {
	return (
		unitHooks.get(unitId) ?? {
			"before-instances": [],
			"on-template": [],
			"before-dump": [],
		}
	);
}

/** Public: run a unit's before-dump hooks (read-only by contract). */
export function runBeforeDump(doc: Document, unitId?: string): void {
	for (const fn of hooksFor(unitId ?? "")["before-dump"]) fn({ doc });
}

// ---------------------------------------------------------------------------
// Variable expressions: ${id} ${idx} ${mod} + module params/localparams.
// Regex captures ($1, $&, $<name>) are legal only in aw-rewrite@to and are
// applied by String.replace BEFORE ${…} substitution (connect-html §3.4.1).
// ---------------------------------------------------------------------------

const CAPTURE_RE = /\$\d|\$&|\$</;

/** Prepass: run every aw-mod's before-instances hooks (they mutate aw-content).
 *  Callers run this BEFORE pre-fetching leaf tables so generated instances are
 *  visible to ctx. Elaboration itself does not invoke these hooks. */
export function runBeforeInstances(doc: Document, unitId?: string): void {
	const hooks = hooksFor(unitId ?? "");
	for (const mod of all(doc, "aw-mod")) {
		for (const fn of hooks["before-instances"]) fn({ mod, doc });
	}
}
function substVars(
	text: string,
	vars: Record<string, string>,
	res: CheckResult,
	where: string,
): string {
	return text.replace(/\$\{([^}]*)\}/g, (_m, name) => {
		const key = name.trim();
		if (Object.hasOwn(vars, key)) return String(vars[key]);
		res.errors.push(`${where}: unknown variable \${${key}}`);
		return "";
	});
}

function rejectCaptures(text: string, res: CheckResult, where: string): void {
	if (CAPTURE_RE.test(text)) {
		res.errors.push(
			`${where}: regex captures ($1 / $& / $<name>) are only allowed in aw-rewrite@to`,
		);
	}
}

// ---------------------------------------------------------------------------
// Parameter folding (connect-rules §7, corrected): module params are
// overridable by parents, so they are NEVER folded into uniquified
// localparams — an aw-param@expr that is a module-param name stays symbolic
// (localparam = the param name; tracks overrides). Constants fold; internal
// localparams fold only when their chain ends at a constant (a chain that
// reaches a module param is not constant). Expressions and macros never fold.
// ---------------------------------------------------------------------------

function classifyExpr(
	expr: string,
	scope: ModScope,
): { folded: boolean; value: string } {
	const text = expr.trim();
	if (text.includes("`")) return { folded: false, value: text };
	if (LITERAL.test(text)) return { folded: true, value: text };
	if (IDENT.test(text)) {
		const lp = scope.localparams.get(text);
		if (lp?.folded) return { folded: true, value: lp.resolved ?? lp.value };
		// Module param (overridable) or unknown identifier: keep the text.
		return { folded: false, value: text };
	}
	return { folded: false, value: text };
}

/** Substitute leaf-param symbols in a port dimension expression (§7.4).
 *  Overridden params become Mod__Inst__Param; unoverridden params inline their
 *  default (parenthesized). Runs to a fixpoint because a default may itself
 *  reference another param (e.g. BinWidth = $clog2(OnehotWidth)). */
function rewriteDims(
	text: string | null,
	instParams: Map<string, { expr: string; uniq: string; renderValue: string }>,
	uniqName: (p: { expr: string; uniq: string; renderValue: string }) => string,
	leafParams: Map<string, ParamFacts>,
	res: CheckResult,
	where: string,
): string | null {
	if (!text) return text;
	const once = (t: string): string =>
		t.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (sym: string) => {
			if (instParams.has(sym)) return uniqName(instParams.get(sym)!);
			const leaf = leafParams.get(sym);
			if (leaf) {
				const def = leaf.defaultText ?? leaf.value ?? null;
				if (def == null) {
					res.errors.push(
						`${where}: port dimension references leaf param ${sym} with no default and no aw-param override`,
					);
					return sym;
				}
				return `(${def})`;
			}
			return sym;
		});
	let t = text;
	for (let i = 0; i < 4; i++) {
		const next = once(t);
		if (next === t) break;
		t = next;
	}
	return t;
}

// ---------------------------------------------------------------------------
// Model extraction helpers.
// ---------------------------------------------------------------------------

/** Author module scope: params + internal localparams of one aw-mod.
 *  Entries: value = author text; localparams may carry folded + resolved when
 *  their identifier chain ends at a constant WITHOUT crossing a module param
 *  (params are overridable, so they terminate the chain unfolded). */
function moduleScope(content: Element): ModScope {
	const params = new Map();
	for (const p of children(
		child(content, "aw-params") ?? content,
		"aw-param",
	)) {
		const name = attr(p, "name");
		const expr = (attr(p, "expr") ?? "").trim();
		if (name) params.set(name, { value: expr, folded: false });
	}
	const localparams = new Map();
	for (const lp of children(
		child(content, "aw-localparams") ?? content,
		"aw-localparam",
	)) {
		const name = attr(lp, "name");
		const expr = (attr(lp, "expr") ?? "").trim();
		if (name)
			localparams.set(name, {
				value: expr,
				folded: LITERAL.test(expr) && !expr.includes("`"),
			});
	}
	// Chase localparam-only identifier chains to constants (§7.2).
	// `value` keeps the author text; `resolved` holds the chased constant.
	const chase = (entry: ScopeEntry): void => {
		const seen = new Set();
		let cur = entry;
		while (!cur.folded && IDENT.test(cur.value) && !seen.has(cur.value)) {
			seen.add(cur.value);
			const nxt = localparams.get(cur.value);
			if (!nxt) break; // param or unknown: overridable / opaque — stop
			if (nxt.folded) {
				entry.resolved = nxt.resolved ?? nxt.value;
				entry.folded = true;
				break;
			}
			cur = nxt;
		}
	};
	for (const v of localparams.values()) chase(v);
	return { params, localparams };
}

/** Library templates of one aw-mod (aw-content/aw-templates). */
function templateLib(content: Element): Map<string, Element> {
	const lib = new Map();
	const group = child(content, "aw-templates");
	if (!group) return lib;
	for (const t of children(group, "aw-template")) {
		const name = attr(t, "name");
		if (name) lib.set(name, t);
	}
	return lib;
}

// ---------------------------------------------------------------------------
// check: author-face (aw-content + aw-submods + deps). Never writes, never
// consults aw-render. ctx = { leaf(mod), wrapper(mod), unitMods: Map, unitDeps: [] }
// ---------------------------------------------------------------------------

export function check(doc: Document, ctx: EngineCtx = {}): CheckResult {
	const res: CheckResult = { errors: [], warnings: [] };
	const roots = all(doc, "autowire").filter((e) => !e.closest("aw-mod"));
	if (roots.length === 0) res.errors.push("document: missing <autowire> root");
	if (roots.length > 1)
		res.errors.push("document: more than one top-level <autowire> root");
	const root = roots[0];
	if (!root) return res;
	for (const mod of children(root, "aw-mod"))
		checkMod(mod, ctx, res, [], new Set());
	checkUnitRefs(doc, ctx, res);
	return res;
}

function checkUnitRefs(doc: Document, ctx: EngineCtx, res: CheckResult): void {
	if (!ctx.unitMods) return;
	const deps = new Set(ctx.unitDeps ?? []);
	const used = new Set();
	for (const inst of all(doc, "aw-inst")) {
		const target = attr(inst, "mod") ?? "";
		const owner = ctx.unitMods!.get(target);
		if (owner && owner !== ctx.unitId) {
			used.add(owner);
			if (!deps.has(owner)) {
				res.errors.push(
					`aw-inst mod="${target}": defined by unit "${owner}" but not listed in [connect.${ctx.unitId}] deps`,
				);
			}
		}
	}
	for (const d of deps) {
		if (!used.has(d))
			res.warnings.push(
				`[connect.${ctx.unitId}] deps: "${d}" declared but never referenced`,
			);
	}
}

function checkMod(
	mod: Element,
	ctx: EngineCtx,
	res: CheckResult,
	path: string[],
	visibleFromAbove: Set<string>,
): void {
	const name = attr(mod, "name");
	const here = [...path, name ?? "?"];
	const where = `aw-mod ${here.join(".")}`;
	if (!name) res.errors.push(`${where}: missing name`);
	const content = child(mod, "aw-content");
	const submods = child(mod, "aw-submods");
	if (!content) res.errors.push(`${where}: missing aw-content`);
	if (content) checkContent(content, ctx, res, here, mod, visibleFromAbove);
	if (submods) {
		const sibs = children(submods, "aw-mod");
		const sibNames = new Set(sibs.map((s) => attr(s, "name")));
		// deps graph: known same-parent siblings, no self-dep, acyclic.
		const depsOf = new Map<string, string[]>();
		for (const s of sibs) {
			const deps = (attr(s, "deps") ?? "").split(/[\s,]+/).filter(Boolean);
			depsOf.set(attr(s, "name") ?? "", deps);
			for (const d of deps) {
				if (d === attr(s, "name"))
					res.errors.push(`${where}: aw-mod "${d}" depends on itself`);
				else if (!sibNames.has(d))
					res.errors.push(
						`${where}: aw-mod "${attr(s, "name")}" deps: unknown sibling "${d}"`,
					);
			}
		}
		assertAcyclic(depsOf, res, where);
		// Path-accumulated visible set for children:
		//   visibleFromAbove ∪ this.mod.deps
		// Each sibling gets the same ancestor set; a sibling's own deps are
		// applied in checkContent / when that sibling descends further.
		// Do NOT fold other siblings' deps into the shared set (html.md §3.3).
		const parentDeps = (attr(mod, "deps") ?? "")
			.split(/[\s,]+/)
			.filter(Boolean);
		const forChildren = new Set(visibleFromAbove);
		for (const d of parentDeps) forChildren.add(d);
		for (const s of sibs) checkMod(s, ctx, res, here, new Set(forChildren));
	}
}

function assertAcyclic(
	depsOf: Map<string, string[]>,
	res: CheckResult,
	where: string,
): void {
	const state = new Map(); // name → 1 visiting | 2 done
	const visit = (n: string, stack: string[]): void => {
		if (state.get(n) === 2) return;
		if (state.get(n) === 1) {
			res.errors.push(`${where}: deps cycle (${[...stack, n].join(" → ")})`);
			return;
		}
		state.set(n, 1);
		for (const d of depsOf.get(n) ?? [])
			if (depsOf.has(d)) visit(d, [...stack, n]);
		state.set(n, 2);
	};
	for (const n of depsOf.keys()) visit(n, []);
}

function checkContent(
	content: Element,
	ctx: EngineCtx,
	res: CheckResult,
	path: string[],
	mod: Element,
	visibleFromAbove: Set<string>,
): void {
	const where = `aw-mod ${path.join(".")}`;
	const scope = moduleScope(content);
	// Unknown groups / misplaced children.
	for (const c of content.children ?? []) {
		const tag = (c.tagName ?? "").toLowerCase();
		if (!CONTENT_GROUPS.includes(tag))
			res.errors.push(`${where}: unexpected <${tag}> under aw-content`);
	}
	for (const g of CONTENT_GROUPS) {
		const group = child(content, g);
		if (!group) continue;
		for (const c of group.children ?? []) {
			const tag = (c.tagName ?? "").toLowerCase();
			if (tag !== (GROUP_CHILD as Record<string, string>)[g])
				res.errors.push(`${where}: <${tag}> not allowed under ${g}`);
		}
	}
	const lib = templateLib(content);
	const modVars: Record<string, string> = {};
	for (const [k, v] of scope.params) modVars[k] = v.value;
	for (const [k, v] of scope.localparams) modVars[k] = v.value;
	// Template library legality.
	for (const [tname, t] of lib)
		checkTemplate(t, ctx, res, `${where} template "${tname}"`, lib, scope);
	// Instances.
	const sibs = children(child(mod, "aw-submods") ?? mod, "aw-mod");
	const ownChildren = new Set(sibs.map((s) => attr(s, "name")));
	const ownDeps = (attr(mod, "deps") ?? "").split(/[\s,]+/).filter(Boolean);
	const visible = new Set([...visibleFromAbove, ...ownDeps]);
	const usedDeps = new Set();
	for (const inst of children(
		child(content, "aw-insts") ?? content,
		"aw-inst",
	)) {
		const id = attr(inst, "id");
		const target = attr(inst, "mod") ?? "";
		const iwhere = `${where} aw-inst "${id ?? "?"}"`;
		if (!id) res.errors.push(`${iwhere}: missing id`);
		if (!target) res.errors.push(`${iwhere}: missing mod`);
		// Only aw-template may live under aw-inst (connect-rules §1).
		for (const c of inst.children ?? []) {
			const tag = (c.tagName ?? "").toLowerCase();
			if (tag !== "aw-template")
				res.errors.push(`${iwhere}: <${tag}> must be wrapped in <aw-template>`);
		}
		// Target resolution: RtlIndex leaf | own child wrapper | visible sibling | dep unit.
		if (target) {
			const isLeaf = ctx.leaf?.(target) != null;
			const isChild = ownChildren.has(target);
			const isUnitMod =
				ctx.unitMods?.get(target) && ctx.unitMods.get(target) !== ctx.unitId;
			if (!isLeaf && !isChild && !isUnitMod) {
				if (visible.has(target)) usedDeps.add(target);
				else
					res.errors.push(
						`${iwhere}: mod "${target}" is not a RtlIndex leaf, not a child aw-mod, and not in the visible set (add it to aw-mod@deps)`,
					);
			}
			if (isLeaf) checkLeafInst(inst, ctx.leaf?.(target) ?? null, res, iwhere);
		}
		for (const t of children(inst, "aw-template")) {
			checkTemplate(t, ctx, res, `${iwhere} template`, lib, scope);
			const base = attr(t, "base");
			if (base && !lib.has(base))
				res.errors.push(
					`${iwhere}: unknown template base "${base}" (templates are per-aw-mod)`,
				);
		}
	}
	for (const d of ownDeps) {
		if (!usedDeps.has(d)) {
			res.warnings.push(`${where}: deps "${d}" declared but never referenced`);
		}
	}
}
function checkLeafInst(
	inst: Element,
	leaf: ModFacts | null,
	res: CheckResult,
	where: string,
): void {
	const leafParams = new Map((leaf?.params ?? []).map((p) => [p.name, p]));
	const leafPorts = new Set((leaf?.ports ?? []).map((p) => p.name));
	for (const t of children(inst, "aw-template")) {
		for (const r of walkRules(t)) {
			const tag = (r.tagName ?? "").toLowerCase();
			if (tag === "aw-param") {
				const name = attr(r, "name");
				const lp = leafParams.get(name ?? "");
				if (leaf && name && !lp) {
					res.errors.push(
						`${where}: aw-param "${name}" does not exist on module ${attr(inst, "mod")}`,
					);
				} else if (lp?.kind === "localparam") {
					res.errors.push(
						`${where}: aw-param "${name}" is a localparam on ${attr(inst, "mod")} (not overridable)`,
					);
				}
			}
			if (tag === "aw-connect") {
				const port = attr(r, "port");
				if (leaf && port && !leafPorts.has(port)) {
					res.errors.push(
						`${where}: aw-connect port "${port}" does not exist on module ${attr(inst, "mod")}`,
					);
				}
			}
		}
	}
}

function* walkRules(tpl: Element): Generator<Element, void, unknown> {
	for (const r of tpl.children ?? []) {
		const tag = (r.tagName ?? "").toLowerCase();
		if (["aw-param", "aw-connect", "aw-rewrite"].includes(tag)) yield r;
	}
}

function checkTemplate(
	t: Element,
	ctx: EngineCtx,
	res: CheckResult,
	where: string,
	lib: Map<string, Element>,
	scope: ModScope,
): void {
	const modVars: Record<string, string> = {};
	for (const [k, v] of scope.params) modVars[k] = v.value;
	for (const [k, v] of scope.localparams) modVars[k] = v.value;
	// Probe substitution stands variables for plausible text so `to` can be
	// classified at check time (docs/connect/to-rules.md §2.2).
	const probeVars = { id: "u", idx: "0", mod: "m", ...modVars };
	const probeTo = (r: Element): string | null => {
		const raw = attr(r, "to");
		if (!raw) return null;
		const probe: CheckResult = { errors: [], warnings: [] };
		const text = substVars(raw, probeVars, probe, `${where} @to`);
		res.errors.push(...probe.errors);
		return text;
	};
	for (const r of walkRules(t)) {
		const tag = (r.tagName ?? "").toLowerCase();
		if (tag === "aw-rewrite" || tag === "aw-connect") {
			const isOpen = attr(r, "type") === "open";
			if (tag === "aw-rewrite" && !attr(r, "match"))
				res.errors.push(`${where}: aw-rewrite missing match`);
			if (tag === "aw-connect" && !attr(r, "port"))
				res.errors.push(`${where}: aw-connect missing port`);
			if (tag === "aw-rewrite") {
				try {
					new RegExp(attr(r, "match") ?? "", attr(r, "flags") ?? "");
				} catch (e) {
					res.errors.push(
						`${where}: aw-rewrite bad RegExp: ${(e as Error).message}`,
					);
				}
			}
			if (isOpen) {
				// Explicit dangling pin: no to / part / dims / nettype.
				for (const a of [
					"to",
					"part",
					"packed",
					"width",
					"unpacked",
					"nettype",
				]) {
					if (attr(r, a)) {
						res.errors.push(`${where}: type="open" takes no @${a}`);
					}
				}
				continue; // nothing else applies
			}
			if (!attr(r, "to")) {
				res.errors.push(
					`${where}: ${tag} missing to (declare type="open" for a dangling pin)`,
				);
				continue;
			}
			if (tag === "aw-connect")
				rejectCaptures(attr(r, "to") ?? "", res, `${where} aw-connect@to`);
			const rawText = probeTo(r);
			// rewrite captures ($1/$&/$<name>) stand in for net-name fragments
			const text =
				tag === "aw-rewrite" && rawText != null
					? rawText.replace(/\$<[^>]*>|\$\d+|\$&/g, "x")
					: rawText;
			if (text == null) continue;
			const kind = classifyTo(text, scope);
			if (kind == null) {
				res.errors.push(
					`${where} ${tag}@to: "${text}" is neither a net name nor a constant`,
				);
			} else if (kind === "net") {
				checkNetName(text, res, `${where} ${tag}@to`);
			} else {
				// const: no captures in rewrite tie-offs; no part/dims anywhere.
				if (tag === "aw-rewrite" && CAPTURE_RE.test(attr(r, "to") ?? "")) {
					res.errors.push(
						`${where}: aw-rewrite@to is a constant but uses regex captures`,
					);
				}
				if (attr(r, "part")) {
					res.errors.push(`${where}: part-select on a constant is not allowed`);
				}
				for (const a of ["packed", "width", "unpacked", "nettype"]) {
					if (attr(r, a)) {
						res.errors.push(`${where}: @${a} does not apply to a constant`);
					}
				}
			}
			checkTypeAttr(r, kind, res, where);
		}
		if (tag === "aw-param") {
			if (!attr(r, "name")) res.errors.push(`${where}: aw-param missing name`);
			rejectCaptures(attr(r, "expr") ?? "", res, `${where} aw-param@expr`);
		}
		// Dimension/part attributes: variables OK, captures forbidden, width XOR packed.
		const packed = attr(r, "packed");
		const width = attr(r, "width");
		if (
			packed &&
			width &&
			packed !== "auto" &&
			width !== "auto" &&
			packed !== width
		) {
			res.errors.push(
				`${where}: packed="${packed}" conflicts with width="${width}"`,
			);
		}
		for (const a of ["packed", "width", "unpacked", "part"]) {
			const v = attr(r, a);
			if (v) rejectCaptures(v, res, `${where} @${a}`);
		}
		// Variable sanity (`to` is covered by probeTo above): ${…} names must
		// be id/idx/mod or module params/localparams.
		for (const a of [
			"expr",
			"packed",
			"width",
			"unpacked",
			"part",
			"inst_name",
		]) {
			const v = attr(r, a);
			if (!v) continue;
			const probe: CheckResult = { errors: [], warnings: [] };
			substVars(
				v,
				{ id: "", idx: "", mod: "", ...modVars },
				probe,
				`${where} @${a}`,
			);
			res.errors.push(...probe.errors);
		}
	}
	const instName = attr(t, "inst_name");
	if (instName) {
		rejectCaptures(instName, res, `${where} @inst_name`);
		const probe: CheckResult = { errors: [], warnings: [] };
		substVars(
			instName,
			{ id: "", idx: "", mod: "", ...modVars },
			probe,
			`${where} @inst_name`,
		);
		res.errors.push(...probe.errors);
	}
	const nettype = attr(t, "nettype");
	for (const r of walkRules(t)) {
		const nt = attr(r, "nettype");
		if (nt && nt !== "wire" && nt !== "logic") {
			res.errors.push(`${where}: nettype "${nt}" must be wire|logic`);
		}
	}
	void nettype;
	void lib;
	void ctx;
}

/** type attribute: defaults to "net"; const/open must be declared explicitly. */
function checkTypeAttr(
	r: Element,
	kind: "net" | "const" | null,
	res: CheckResult,
	where: string,
): void {
	const asserted = attr(r, "type");
	if (asserted != null && !["net", "const", "open"].includes(asserted)) {
		res.errors.push(
			`${where}: type must be "net", "const" or "open", got "${asserted}"`,
		);
		return;
	}
	if (asserted != null && kind != null && asserted !== kind) {
		res.errors.push(
			`${where}: type="${asserted}" but to classifies as ${kind}`,
		);
	} else if (kind === "const" && asserted == null) {
		res.errors.push(
			`${where}: constant must be declared type="const" (type defaults to net)`,
		);
	}
}

function checkNetName(
	to: string | null,
	res: CheckResult,
	where: string,
): void {
	if (!to) return;
	if (/[[\]]/.test(to))
		res.errors.push(
			`${where}: "${to}" must be a bare net name (no [] / part-select)`,
		);
}

// ---------------------------------------------------------------------------
// elaboration. Caller guarantees check() passed. Order (connect-html §5,
// corrected): before-instances → params → submods (deps topo) → template
// expand (+ on-template) → wires → frozen aw-render. Children before parent
// wires because aw-inst@mod may target a child wrapper's render ports.
// ---------------------------------------------------------------------------

const frozen = new WeakSet();

export function isFrozen(renderEl: Element): boolean {
	return frozen.has(renderEl);
}

export function elaborate(doc: Document, ctx: EngineCtx = {}): CheckResult {
	const res: CheckResult = { errors: [], warnings: [] };
	const root = all(doc, "autowire").filter((e) => !e.closest("aw-mod"))[0];
	if (!root) {
		res.errors.push("document: missing <autowire> root");
		return res;
	}
	const hooks = hooksFor(ctx.unitId ?? "");
	for (const mod of children(root, "aw-mod")) {
		elaborateMod(mod, ctx, res, [], hooks, new Map());
	}
	return res;
}

/** Elaborate one aw-mod; fills and freezes its aw-render. Returns render facts. */
function elaborateMod(
	mod: Element,
	ctx: EngineCtx,
	res: CheckResult,
	path: string[],
	hooks: Record<HookPhase, HookFn[]>,
	sibRenders: Map<string, ModFacts>,
): ModFacts | null {
	const name = attr(mod, "name") ?? "?";
	const here = [...path, name];
	const where = `aw-mod ${here.join(".")}`;
	const content = child(mod, "aw-content");
	if (!content) {
		res.errors.push(`${where}: missing aw-content`);
		return null;
	}
	const scope = moduleScope(content);

	// Children first (deps topological order among siblings).
	const submods = child(mod, "aw-submods");
	const childRenders = new Map<string, ModFacts>();
	if (submods) {
		const sibs = children(submods, "aw-mod");
		const depsOf = new Map<string, string[]>(
			sibs.map((s) => [
				attr(s, "name") ?? "",
				(attr(s, "deps") ?? "").split(/[\s,]+/).filter(Boolean),
			]),
		);
		for (const s of topoOrder(depsOf)) {
			const el = sibs.find((x) => attr(x, "name") === s)!;
			const facts = elaborateMod(el, ctx, res, here, hooks, childRenders);
			if (facts) childRenders.set(s, facts);
		}
	}
	for (const [k, v] of sibRenders)
		if (!childRenders.has(k)) childRenders.set(k, v);

	// Instances: params → inst_name → template expand → wires.
	const lib = templateLib(content);
	const instsGroup = child(content, "aw-insts");
	const instEls = instsGroup ? children(instsGroup, "aw-inst") : [];
	const renderInsts: RenderInstDraft[] = [];
	const seenInstNames = new Set<string>();
	const uniqLocalparams: UniqLp[] = [];
	const usedUniqNames = new Set<string>();
	const portOrderOf = (target: string): string[] => {
		const leaf = ctx.leaf?.(target);
		if (leaf) return leaf.ports.map((p) => p.name);
		const w = childRenders.get(target) ?? ctx.wrapper?.(target);
		return (w?.ports ?? []).map((p: PortFacts) => p.name);
	};

	for (const inst of instEls) {
		const id = attr(inst, "id") ?? "?";
		const target = attr(inst, "mod") ?? "";
		const iwhere = `${where} aw-inst "${id}"`;
		const vars: Record<string, string> = {
			id,
			idx: attr(inst, "idx") ?? "0",
			mod: target,
		};
		for (const [k, v] of scope.params) vars[k] = v.resolved ?? v.value;
		for (const [k, v] of scope.localparams) vars[k] = v.resolved ?? v.value;
		// Effective rule chain: document order; base chain first, own rules after.
		const chain: Element[] = [];
		for (const t of children(inst, "aw-template"))
			expandTemplate(t, lib, chain, res, iwhere, new Set());
		// inst_name: last template in chain that sets it wins; default ${id}.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: dialect variable syntax, not JS
		let instNameTpl = "${id}";
		for (const t of chain) {
			const v = attr(t, "inst_name");
			if (v) instNameTpl = v;
		}
		const instName = substVars(instNameTpl, vars, res, `${iwhere} @inst_name`);
		if (seenInstNames.has(instName)) {
			res.errors.push(
				`${iwhere}: expanded instance name "${instName}" is not unique under ${where}`,
			);
			continue;
		}
		seenInstNames.add(instName);
		// Params: later rule wins per name.
		const paramRules = new Map();
		for (const t of chain) {
			for (const r of walkRules(t)) {
				if ((r.tagName ?? "").toLowerCase() === "aw-param")
					paramRules.set(attr(r, "name"), attr(r, "expr") ?? "");
			}
		}
		// [style] param_inline (autowire.toml): true (default) writes
		// NON-EXPRESSION overrides (literal / single identifier ref to a module
		// param or localparam / macro) into the instance. Anything containing
		// ANY operator (concat {}, arithmetic, ternary, …) always folds into a
		// Mod__Inst__Param localparam; param_inline = false folds everything.
		const inlineParams = ctx.style?.paramInline !== false;
		const instParams = new Map<
			string,
			{ expr: string; uniq: string; renderValue: string }
		>();
		for (const [pname, expr0] of paramRules) {
			const expr = substVars(expr0, vars, res, `${iwhere} aw-param "${pname}"`);
			const cls = classifyExpr(expr, scope);
			const uniq0 = `${name}__${instName}__${pname}`;
			const uniq = ctx.style?.localparamUpper ? uniq0.toUpperCase() : uniq0;
			const simple =
				LITERAL.test(cls.value) ||
				IDENT.test(cls.value) ||
				/^`[A-Za-z_]\w*$/.test(cls.value);
			if (inlineParams && simple) {
				// Inline: dims rewrite substitutes the parenthesized expression.
				instParams.set(pname, {
					expr: cls.value,
					uniq: `(${cls.value})`,
					renderValue: cls.value,
				});
				continue;
			}
			if (usedUniqNames.has(uniq)) {
				res.errors.push(`${iwhere}: localparam ${uniq} generated twice`);
				continue;
			}
			usedUniqNames.add(uniq);
			instParams.set(pname, { expr: cls.value, uniq, renderValue: uniq });
			uniqLocalparams.push({
				name: uniq,
				value: cls.value,
				folded: cls.folded,
				forInst: instName,
				forParam: pname,
			});
		}
		// Port table for the target (leaf RtlIndex or elaborated wrapper).
		const targetFacts =
			ctx.leaf?.(target) ??
			childRenders.get(target) ??
			ctx.wrapper?.(target) ??
			null;
		if (!targetFacts) {
			res.errors.push(
				`${iwhere}: unknown module "${target}" (no RtlIndex leaf and no elaborated wrapper)`,
			);
			continue;
		}
		const ports = targetFacts.ports ?? [];
		const leafParams = new Map(
			(targetFacts?.params ?? []).map((p) => [p.name, p]),
		);
		for (const pname of instParams.keys()) {
			const target2 = leafParams.get(pname);
			if (!target2) {
				res.errors.push(
					`${iwhere}: aw-param "${pname}" does not exist on module ${target}`,
				);
			} else if (target2.kind === "localparam") {
				res.errors.push(
					`${iwhere}: aw-param "${pname}" is a localparam on ${target} (not overridable)`,
				);
			}
		}
		const connects = new Map();
		for (const t of chain) {
			for (const r of walkRules(t)) {
				const tag = (r.tagName ?? "").toLowerCase();
				if (tag === "aw-connect" || tag === "aw-rewrite") {
					if (attr(r, "type") === "open") {
						// Explicit dangling pin (connect-to-rules): no to, no net.
						if (tag === "aw-connect") {
							connects.set(attr(r, "port"), {
								open: true,
								to: null,
								part: null,
							});
						} else {
							let re: RegExp;
							try {
								re = new RegExp(attr(r, "match") ?? "", attr(r, "flags") ?? "");
							} catch {
								continue; // already reported by check
							}
							for (const p of ports) {
								if (re.test(p.name))
									connects.set(p.name, { open: true, to: null, part: null });
							}
						}
						continue;
					}
				}
				if (tag === "aw-connect") {
					const cport = attr(r, "port") ?? "?";
					connects.set(
						cport,
						ruleToConnect(r, cport, vars, res, iwhere, null, scope),
					);
				} else if (tag === "aw-rewrite") {
					let re: RegExp;
					try {
						re = new RegExp(attr(r, "match") ?? "", attr(r, "flags") ?? "");
					} catch {
						continue; // already reported by check
					}
					for (const p of ports) {
						if (!re.test(p.name)) continue;
						const net = p.name.replace(re, attr(r, "to") ?? "");
						connects.set(
							p.name,
							ruleToConnect(r, p.name, vars, res, iwhere, net, scope),
						);
					}
				}
			}
		}
		// on-template hooks see and may edit the intermediate connect list.
		const intermediate = [...connects.entries()].map(([port, c]) => ({
			port,
			...c,
		}));
		for (const fn of hooks["on-template"])
			fn({
				mod,
				inst,
				template: chain[chain.length - 1] ?? null,
				connects: intermediate,
			});
		connects.clear();
		for (const c of intermediate) {
			const { port, ...rest } = c;
			connects.set(port, rest);
		}
		// Uncovered ports auto-connect to a same-named net (authoring rule:
		// identity connections are inferred, not written — the author only
		// describes non-identity information; explicit rules and type="open"
		// always win). Interface ports are never auto-wired.
		for (const p of ports) {
			if (connects.has(p.name) || p.dir === "interface") continue;
			connects.set(p.name, {
				to: p.name,
				packed: null,
				width: null,
				unpacked: null,
				part: null,
				nettype: null,
				isConst: false,
			});
		}
		renderInsts.push({
			id: instName,
			mod: target,
			params: instParams,
			connects,
			order: portOrderOf(target),
			leafParams,
		});
	}

	// Dimension substitution map for semantic comparison and export-port
	// folding: internal localparams → their text; uniquified localparams →
	// their value text (constant, param name, or expression). Module params
	// stay symbolic (overridable). After substitution, constants collapse via
	// module's uniquified localparams — they substitute to self-contained text.
	const dimVals = new Map();
	for (const [k, v] of scope.localparams) dimVals.set(k, v.resolved ?? v.value);
	for (const lp of uniqLocalparams) dimVals.set(lp.name, lp.value);

	// Wires: signals + auto-export ports.
	const signals = new Map<string, SignalEntry>();
	const netDirs = new Map<string, Set<string>>(); // net → Set of connected port directions
	// Full-net (no part-select) output drivers per net; >1 is a short circuit.
	// Part-select drivers may share a net (disjointness not verified).
	const fullDrivers = new Map<string, number>();
	for (const ri of renderInsts) {
		const targetFacts =
			ctx.leaf?.(ri.mod) ??
			childRenders.get(ri.mod) ??
			ctx.wrapper?.(ri.mod) ??
			null;
		const portFacts = new Map(
			(targetFacts?.ports ?? []).map((p) => [p.name, p]),
		);
		for (const [port, c] of ri.connects) {
			const pf = portFacts.get(port);
			if (c.open) {
				// Explicit dangling pin: output/inout only (inputs must tie off).
				if (pf && pf.dir !== "output" && pf.dir !== "inout") {
					res.errors.push(
						`${where} port "${port}": open is only allowed on output/inout (got ${pf.dir}; tie inputs off with type="const")`,
					);
				}
				continue;
			}
			if (c.isConst) {
				// Constants drive input ports only; no net is created.
				if (pf?.dir !== "input") {
					res.errors.push(
						`${where} port "${port}": constant "${c.to}" drives a ${pf?.dir ?? "unknown-dir"} port (inputs only)`,
					);
				}
				continue;
			}
			const net0 = c.to ?? "";
			if (pf?.dir === "output" && c.part == null)
				fullDrivers.set(net0, (fullDrivers.get(net0) ?? 0) + 1);
			const dirs = netDirs.get(net0) ?? new Set();
			dirs.add(pf?.dir ?? "input");
			netDirs.set(net0, dirs);
			const dims = resolveDims(c, pf, ri, name, res, `${where} port "${port}"`);
			mergeSignal(signals, net0, dims, dimVals, res, `${where} port "${port}"`);
		}
	}
	for (const [net, n] of fullDrivers)
		if (n > 1)
			res.errors.push(
				`${where}: net "${net}" has ${n} full-net output drivers (short circuit)`,
			);

	// Export ports: author explicit first, then auto-export.
	const foldPortDims = (packed: string | null, unpacked: string | null) => ({
		packed: packed ? canonicalDims(foldDims(packed, dimVals)) : null,
		unpacked: unpacked ? canonicalDims(foldDims(unpacked, dimVals)) : null,
	});
	const portsOut: PortOut[] = [];
	const explicit = new Set();
	const portsGroup = child(content, "aw-ports");
	for (const p of portsGroup ? children(portsGroup, "aw-port") : []) {
		const pname = attr(p, "name");
		if (!pname) continue;
		explicit.add(pname);
		const folded = foldPortDims(
			attr(p, "packed") ?? signals.get(pname)?.packed ?? null,
			attr(p, "unpacked") ?? signals.get(pname)?.unpacked ?? null,
		);
		portsOut.push({
			name: pname,
			dir: attr(p, "dir") ?? "input",
			packed: folded.packed,
			unpacked: folded.unpacked,
			nettype: attr(p, "nettype") ?? null,
			interface: attr(p, "interface") ?? null,
			modport: attr(p, "modport") ?? null,
		});
	}
	for (const [net, sig] of signals) {
		if (explicit.has(net)) continue;
		const dirs = netDirs.get(net) ?? new Set();
		let dir = null;
		if (dirs.has("inout")) dir = "inout";
		else if ([...dirs].every((d) => d === "input")) dir = "input";
		else if ([...dirs].every((d) => d === "output")) dir = "output";
		if (!dir) continue; // driven AND consumed internally → internal signal
		const folded = foldPortDims(sig.packed, sig.unpacked);
		portsOut.push({
			name: net,
			dir,
			packed: folded.packed,
			unpacked: folded.unpacked,
			nettype: sig.nettype,
			interface: sig.interface ?? null,
			modport: null,
			auto: true,
		});
	}

	// Collision guard: uniquified localparams vs params/signals (connect-rules §7.5).
	const taken = new Set([
		...scope.params.keys(),
		...scope.localparams.keys(),
		...signals.keys(),
	]);
	for (const lp of uniqLocalparams) {
		if (taken.has(lp.name))
			res.errors.push(
				`${where}: generated localparam ${lp.name} collides with an existing name`,
			);
	}

	// Imports: author + bottom-up from elaborated children, deduped.
	const imports: { package: string; symbol: string }[] = [];
	const seenImports = new Set<string>();
	const addImport = (pkg: string | null, symbol: string | null): void => {
		const key = `${pkg}::${symbol}`;
		if (!pkg || seenImports.has(key)) return;
		seenImports.add(key);
		imports.push({ package: pkg, symbol: symbol ?? "*" });
	};
	const impGroup = child(content, "aw-imports");
	for (const i of impGroup ? children(impGroup, "aw-import") : []) {
		addImport(attr(i, "package"), attr(i, "symbol") ?? "*");
	}
	for (const facts of childRenders.values()) {
		for (const i of facts.imports ?? []) addImport(i.package, i.symbol);
	}
	// Package-qualified leaf port types pull a wildcard import.
	for (const ri of renderInsts) {
		const targetFacts =
			ctx.leaf?.(ri.mod) ??
			childRenders.get(ri.mod) ??
			ctx.wrapper?.(ri.mod) ??
			null;
		for (const p of targetFacts?.ports ?? []) {
			const m = /([A-Za-z_][A-Za-z0-9_]*)::/.exec(p.dataType ?? "");
			if (m) addImport(m[1] ?? null, "*");
		}
	}

	writeRender(mod, {
		scope,
		imports,
		uniqLocalparams,
		portsOut,
		signals,
		renderInsts,
	});
	frozen.add(child(mod, "aw-render")!);
	return {
		name,
		params: [...scope.params.entries()].map(([n, v]) => ({
			name: n,
			value: v.value,
		})),
		ports: portsOut,
		imports,
	};
}

function topoOrder(depsOf: Map<string, string[]>): string[] {
	const out: string[] = [];
	const state = new Map<string, number>();
	const visit = (n: string): void => {
		if (state.get(n) === 2) return;
		if (state.get(n) === 1) return; // cycle already reported by check
		state.set(n, 1);
		for (const d of depsOf.get(n) ?? []) if (depsOf.has(d)) visit(d);
		state.set(n, 2);
		out.push(n);
	};
	for (const n of depsOf.keys()) visit(n);
	return out;
}

function expandTemplate(
	t: Element,
	lib: Map<string, Element>,
	chain: Element[],
	res: CheckResult,
	where: string,
	seen: Set<string>,
): void {
	const base = attr(t, "base");
	if (base) {
		if (seen.has(base)) {
			res.errors.push(`${where}: template base cycle at "${base}"`);
			return;
		}
		const b = lib.get(base);
		if (!b) return; // unknown base reported by check
		seen.add(base);
		expandTemplate(b, lib, chain, res, where, seen);
	}
	chain.push(t);
}

function ruleToConnect(
	r: Element,
	port: string | null,
	vars: Record<string, string>,
	res: CheckResult,
	where: string,
	rewrittenNet: string | null,
	scope: ModScope,
): RuleConnect {
	const to = rewrittenNet ?? attr(r, "to") ?? "";
	const net = substVars(to, vars, res, `${where} connect "${port}"`);
	const sub = (a: string): string | null => {
		const v = attr(r, a);
		return v == null || v === ""
			? null
			: substVars(v, vars, res, `${where} @${a}`);
	};
	const kind = classifyTo(net, scope);
	if (kind == null) {
		res.errors.push(
			`${where} connect "${port}": "${net}" is neither a net name nor a constant`,
		);
	}
	// Optional assertion: type="net|const" must match the inferred kind.
	const asserted = attr(r, "type");
	if (asserted != null && !["net", "const", "open"].includes(asserted)) {
		res.errors.push(
			`${where}: type must be "net", "const" or "open", got "${asserted}"`,
		);
	} else if (asserted === "open") {
		res.errors.push(
			`${where} connect "${port}": type="open" takes no to (did you mean a dangling pin?)`,
		);
	} else if (asserted != null && kind != null && asserted !== kind) {
		res.errors.push(
			`${where} connect "${port}": type="${asserted}" but "${net}" classifies as ${kind}`,
		);
	} else if (kind === "const" && asserted == null) {
		// Constants must be declared (review ruling: type defaults to net).
		res.errors.push(
			`${where} connect "${port}": constant "${net}" must be declared type="const"`,
		);
	}
	// Constant rewrite = batch tie-off: captures are meaningless there.
	if (
		rewrittenNet != null &&
		kind === "const" &&
		CAPTURE_RE.test(attr(r, "to") ?? "")
	) {
		res.errors.push(
			`${where}: aw-rewrite@to is a constant ("${net}") but uses regex captures`,
		);
	}
	const part = evalPart(sub("part"));
	const packed = sub("packed");
	const width = sub("width");
	const unpacked = sub("unpacked");
	const nettype = sub("nettype");
	if (kind === "const") {
		if (part)
			res.errors.push(
				`${where} connect "${port}": part-select on a constant is not allowed`,
			);
		if (packed ?? width ?? unpacked ?? nettype)
			res.errors.push(
				`${where} connect "${port}": packed/width/unpacked/nettype do not apply to constants`,
			);
	}
	return {
		to: net,
		packed,
		width,
		unpacked,
		part,
		nettype,
		isConst: kind === "const",
	};
}

function resolveDims(
	c: RuleConnect,
	portFact: PortFacts | undefined,
	ri: RenderInstDraft,
	modName: string,
	res: CheckResult,
	where: string,
): { packed: string | null; unpacked: string | null; nettype: string | null } {
	const explicitPacked = c.packed && c.packed !== "auto" ? c.packed : null;
	const explicitWidth = c.width && c.width !== "auto" ? c.width : null;
	let packed = explicitPacked ?? explicitWidth ?? null;
	let unpacked = c.unpacked ?? null;
	let nettype = c.nettype ?? null;
	const auto = !packed && !unpacked;
	if (auto && portFact) {
		packed = portFact.packed ?? null;
		unpacked = portFact.unpacked ?? null;
		const dt = /^(logic|wire)\b/.exec(portFact.dataType ?? "");
		if (!nettype && dt) nettype = dt[1] ?? null;
	}
	// §7.4: overridden leaf params become Mod__Inst__Param in copied dims.
	const uniqName = (p: {
		expr: string;
		uniq: string;
		renderValue: string;
	}): string => p.uniq;
	if (packed)
		packed = rewriteDims(
			packed,
			ri.params,
			uniqName,
			ri.leafParams,
			res,
			where,
		);
	if (unpacked)
		unpacked = rewriteDims(
			unpacked,
			ri.params,
			uniqName,
			ri.leafParams,
			res,
			where,
		);
	void modName;
	return {
		packed: canonicalDims(packed),
		unpacked: canonicalDims(unpacked),
		nettype: nettype === "wire" ? null : nettype,
	};
}

function mergeSignal(
	signals: Map<string, SignalEntry>,
	net: string,
	dims: {
		packed: string | null;
		unpacked: string | null;
		nettype: string | null;
	},
	foldVals: Map<string, string>,
	res: CheckResult,
	where: string,
): void {
	const prev = signals.get(net);
	if (!prev) {
		signals.set(net, { name: net, ...dims });
		return;
	}
	// Semantic equality: textual forms that fold to the same constants agree
	// (e.g. [A__Width-1:0] vs [B__Width-1:0] when both fold to [7:0]).
	const norm = (t: string | null) => foldDims(t ?? "", foldVals);
	if (
		norm(prev.packed) !== norm(dims.packed) ||
		norm(prev.unpacked) !== norm(dims.unpacked)
	) {
		res.errors.push(
			`${where}: net "${net}" dimension conflict ([${prev.packed}][${prev.unpacked}] vs [${dims.packed}][${dims.unpacked}])`,
		);
	}
	if (dims.nettype && prev.nettype && dims.nettype !== prev.nettype) {
		res.errors.push(
			`${where}: net "${net}" nettype conflict (${prev.nettype} vs ${dims.nettype})`,
		);
	}
}

/** Write the frozen aw-render for one aw-mod (engine is the only writer). */
function writeRender(mod: Element, m: WriteModel): void {
	let render = child(mod, "aw-render");
	if (!render) {
		render = mod.ownerDocument.createElement("aw-render");
		mod.appendChild(render);
	}
	render.textContent = "";
	const doc = mod.ownerDocument;
	const mk = (
		tag: string,
		attrs: Record<string, string | null | undefined | boolean>,
	): Element => {
		const el = doc.createElement(tag);
		for (const [k, v] of Object.entries(attrs)) {
			if (v != null && v !== "") el.setAttribute(k, String(v));
		}
		return el;
	};
	const groups: Record<string, Element> = {};
	for (const g of RENDER_GROUPS) {
		const el = doc.createElement(g);
		groups[g] = el;
		render.appendChild(el);
	}
	for (const [n, v] of m.scope.params)
		groups["aw-params"]!.appendChild(
			mk("aw-param", { name: n, value: v.value }),
		);
	for (const i of m.imports)
		groups["aw-imports"]!.appendChild(
			mk("aw-import", { package: i.package, symbol: i.symbol }),
		);
	for (const [n, v] of m.scope.localparams) {
		groups["aw-localparams"]!.appendChild(
			mk("aw-localparam", { name: n, value: v.value }),
		);
	}
	for (const lp of m.uniqLocalparams) {
		groups["aw-localparams"]!.appendChild(
			mk("aw-localparam", {
				name: lp.name,
				value: lp.value,
				folded: lp.folded ? "true" : "false",
				"for-inst": lp.forInst,
				"for-param": lp.forParam,
			}),
		);
	}
	for (const p of m.portsOut) {
		groups["aw-ports"]!.appendChild(
			mk("aw-port", {
				name: p.name,
				dir: p.dir,
				packed: p.packed,
				unpacked: p.unpacked,
				nettype: p.nettype,
				interface: p.interface,
				modport: p.modport,
			}),
		);
	}
	for (const s of m.signals.values()) {
		groups["aw-signals"]!.appendChild(
			mk("aw-signal", {
				name: s.name,
				packed: s.packed,
				unpacked: s.unpacked,
				nettype: s.nettype,
			}),
		);
	}
	for (const ri of m.renderInsts) {
		const el = mk("aw-inst", { id: ri.id, mod: ri.mod });
		for (const [pname, p] of ri.params)
			el.appendChild(mk("aw-param", { name: pname, value: p.renderValue }));
		const sorted = [...ri.connects.entries()].sort((a, b) => {
			const ia = ri.order.indexOf(a[0]);
			const ib = ri.order.indexOf(b[0]);
			return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
		});
		for (const [port, c] of sorted) {
			el.appendChild(
				c.open
					? mk("aw-connect", { port, type: "open" })
					: mk("aw-connect", { port, to: c.to, part: c.part }),
			);
		}
		groups["aw-insts"]!.appendChild(el);
	}
}

// ---------------------------------------------------------------------------
// Deterministic snapshot serializer: the dump input / golden surface.
// Only aw-render subtrees are serialized (content/templates never ship).
// Attributes are sorted for byte-stable goldens.
// ---------------------------------------------------------------------------

const SNAPSHOT_ATTR_ORDER = null; // alphabetical

function escapeXml(s: string): string {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function serializeEl(el: Element, indent: number, out: string[]): void {
	const tag = (el.tagName ?? "").toLowerCase();
	const attrs: [string, string][] = [];
	for (const a of el.attributes ?? []) attrs.push([a.name, a.value]);
	attrs.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
	const pad = "  ".repeat(indent);
	const kids = [...(el.children ?? [])];
	const attrText = attrs.map(([k, v]) => `${k}="${escapeXml(v)}"`).join(" ");
	if (kids.length === 0) {
		out.push(`${pad}<${tag}${attrText ? ` ${attrText}` : ""}></${tag}>`);
		return;
	}
	out.push(`${pad}<${tag}${attrText ? ` ${attrText}` : ""}>`);
	for (const k of kids) serializeEl(k, indent + 1, out);
	out.push(`${pad}</${tag}>`);
}

/** Serialize a mod subtree keeping only aw-render (recursively). */
function serializeModSnapshot(
	mod: Element,
	indent: number,
	out: string[],
): void {
	const pad = "  ".repeat(indent);
	const name = escapeXml(attr(mod, "name") ?? "");
	out.push(`${pad}<aw-mod name="${name}">`);
	const render = child(mod, "aw-render");
	if (render) serializeEl(render, indent + 1, out);
	const submods = child(mod, "aw-submods");
	for (const sm of submods ? children(submods, "aw-mod") : [])
		serializeModSnapshot(sm, indent + 1, out);
	out.push(`${pad}</aw-mod>`);
}

/** Whole-document snapshot: <autowire> + every top-level aw-mod's render. */
export function serializeSnapshot(doc: Document): string {
	const out = [];
	const root = all(doc, "autowire").filter((e) => !e.closest("aw-mod"))[0];
	if (!root) return "";
	out.push("<autowire>");
	for (const mod of children(root, "aw-mod")) serializeModSnapshot(mod, 1, out);
	out.push("</autowire>");
	void SNAPSHOT_ATTR_ORDER;
	return out.join("\n");
}

// ---------------------------------------------------------------------------
// Browser integration: custom elements + window.aw. Guarded so the same file
// loads under linkedom (no customElements) on the server side. <autowire> is
// not a valid custom element name (no hyphen): it stays an unknown element —
// queryable, just not upgradeable.
const AW_TAGS = [
	"aw-mod",
	"aw-content",
	"aw-submods",
	"aw-render",
	...CONTENT_GROUPS,
	"aw-import",
	"aw-param",
	"aw-localparam",
	"aw-port",
	"aw-template",
	"aw-inst",
	"aw-connect",
	"aw-rewrite",
	"aw-signals",
	"aw-signal",
];

export function installGlobal(win: AwWindow): unknown {
	if (win.customElements) {
		for (const tag of AW_TAGS) {
			if (!win.customElements.get(tag)) {
				const cls = class extends win.HTMLElement {
					connectedCallback() {
						// Accessible names for Playwright snapshots (connect-html §3.8).
						const label =
							this.getAttribute("name") ??
							this.getAttribute("id") ??
							this.getAttribute("port");
						if (label && !this.getAttribute("aria-label"))
							this.setAttribute("aria-label", `${tag} ${label}`);
					}
				};
				win.customElements.define(tag, cls);
			}
		}
	}
	win.aw = {
		on,
		check,
		elaborate,
		serializeSnapshot,
		runBeforeDump,
		runBeforeInstances,
		beginUnitHooks,
		endUnitHooks,
		clearUnitHooks,
		HOOK_PHASES,
	};
	return win.aw;
}
