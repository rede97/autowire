// Front end: parse the .mjs, resolve imports (the fsm DSL, other fsm sources),
// read the @FsmGroup class, @FsmPort interfaces and the method ports (§2.2, §2.6).

import { dirname, resolve } from "node:path";
import type { parse as babelParse } from "@babel/parser";
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
	EnumType,
	FsmOptions,
	Group,
	HsPort,
	Iface,
	IfaceClass,
	IfaceField,
	MsgField,
	MsgShape,
	Port,
	SvFn,
	SvPkg,
	Ty,
	Unit,
} from "./model.ts";
import { checkSvId, FsmError, type Src, upperSnake } from "./source.ts";

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
	Caller: true,
	SvPackage: true,
	SvFunction: true,
	Escape: true,
	Raise: true,
	SvEnum: true,
	ALWAYS_0: true,
	ALWAYS_1: true,
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

let parser: typeof babelParse | undefined;

function parseText(src: Src): File {
	if (!parser) throw new Error("fsm: the parser is not loaded");
	try {
		return parser(src.text, {
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

const emptyUnit = (src: Src, abs: string): Unit => ({
	src,
	abs,
	builtins: new Map(),
	packages: new Map(),
	ifaces: new Map(),
	enums: new Map(),
	ownEnums: [],
	groups: new Map(),
	exports: new Map(),
});

/** Parse one source. Imports other than the DSL are fsm sources loaded through `load`. */
export async function parseUnit(
	src: Src,
	o: { abs: string; dsl: string; load: Loader },
): Promise<Unit> {
	// Lazy: the parser loads only for `plugin fsm run` (§8.2), like exceljs.
	parser ??= (await import("@babel/parser")).parse;
	const file = parseText(src);
	const unit = emptyUnit(src, o.abs);
	// Imports first, as ES hoists them: classes below resolve the names they bring.
	for (const stmt of file.program.body)
		if (stmt.type === "ImportDeclaration") await importDecl(unit, stmt, o);
	fillUnit(unit, file);
	return unit;
}

/** Source the compiler writes itself (a Caller server, §5.4): every builtin is
 *  in scope under its own name, plus the names of the file it was made for. */
export function parseSynthetic(src: Src, from: Unit): Unit {
	const unit = emptyUnit(src, from.abs);
	for (const b of Object.keys(BUILTINS)) unit.builtins.set(b, b);
	for (const [k, v] of from.packages) unit.packages.set(k, v);
	for (const [k, v] of from.ifaces) unit.ifaces.set(k, v);
	for (const [k, v] of from.enums) unit.enums.set(k, v);
	for (const [k, v] of from.groups) unit.groups.set(k, v);
	fillUnit(unit, parseText(src));
	return unit;
}

function fillUnit(unit: Unit, file: File) {
	const src: Src = unit.src;
	let groupDecl:
		| {
				decl: ClassDeclaration;
				outer: Node;
				exported: boolean;
				deco: Expression | undefined;
		  }
		| undefined;
	for (const stmt of file.program.body) {
		if (stmt.type === "ImportDeclaration") continue;
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
				"the top level holds imports, SvPackage consts, @SvEnum / @FsmPort classes and one @FsmGroup class",
			);
		const decos = decl.decorators ?? [];
		const deco = decos[0]?.expression;
		const head = deco?.type === "CallExpression" ? deco.callee : deco;
		const kind =
			head?.type === "Identifier" ? unit.builtins.get(head.name) : undefined;
		if (
			decos.length !== 1 ||
			(kind !== "FsmGroup" && kind !== "FsmPort" && kind !== "SvEnum") ||
			(kind === "FsmPort" && deco?.type === "CallExpression")
		)
			src.fail(
				decl,
				"a class needs exactly one decorator: @FsmGroup[({ file })], @FsmPort or @SvEnum({...})",
			);
		if (decl.superClass)
			src.fail(decl.superClass, "an fsm class cannot extend");
		if (!decl.id) return src.fail(decl, "the class needs a name");
		if (kind === "SvEnum") {
			const t = svEnum(src, decl, deco, unit.abs, docComment(src, stmt));
			for (const o of unit.ownEnums)
				if (o.pkg === t.pkg && o.name === t.name)
					src.fail(decl, `${t.pkg}::${t.name} is declared twice`);
				else if (o.pkg === t.pkg)
					for (const m of t.members.values())
						if ([...o.members.values()].some((x) => x.sv === m.sv))
							src.fail(
								decl,
								`${t.pkg}::${m.sv} is a member of ${o.cls} too; give one of them a prefix`,
							);
			unit.enums.set(t.cls, t);
			unit.ownEnums.push(t);
			if (exported) unit.exports.set(t.cls, t);
			continue;
		}
		if (kind === "FsmPort") {
			const c = ifaceClass(unit, decl);
			unit.ifaces.set(c.name, c);
			if (exported) unit.exports.set(c.name, c);
			continue;
		}
		if (groupDecl) src.fail(stmt, "one @FsmGroup class per file");
		groupDecl = { decl, outer: stmt, exported, deco };
	}
	if (groupDecl) {
		const g = group(
			unit,
			groupDecl.decl,
			groupDecl.outer,
			groupDecl.exported,
			groupDecl.deco,
		);
		unit.group = g;
		unit.groups.set(g.name, g);
		if (groupDecl.exported) unit.exports.set(g.name, g);
	}
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
				`${stmt.source.value} exports no @FsmGroup, @FsmPort, @SvEnum or SvPackage named ${name}`,
			);
		if ("fns" in x) unit.packages.set(local, x);
		else if ("members" in x) unit.enums.set(local, x);
		else if ("fields" in x) unit.ifaces.set(local, x);
		else unit.groups.set(local, x);
	}
}

function group(
	unit: Unit,
	decl: ClassDeclaration,
	outer: Node,
	exported: boolean,
	deco: Expression | undefined,
): Group {
	const src: Src = unit.src;
	const name = decl.id?.name ?? "";
	const g: Group = {
		name,
		file: deco ? groupFile(src, deco, name) : name,
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
				"an @FsmGroup class holds only methods (no constructor, fields, static, getters or setters)",
			);
		if (m.generator) src.fail(m, "a state machine method is not a generator");
		const name = m.key.name;
		checkSvId(src, m.key, name, "module name");
		const [d0, d1] = m.decorators ?? [];
		if (d1) src.fail(d1, "one @Fsm decorator per method");
		if (d0 && !m.async) src.fail(m, "an @Fsm method must be `async`");
		const { params, ports } = methodPorts(unit, m);
		g.methods.push({
			node: m,
			name,
			comment: docComment(src, m),
			options: d0 ? fsmOptions(src, d0.expression, unit.builtins, name) : {},
			sub: !d0,
			sync: !m.async,
			params,
			ports,
			group: g,
		});
	}
	if (!g.methods.some((m) => !m.sub) && !exported)
		src.fail(decl, "the @FsmGroup class has no @Fsm method");
	return g;
}

