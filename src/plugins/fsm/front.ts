// Front end: parse the .mjs, resolve imports (the fsm DSL, other fsm sources),
// read the @FsmGroup class, @FsmPort interfaces and the method ports (§2.2, §2.6).

import { dirname, resolve } from "node:path";
import type {
	ClassDeclaration,
	ClassMethod,
	Expression,
	File,
	Node,
	VariableDeclaration,
} from "@babel/types";
import { intLit, widthLit } from "./expr.ts";
import type {
	DffReg,
	FsmOptions,
	Group,
	HsPort,
	Iface,
	IfaceClass,
	IfaceField,
	Port,
	SvFn,
	SvPkg,
	Unit,
} from "./model.ts";
import { checkSvId, FsmError, type Src } from "./source.ts";

const BUILTINS: Record<string, true> = {
	FsmGroup: true,
	Fsm: true,
	FsmPort: true,
	Input: true,
	Output: true,
	Const: true,
	Dff: true,
	PushPort: true,
	PopPort: true,
	Chan: true,
	Instance: true,
	SvPackage: true,
	SvFunction: true,
	Escape: true,
	Raise: true,
	ALWAYS_0: true,
	ALWAYS_1: true,
};

/** Builtins of a later phase (docs/state/async-fsm.md §11): rejected with a clear error. */
export const NOT_YET: Record<string, string> = {
	Escape: "exception regions (§3.7)",
	Raise: "exception regions (§3.7)",
};

/** Port declarations a parameter default or an interface field may use. */
const PORT_KINDS: Record<string, true> = {
	Input: true,
	Output: true,
	Dff: true,
	PushPort: true,
	PopPort: true,
};

export function notYet(src: Src, node: Node, what: string): never {
	return src.fail(node, `${what} is not implemented yet`);
}

/** Paths compare case-insensitively on Windows. */
const samePath = (a: string, b: string) =>
	process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Loads another fsm source by absolute path (cached by the caller). */
export type Loader = (abs: string, from: Src, node: Node) => Promise<Unit>;

async function parseFile(src: Src): Promise<File> {
	// Lazy: the parser loads only for `plugin fsm run` (§8.2), like exceljs.
	const { parse } = await import("@babel/parser");
	try {
		return parse(src.text, {
			sourceType: "module",
			sourceFilename: src.file,
			plugins: ["decorators"],
		});
	} catch (e) {
		const msg = (e instanceof Error ? e.message : String(e)).replace(
			/ \(\d+:\d+\)$/,
			"",
		);
		const loc =
			e &&
			typeof e === "object" &&
			"loc" in e &&
			e.loc &&
			typeof e.loc === "object"
				? e.loc
				: null;
		const at =
			loc && "line" in loc && "column" in loc
				? `:${loc.line}:${Number(loc.column) + 1}`
				: "";
		throw new FsmError(`${src.file}${at}: ${msg}`);
	}
}

/** Parse one source. Imports other than the DSL are fsm sources loaded through `load`. */
export async function parseUnit(
	src: Src,
	o: { abs: string; dsl: string; load: Loader },
): Promise<Unit> {
	const file = await parseFile(src);
	const unit: Unit = {
		src,
		abs: o.abs,
		builtins: new Map(),
		packages: new Map(),
		ifaces: new Map(),
		groups: new Map(),
		exports: new Map(),
	};
	let groupDecl:
		| { decl: ClassDeclaration; outer: Node; exported: boolean }
		| undefined;
	for (const stmt of file.program.body) {
		if (stmt.type === "ImportDeclaration") {
			await importDecl(unit, stmt, o);
			continue;
		}
		const exported = stmt.type === "ExportNamedDeclaration";
		const decl = exported ? stmt.declaration : stmt;
		if (exported && (stmt.specifiers.length > 0 || stmt.source))
			src.fail(
				stmt,
				"export a declaration: export class ... / export const ...",
			);
		if (decl?.type === "VariableDeclaration") {
			const [name, pkg] = svPackage(src, decl, unit.builtins);
			unit.packages.set(name, pkg);
			if (exported) unit.exports.set(name, pkg);
			continue;
		}
		if (decl?.type !== "ClassDeclaration")
			return src.fail(
				stmt,
				"the top level holds imports, SvPackage consts, @FsmPort classes and one @FsmGroup class",
			);
		const decos = decl.decorators ?? [];
		const deco = decos[0]?.expression;
		const kind =
			deco?.type === "Identifier" ? unit.builtins.get(deco.name) : undefined;
		if (decos.length !== 1 || (kind !== "FsmGroup" && kind !== "FsmPort"))
			src.fail(
				decl,
				"a class needs exactly one decorator: @FsmGroup or @FsmPort",
			);
		if (decl.superClass)
			src.fail(decl.superClass, "an fsm class cannot extend");
		if (!decl.id) return src.fail(decl, "the class needs a name");
		if (kind === "FsmPort") {
			const c = ifaceClass(unit, decl);
			unit.ifaces.set(c.name, c);
			if (exported) unit.exports.set(c.name, c);
			continue;
		}
		if (groupDecl) src.fail(stmt, "one @FsmGroup class per file");
		groupDecl = { decl, outer: stmt, exported };
	}
	if (groupDecl) {
		const g = group(unit, groupDecl.decl, groupDecl.outer, groupDecl.exported);
		unit.group = g;
		unit.groups.set(g.name, g);
		if (groupDecl.exported) unit.exports.set(g.name, g);
	}
	return unit;
}

