// Front end: parse the .mjs, resolve DSL imports, read the @FsmGroup class,
// its @Fsm methods and their port parameters (§2.2).

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
import type { DffReg, FsmOptions, Port, SvFn, SvPkg } from "./model.ts";
import { checkSvId, FsmError, type Src } from "./source.ts";

const BUILTINS = [
	"FsmGroup",
	"Fsm",
	"Input",
	"Output",
	"Const",
	"Dff",
	"PushPort",
	"PopPort",
	"SvPackage",
	"SvFunction",
	"Escape",
	"Raise",
	"ALWAYS_0",
	"ALWAYS_1",
];

/** Builtins of a later phase (docs/state/async-fsm.md §11): rejected with a clear error. */
export const NOT_YET: Record<string, string> = {
	PushPort: "push / pop ports (§6.2)",
	PopPort: "push / pop ports (§6.2)",
	Escape: "exception regions (§3.7)",
	Raise: "exception regions (§3.7)",
};

export function notYet(src: Src, node: Node, what: string): never {
	return src.fail(node, `${what} is not implemented yet`);
}

export interface FsmMethod {
	node: ClassMethod;
	name: string;
	comment: string[];
	ports: Port[];
	options: FsmOptions;
	/** Undecorated method: a sub-FSM called with `await this.name({...})` (§5). */
	sub: boolean;
}

export interface Group {
	name: string;
	comment: string[];
	methods: FsmMethod[];
	/** Local import name → builtin name. */
	builtins: Map<string, string>;
	/** Top-level `const x = SvPackage(...)` by local name (§2.3). */
	packages: Map<string, SvPkg>;
}

/** Paths compare case-insensitively on Windows. */
const samePath = (a: string, b: string) =>
	process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

export async function parseGroup(
	src: Src,
	o: { abs: string; dsl: string },
): Promise<Group> {
	// Lazy: the parser loads only for `plugin fsm run` (§8.2), like exceljs.
	const { parse } = await import("@babel/parser");
	let file: File;
	try {
		file = parse(src.text, { sourceType: "module", plugins: ["decorators"] });
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
	const builtins = new Map<string, string>();
	const packages = new Map<string, SvPkg>();
	let cls: { decl: ClassDeclaration; outer: Node } | undefined;
	for (const stmt of file.program.body) {
		if (stmt.type === "ImportDeclaration") {
			if (!samePath(resolve(dirname(o.abs), stmt.source.value), resolve(o.dsl)))
				src.fail(
					stmt.source,
					`only the fsm DSL may be imported (${o.dsl}); the source is never executed`,
				);
			for (const s of stmt.specifiers) {
				if (s.type !== "ImportSpecifier" || s.imported.type !== "Identifier")
					src.fail(s, "import builtins by name: import { Fsm, ... } from ...");
				if (!BUILTINS.includes(s.imported.name))
					src.fail(s, `${s.imported.name} is not an fsm builtin`);
				builtins.set(s.local.name, s.imported.name);
			}
			continue;
		}
		if (stmt.type === "VariableDeclaration") {
			svPackage(src, stmt, builtins, packages);
			continue;
		}
		const decl =
			stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
		if (decl?.type !== "ClassDeclaration")
			src.fail(
				stmt,
				"only imports and one @FsmGroup class are allowed at the top level",
			);
		if (cls) src.fail(stmt, "one @FsmGroup class per file");
		cls = { decl, outer: stmt };
	}
	if (!cls) throw new FsmError(`${src.file}: no @FsmGroup class`);
	const { decl, outer } = cls;
	const decos = decl.decorators ?? [];
	const deco = decos[0]?.expression;
	if (
		decos.length !== 1 ||
		deco?.type !== "Identifier" ||
		builtins.get(deco.name) !== "FsmGroup"
	)
		src.fail(decl, "the class needs exactly one decorator: @FsmGroup");
	if (decl.superClass)
		src.fail(decl.superClass, "an @FsmGroup class cannot extend");
	if (!decl.id) return src.fail(decl, "the @FsmGroup class needs a name");
	const methods: FsmMethod[] = [];
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
		const sub = !d0;
		const options = d0 ? fsmOptions(src, d0.expression, builtins) : {};
		const ps = ports(src, m, builtins);
		if (sub)
			for (const p of ps)
				if (p.name === "start" || p.name === "done" || p.name === "result")
					src.fail(p.node, `${p.name} is a generated sub-FSM port (§5)`);
		methods.push({
			node: m,
			name,
			comment: docComment(src, m),
			options,
			sub,
			ports: ps,
		});
	}
	if (!methods.some((m) => !m.sub))
		src.fail(decl, "the @FsmGroup class has no @Fsm method");
	return {
		name: decl.id.name,
		comment: docComment(src, outer),
		methods,
		builtins,
		packages,
	};
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

function ports(
	src: Src,
	m: ClassMethod,
	builtins: Map<string, string>,
): Port[] {
	if (m.params.length === 0) return [];
	const pat = m.params[0];
	if (m.params.length > 1 || pat?.type !== "ObjectPattern")
		src.fail(
			m,
			"ports are one destructured parameter: ({ go = Input(1), ... })",
		);
	const out: Port[] = [];
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
				"each port is `name = Input(N)` / `Output(1)` / `Dff(N)`",
			);
		const name = p.value.left.name;
		checkSvId(src, p, name, "port");
		if (reservedName(name))
			src.fail(p, `port name ${name} is reserved by the generator`);
		const init = p.value.right;
		const kind =
			init.type === "CallExpression" && init.callee.type === "Identifier"
				? builtins.get(init.callee.name)
				: undefined;
		if (init.type !== "CallExpression" || !kind)
			return src.fail(
				init,
				"a port default is a port declaration: Input(N), Output(1), Dff(N)",
			);
		if (NOT_YET[kind]) notYet(src, init, NOT_YET[kind]);
		const [a0, a1] = init.arguments;
		if (kind === "Input") {
			out.push({
				k: "input",
				name,
				width: widthLit(src, a0),
				node: p,
				used: false,
			});
		} else if (kind === "Output") {
			out.push({
				k: "output",
				name,
				width: widthLit(src, a0),
				node: p,
				sites: [],
			});
		} else if (kind === "Dff") {
			out.push(dffDecl(src, name, p, a0, a1, true));
		} else {
			src.fail(init, `${kind}(...) is not a port declaration`);
		}
		const port = out.at(-1);
		if (port && group.length > 0) port.group = group;
	}
	return out;
}

/** Dff(N, { reset?, external? }) as a port (`param`) or in the method body. */
export function dffDecl(
	src: Src,
	name: string,
	node: Node,
	w: Node | undefined,
	opts: Node | undefined,
	param: boolean,
): DffReg {
	const width = widthLit(src, w);
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
	packages: Map<string, SvPkg>,
) {
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
	packages.set(x.id.name, { name: name.value, fns });
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