/** `@FsmGroup({ file: "stem" })`: the output file stem, default the class name. */
function groupFile(src: Src, e: Expression, name: string): string {
	if (e.type !== "CallExpression") return name;
	const [a0, a1] = e.arguments;
	const fail = (n: Node) =>
		src.fail(n, '@FsmGroup takes no argument or { file: "stem" }');
	if (a1) return fail(a1);
	if (!a0) return name;
	if (a0.type !== "ObjectExpression") return fail(a0);
	let file = name;
	for (const p of a0.properties) {
		if (
			p.type !== "ObjectProperty" ||
			p.computed ||
			p.key.type !== "Identifier" ||
			p.key.name !== "file"
		)
			return fail(p);
		const v = p.value;
		if (v.type !== "StringLiteral" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.value))
			return src.fail(
				v,
				'file is a file stem string of letters, digits and _, e.g. "dphy_rdi_sm"',
			);
		file = v.value;
	}
	return file;
}

function fsmOptions(
	src: Src,
	e: Expression,
	builtins: Map<string, string>,
	name: string,
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
		} else if (key === "exportState") {
			if (v.type !== "BooleanLiteral")
				return src.fail(v, "exportState is true or false");
			if (v.value) out.exportState = true;
		} else if (key === "stateValues") {
			if (v.type !== "ObjectExpression")
				return src.fail(
					v,
					"stateValues maps every enum member to a number: { IDLE: 0, ... }",
				);
			const values = new Map<string, bigint>();
			for (const q of v.properties) {
				if (
					q.type !== "ObjectProperty" ||
					q.key.type !== "Identifier" ||
					q.value.type !== "NumericLiteral" ||
					!Number.isInteger(q.value.value) ||
					q.value.value < 0
				)
					return src.fail(
						q,
						"stateValues entry: MEMBER: <non-negative integer>",
					);
				if (values.has(q.key.name))
					src.fail(q, `stateValues lists ${q.key.name} twice`);
				values.set(q.key.name, BigInt(q.value.value));
			}
			out.stateValues = { values, node: v };
		} else if (key === "wrap") {
			if (v.type === "BooleanLiteral") {
				if (v.value) out.wrap = `${name}_wrap`;
			} else if (v.type === "StringLiteral") {
				checkSvId(src, v, v.value, "wrap module name");
				out.wrap = v.value;
			} else
				return src.fail(
					v,
					'wrap is true (module <name>_wrap) or a module name string, e.g. "dphy_rdi_sm_top"',
				);
		} else if (key === "stateType") {
			if (v.type !== "StringLiteral")
				return src.fail(
					v,
					'stateType is an SV type name string, e.g. "rdi_sm_state_e"',
				);
			checkSvId(src, v, v.value, "state type name");
			out.stateType = v.value;
		} else {
			src.fail(p, `unknown @Fsm option ${key}`);
		}
	}
	if (out.stateValues && out.stateEncoding)
		src.fail(
			out.stateValues.node,
			"stateValues and stateEncoding exclude each other (§6.5)",
		);
	return out;
}