async function importDecl(
	unit: Unit,
	stmt: Node & { type: "ImportDeclaration" },
	o: { abs: string; dsl: string; load: Loader },
) {
	const src: Src = unit.src;
	const target = resolve(dirname(o.abs), stmt.source.value);
	const dsl = samePath(target, resolve(o.dsl));
	if (!dsl && !target.endsWith(".mjs"))
		src.fail(
			stmt.source,
			`import the fsm DSL (${o.dsl}) or another fsm .mjs source; the source is never executed`,
		);
	const from = dsl ? undefined : await o.load(target, src, stmt.source);
	for (const s of stmt.specifiers) {
		if (s.type !== "ImportSpecifier" || s.imported.type !== "Identifier")
			return src.fail(s, "import by name: import { Fsm, ... } from ...");
		const name = s.imported.name;
		const local = s.local.name;
		if (!from) {
			if (!BUILTINS[name]) src.fail(s, `${name} is not an fsm builtin`);
			unit.builtins.set(local, name);
			continue;
		}
		const x = from.exports.get(name);
		if (!x)
			src.fail(
				s,
				`${stmt.source.value} exports no @FsmGroup, @FsmPort or SvPackage named ${name}`,
			);
		if ("fns" in x) unit.packages.set(local, x);
		else if ("fields" in x) unit.ifaces.set(local, x);
		else unit.groups.set(local, x);
	}
}

function group(
	unit: Unit,
	decl: ClassDeclaration,
	outer: Node,
	exported: boolean,
): Group {
	const src: Src = unit.src;
	const g: Group = {
		name: decl.id?.name ?? "",
		comment: docComment(src, outer),
		exported,
		methods: [],
		unit,
	};
	for (const m of decl.body.body) {
		if (
			m.type !== "ClassMethod" ||
			m.kind !== "method" ||
			m.static ||
			m.computed ||
			m.key.type !== "Identifier"
		)
			return src.fail(
				m,
				"an @FsmGroup class holds only async methods (no constructor, fields, static, getters or setters)",
			);
		if (!m.async || m.generator)
			src.fail(m, "a state machine method must be `async`");
		const name = m.key.name;
		checkSvId(src, m.key, name, "module name");
		const [d0, d1] = m.decorators ?? [];
		if (d1) src.fail(d1, "one @Fsm decorator per method");
		const { params, ports } = methodPorts(unit, m);
		g.methods.push({
			node: m,
			name,
			comment: docComment(src, m),
			options: d0 ? fsmOptions(src, d0.expression, unit.builtins) : {},
			sub: !d0,
			params,
			ports,
			group: g,
		});
	}
	if (!g.methods.some((m) => !m.sub) && !exported)
		src.fail(decl, "the @FsmGroup class has no @Fsm method");
	return g;
}

function fsmOptions(
	src: Src,
	e: Expression,
	builtins: Map<string, string>,
): FsmOptions {
	if (e.type === "Identifier" && builtins.get(e.name) === "Fsm") return {};
	if (
		e.type !== "CallExpression" ||
		e.callee.type !== "Identifier" ||
		builtins.get(e.callee.name) !== "Fsm"
	)
		return src.fail(e, "a state machine method takes @Fsm or @Fsm({...})");
	const out: FsmOptions = {};
	if (e.arguments.length === 0) return out;
	const opts = e.arguments[0];
	if (e.arguments.length > 1 || opts?.type !== "ObjectExpression")
		return src.fail(e, "@Fsm takes one options object");
	for (const p of opts.properties) {
		if (p.type !== "ObjectProperty" || p.key.type !== "Identifier")
			return src.fail(p, "unknown @Fsm option");
		const key = p.key.name;
		const v = p.value;
		if (key === "statePrefix") {
			if (
				v.type !== "StringLiteral" ||
				!/^[A-Z][A-Z0-9_]*[A-Z0-9]$|^[A-Z]$/.test(v.value)
			)
				src.fail(
					v,
					'statePrefix is an upper-case SV identifier string, e.g. "LPDDRPHY"',
				);
			out.statePrefix = v.value;
		} else if (key === "stateEncoding") {
			if (
				v.type !== "StringLiteral" ||
				(v.value !== "binary" && v.value !== "onehot")
			)
				return src.fail(
					v,
					'stateEncoding is "binary" or "onehot" (omit it to let synthesis choose)',
				);
			out.stateEncoding = v.value;
		} else if (
			key === "exportState" ||
			key === "stateValues" ||
			key === "stateReg"
		) {
			notYet(src, p, `@Fsm option ${key} (§6.5)`);
		} else {
			src.fail(p, `unknown @Fsm option ${key}`);
		}
	}
	return out;
}

/** Names the generator owns; an author name must not take them. */
export function reservedName(name: string): boolean {
	return (
		name === "clk" ||
		name === "rst_n" ||
		name.startsWith("state_") ||
		name.startsWith("move_") ||
		name.startsWith("leave_") ||
		name.startsWith("fn_")
	);
}

/** The destructured parameter: `{ go = Input(1), req = new ReqPort(8), ... }` (§2.2). */
function methodPorts(
	unit: Unit,
	m: ClassMethod,
): { params: Map<string, Port | Iface>; ports: Port[] } {
	const src: Src = unit.src;
	const params = new Map<string, Port | Iface>();
	const ports: Port[] = [];
	if (m.params.length === 0) return { params, ports };
	const pat = m.params[0];
	if (m.params.length > 1 || pat?.type !== "ObjectPattern")
		return src.fail(
			m,
			"ports are one destructured parameter: ({ go = Input(1), ... })",
		);
	let prevLine = pat.loc?.start.line ?? 0;
	for (const p of pat.properties) {
		const line = p.loc?.start.line ?? 0;
		if (line === prevLine)
			src.fail(p, "one port per line (group ports with // comment lines)");
		// `// title` alone on its line(s) above a port: a group header in the SV port list.
		const group = (p.leadingComments ?? [])
			.filter(
				(c) =>
					c.type === "CommentLine" &&
					(c.loc?.start.line ?? 0) > prevLine &&
					src.text
						.slice(
							src.text.lastIndexOf("\n", (c.start ?? 1) - 1) + 1,
							c.start ?? 0,
						)
						.trim() === "",
			)
			.map((c) => c.value.trim());
		prevLine = p.loc?.end.line ?? line;
		if (
			p.type !== "ObjectProperty" ||
			!p.shorthand ||
			p.value.type !== "AssignmentPattern" ||
			p.value.left.type !== "Identifier"
		)
			return src.fail(
				p,
				"each port is `name = Input(N)` / `Output(N)` / `Dff(N)` / `PushPort(N)` / `PopPort(N)` / `new Iface(...)`",
			);
		const name = p.value.left.name;
		checkSvId(src, p, name, "port");
		if (reservedName(name))
			src.fail(p, `port name ${name} is reserved by the generator`);
		const init = p.value.right;
		let made: Port[];
		if (init.type === "NewExpression") {
			const x = instantiate(unit, name, init, p);
			params.set(name, x);
			made = [...x.fields.values()];
		} else {
			const kind =
				init.type === "CallExpression" && init.callee.type === "Identifier"
					? unit.builtins.get(init.callee.name)
					: undefined;
			if (init.type !== "CallExpression" || !kind || !PORT_KINDS[kind])
				return src.fail(
					init,
					"a port default is a port declaration: Input(N), Output(N), Dff(N), PushPort(N), PopPort(N) or new Iface(...)",
				);
			const [a0, a1] = init.arguments;
			const port = portDecl(src, kind, name, widthLit(src, a0), a1, p);
			params.set(name, port);
			made = [port];
		}
		const first = made[0];
		if (first && group.length > 0) first.group = group;
		ports.push(...made);
	}
	return { params, ports };
}

function portDecl(
	src: Src,
	kind: string,
	name: string,
	width: number,
	opts: Node | undefined,
	node: Node,
): Port {
	if (kind === "Dff") return dffDecl(src, name, node, width, opts, true);
	if (opts) src.fail(opts, `${kind}(N) takes one width`);
	if (kind === "Input") return { k: "input", name, width, node, used: false };
	if (kind === "Output") return { k: "output", name, width, node, sites: [] };
	return hsPort(
		kind === "PushPort" ? "push" : "pop",
		name,
		width,
		"port",
		node,
	);
}