/** Names the generator owns; an author name must not take them (comb_ / ff_ name the
 *  always blocks). */
export function reservedName(name: string): boolean {
	return (
		name === "clk" ||
		name === "rst_n" ||
		name.startsWith("state_") ||
		name === "action" ||
		name.startsWith("comb_") ||
		name.startsWith("ff_") ||
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
			const port = portDecl(src, kind, name, a0, a1, p, (n) => tyOf(unit, n));
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
	a0: Node | undefined,
	opts: Node | undefined,
	node: Node,
	tyOfArg: (n: Node | undefined) => Ty,
): Port {
	if (kind === "PushPort" || kind === "PopPort") {
		if (opts)
			src.fail(opts, `${kind} takes one width or one { field: width } object`);
		return hsPort(
			kind === "PushPort" ? "push" : "pop",
			name,
			msgShape(src, a0, tyOfArg),
			"port",
			node,
		);
	}
	const ty = tyOfArg(a0);
	if (kind === "Dff") return dffDecl(src, name, node, ty, opts, true);
	if (opts) src.fail(opts, `${kind}(N) takes one width`);
	if (kind === "Input") return { k: "input", ...ty, name, node, used: false };
	return { k: "output", ...ty, name, node, sites: [] };
}

/** A width literal, or an @SvEnum class name: its width and type (§2.8). */
export function tyOf(unit: Unit, n: Node | undefined): Ty {
	const t = n?.type === "Identifier" ? unit.enums.get(n.name) : undefined;
	return t ? { width: t.width, enum: t } : { width: widthLit(unit.src, n) };
}

/** `N` (one data field) or `{ addr: 8, we: 1 }` (named fields; `{}` is a token) (§6.2). */
export function msgShape(
	src: Src,
	a0: Node | undefined,
	tyOfArg: (n: Node | undefined) => Ty,
): MsgShape {
	if (a0?.type !== "ObjectExpression")
		return { k: "data", fields: [{ name: "data", ...tyOfArg(a0) }] };
	const fields: MsgField[] = [];
	for (const p of a0.properties) {
		if (
			p.type !== "ObjectProperty" ||
			p.key.type !== "Identifier" ||
			p.computed
		)
			return src.fail(p, "each message field is name: width");
		const name = p.key.name;
		checkSvId(src, p.key, name, "message field");
		if (name === "vld" || name === "rdy")
			src.fail(p.key, `field name ${name} is the handshake itself`);
		if (fields.some((f) => f.name === name))
			src.fail(p.key, `field ${name} is declared twice`);
		fields.push({ name, ...tyOfArg(p.value) });
	}
	return { k: "record", fields };
}

export function hsPort(
	k: "push" | "pop",
	name: string,
	msg: MsgShape,
	place: "port" | "chan",
	node: Node,
): HsPort {
	return { k, name, msg, place, node, sites: [], reads: new Set() };
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
	const tyOfArg = (n: Node | undefined): Ty => {
		const v = n?.type === "Identifier" ? env.get(n.name) : undefined;
		if (v === undefined) return tyOf(cls.unit, n);
		const width = Number(v);
		if (width < 1 || width > 4096) src.fail(n, "width must be 1..4096");
		return { width };
	};
	return portDecl(src, f.kind, name, w, opts, node, tyOfArg);
}

/** Dff(N, { reset?, external? }) as a port (`param`) or in the method body. */
export function dffDecl(
	src: Src,
	name: string,
	node: Node,
	ty: Ty,
	opts: Node | undefined,
	param: boolean,
): DffReg {
	const { width } = ty;
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
				const v = p.value;
				if (ty.enum) {
					const m =
						v.type === "MemberExpression" &&
						!v.computed &&
						v.property.type === "Identifier"
							? ty.enum.members.get(v.property.name)
							: undefined;
					if (!m)
						return src.fail(
							v,
							`reset of a ${ty.enum.name} register is ${ty.enum.cls}.<MEMBER>`,
						);
					reset = m.value;
				} else reset = intLit(src, v, "reset value");
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
		...ty,
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

/** `@SvEnum({ pkg, name?, width?, prefix? }) class C { static M = 0; ... }` (§2.8). */
function svEnum(
	src: Src,
	decl: ClassDeclaration,
	deco: Expression | undefined,
	abs: string,
	comment: string[],
): EnumType {
	const cls = decl.id?.name ?? "";
	const shape =
		'@SvEnum({ pkg: "my_pkg" }) class Op { static IDLE = 0; static GO = 1; }';
	const opts =
		deco?.type === "CallExpression" && deco.arguments.length === 1
			? deco.arguments[0]
			: undefined;
	if (opts?.type !== "ObjectExpression")
		return src.fail(deco ?? decl, `@SvEnum takes one options object: ${shape}`);
	let pkg = "";
	let name = `${upperSnake(cls).toLowerCase()}_e`;
	let prefix = upperSnake(cls);
	let width: number | undefined;
	for (const p of opts.properties) {
		const key =
			p.type === "ObjectProperty" && p.key.type === "Identifier"
				? p.key.name
				: "";
		if (p.type !== "ObjectProperty")
			return src.fail(p, "@SvEnum options: pkg, name, width, prefix");
		const v = p.value;
		if (key === "width") width = widthLit(src, v);
		else if (key === "pkg" || key === "name" || key === "prefix") {
			if (v.type !== "StringLiteral")
				return src.fail(v, `@SvEnum ${key} is a string`);
			if (key !== "prefix" || v.value !== "")
				checkSvId(src, v, v.value, `enum ${key}`);
			if (key === "pkg") pkg = v.value;
			else if (key === "name") name = v.value;
			else prefix = v.value;
		} else src.fail(p, `unknown @SvEnum option ${key}`);
	}
	if (!pkg) src.fail(opts, `@SvEnum names its SV package: ${shape}`);
	const members = new Map<string, { sv: string; value: bigint }>();
	const seen = new Map<bigint, string>();
	for (const m of decl.body.body) {
		if (
			m.type !== "ClassProperty" ||
			!m.static ||
			m.computed ||
			m.key.type !== "Identifier"
		)
			return src.fail(
				m,
				`an @SvEnum class holds static members only: ${shape}`,
			);
		const key = m.key.name;
		const value = intLit(src, m.value ?? m, `${cls}.${key}`);
		const other = seen.get(value);
		if (other)
			src.fail(m, `${cls}.${other} and ${cls}.${key} are both ${value}`);
		seen.set(value, key);
		const sv = prefix ? `${prefix}_${key}` : key;
		checkSvId(src, m.key, sv, "enum member");
		members.set(key, { sv, value });
	}
	if (members.size === 0)
		src.fail(decl, `an @SvEnum class needs members: ${shape}`);
	const max = [...members.values()].reduce(
		(a, b) => (b.value > a ? b.value : a),
		0n,
	);
	const need = Math.max(1, max.toString(2).length);
	if (width !== undefined && width < need)
		src.fail(
			opts,
			`${cls} needs ${need} bits for value ${max}, width is ${width}`,
		);
	return {
		cls,
		name,
		pkg,
		width: width ?? need,
		members,
		comment,
		node: decl,
		src,
		abs,
	};
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
	// `/** Text` with continuation lines ` *  more`: the continuation indent only
	// aligns with the text after `/** `, so it is dropped (deeper indents stay relative).
	if (lines[0]?.trim()) {
		const rest = lines.slice(1).filter((l) => l.trim() !== "");
		const cut = Math.min(...rest.map((l) => l.length - l.trimStart().length));
		if (rest.length > 0 && cut > 0)
			for (let i = 1; i < lines.length; i++)
				lines[i] = (lines[i] as string).slice(
					Math.min(cut, lines[i]?.length ?? 0),
				);
	}
	while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
	while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
	return lines;
}