export function hsPort(
	k: "push" | "pop",
	name: string,
	width: number,
	place: "port" | "chan",
	node: Node,
): HsPort {
	return { k, name, width, place, node, sites: [], read: false };
}

/** `@FsmPort` class: constructor fields `this.f = Kind(...)` and plain methods (§2.6). */
function ifaceClass(unit: Unit, decl: ClassDeclaration): IfaceClass {
	const src: Src = unit.src;
	const name = decl.id?.name ?? "";
	const c: IfaceClass = {
		name,
		unit,
		node: decl,
		params: [],
		fields: [],
		methods: new Map(),
	};
	for (const m of decl.body.body) {
		if (
			m.type !== "ClassMethod" ||
			m.static ||
			m.computed ||
			m.key.type !== "Identifier" ||
			(m.kind !== "method" && m.kind !== "constructor")
		)
			return src.fail(
				m,
				"an @FsmPort class holds a constructor and methods only",
			);
		if (m.decorators?.length) src.fail(m, "@FsmPort methods take no decorator");
		const ids = m.params.map((p) =>
			p.type === "Identifier"
				? p.name
				: src.fail(p, "interface method parameters are plain names"),
		);
		if (m.kind === "method") {
			if (m.generator) src.fail(m, "generators are not supported");
			c.methods.set(m.key.name, m);
			continue;
		}
		c.params = ids;
		for (const s of m.body.body) {
			const e = s.type === "ExpressionStatement" ? s.expression : undefined;
			const r = e?.type === "AssignmentExpression" ? e.right : undefined;
			const kind =
				r?.type === "CallExpression" && r.callee.type === "Identifier"
					? unit.builtins.get(r.callee.name)
					: undefined;
			if (
				e?.type !== "AssignmentExpression" ||
				e.operator !== "=" ||
				e.left.type !== "MemberExpression" ||
				e.left.object.type !== "ThisExpression" ||
				e.left.property.type !== "Identifier" ||
				r?.type !== "CallExpression" ||
				!kind ||
				!PORT_KINDS[kind]
			)
				return src.fail(
					s,
					"the constructor declares fields only: this.f = Input(N) / Output(N) / Dff(N) / PushPort(N) / PopPort(N)",
				);
			const f = e.left.property.name;
			checkSvId(src, e.left.property, f, "field");
			if (c.fields.some((x) => x.name === f))
				src.fail(e.left, `field ${f} is declared twice`);
			c.fields.push({ name: f, kind, args: r.arguments, node: s });
		}
	}
	if (c.fields.length === 0)
		src.fail(decl, "an @FsmPort class declares its fields in the constructor");
	return c;
}

/** `name = new C(8, ...)`: fields become ports <name>_<field>. */
function instantiate(
	unit: Unit,
	name: string,
	e: Node & { type: "NewExpression" },
	node: Node,
): Iface {
	const src: Src = unit.src;
	const cls =
		e.callee.type === "Identifier" ? unit.ifaces.get(e.callee.name) : undefined;
	if (!cls) return src.fail(e.callee, "new takes an @FsmPort class");
	if (e.arguments.length !== cls.params.length)
		src.fail(e, `${cls.name} takes ${cls.params.length} argument(s)`);
	const args = e.arguments.map((a) => intLit(src, a, "an interface argument"));
	const env = new Map(cls.params.map((p, i) => [p, args[i] ?? 0n]));
	const fields = new Map<string, Port>();
	for (const f of cls.fields)
		fields.set(f.name, fieldPort(cls, f, env, `${name}_${f.name}`, node));
	return { k: "iface", name, cls, args, fields, node };
}

function fieldPort(
	cls: IfaceClass,
	f: IfaceField,
	env: Map<string, bigint>,
	name: string,
	node: Node,
): Port {
	const src: Src = cls.unit.src;
	const [w, opts] = f.args;
	const v = w?.type === "Identifier" ? env.get(w.name) : undefined;
	const width = v !== undefined ? Number(v) : widthLit(src, w);
	if (width < 1 || width > 4096) src.fail(w, "width must be 1..4096");
	return portDecl(src, f.kind, name, width, opts, node);
}

/** Dff(N, { reset?, external? }) as a port (`param`) or in the method body. */
export function dffDecl(
	src: Src,
	name: string,
	node: Node,
	width: number,
	opts: Node | undefined,
	param: boolean,
): DffReg {
	let reset = 0n;
	let external = false;
	let resetNode: Node | undefined;
	if (opts) {
		if (opts.type !== "ObjectExpression")
			src.fail(opts, "Dff options are an object: { reset: v, external: true }");
		for (const p of opts.properties) {
			const key =
				p.type === "ObjectProperty" && p.key.type === "Identifier"
					? p.key.name
					: "";
			if (key === "reset" && p.type === "ObjectProperty") {
				reset = intLit(src, p.value, "reset value");
				resetNode = p;
				if (reset >= 1n << BigInt(width))
					src.fail(p.value, `reset value does not fit in ${width} bit(s)`);
			} else if (key === "external" && p.type === "ObjectProperty") {
				if (p.value.type !== "BooleanLiteral")
					src.fail(p.value, "external: true | false");
				if (!param) src.fail(p, "only a port Dff can be external");
				external = p.value.value;
			} else {
				src.fail(p, "unknown Dff option");
			}
		}
	}
	if (external && resetNode)
		src.fail(
			resetNode,
			"an external Dff takes its reset value from its owner; drop reset",
		);
	return {
		k: "dff",
		name,
		width,
		reset,
		place: external ? "external" : param ? "port" : "body",
		node,
		sites: [],
		read: false,
	};
}

/** `const pkg = SvPackage("pkg", { fn: SvFunction({ args: { a: 8 }, ret: 1 }) })` (§2.3). */
function svPackage(
	src: Src,
	d: VariableDeclaration,
	builtins: Map<string, string>,
): [string, SvPkg] {
	const shape =
		'const x = SvPackage("pkg", { fn: SvFunction({ args: { a: 8 }, ret: 1 }) })';
	const [x, extra] = d.declarations;
	const init = x?.init;
	if (
		d.kind !== "const" ||
		extra ||
		x?.id.type !== "Identifier" ||
		init?.type !== "CallExpression" ||
		init.callee.type !== "Identifier" ||
		builtins.get(init.callee.name) !== "SvPackage"
	)
		return src.fail(
			d,
			`top-level declarations are user SV packages only: ${shape}`,
		);
	const [name, table] = init.arguments;
	if (
		name?.type !== "StringLiteral" ||
		table?.type !== "ObjectExpression" ||
		init.arguments.length !== 2
	)
		return src.fail(init, shape);
	checkSvId(src, name, name.value, "package");
	const fns = new Map<string, SvFn>();
	for (const p of table.properties) {
		const sig = p.type === "ObjectProperty" ? p.value : undefined;
		if (
			p.type !== "ObjectProperty" ||
			p.key.type !== "Identifier" ||
			sig?.type !== "CallExpression" ||
			sig.callee.type !== "Identifier" ||
			builtins.get(sig.callee.name) !== "SvFunction" ||
			sig.arguments[0]?.type !== "ObjectExpression"
		)
			return src.fail(
				p,
				"each function is fn: SvFunction({ args: { a: N, ... }, ret: N })",
			);
		checkSvId(src, p.key, p.key.name, "function");
		let args: number[] | undefined;
		let ret: number | undefined;
		for (const q of sig.arguments[0].properties) {
			const key =
				q.type === "ObjectProperty" && q.key.type === "Identifier"
					? q.key.name
					: "";
			if (q.type !== "ObjectProperty") return src.fail(q, "args / ret");
			if (key === "ret") ret = widthLit(src, q.value);
			else if (key === "args" && q.value.type === "ObjectExpression")
				args = q.value.properties.map((a) =>
					a.type === "ObjectProperty"
						? widthLit(src, a.value)
						: src.fail(a, "argument width"),
				);
			else
				src.fail(
					q,
					"SvFunction takes { args: { name: width, ... }, ret: width }",
				);
		}
		if (!args || ret === undefined)
			return src.fail(sig, "SvFunction needs args and ret");
		fns.set(p.key.name, { args, ret });
	}
	return [x.id.name, { name: name.value, fns }];
}

/** `/** ... *\/` directly above `node` (only whitespace between) as comment lines (§7.1). */
function docComment(src: Src, node: Node): string[] {
	const c = node.leadingComments?.at(-1);
	if (
		c?.type !== "CommentBlock" ||
		!c.value.startsWith("*") ||
		src.text.slice(c.end ?? 0, node.start ?? 0).trim() !== ""
	)
		return [];
	const lines = c.value
		.slice(1)
		.split(/\r?\n/)
		.map((l) =>
			l
				.replace(/^\s*\*?/, "")
				.replace(/^ /, "")
				.trimEnd(),
		);
	while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
	while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
	return lines;
}
