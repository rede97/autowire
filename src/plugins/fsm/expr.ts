// Signal expressions (§2.1): typing, width rules, SV printing.

import type { Expression, Node } from "@babel/types";
import type { Binding, DffReg, LetBinding, Sig, Sv, SvPkg } from "./model.ts";
import type { Src } from "./source.ts";

export function lit(width: number, v: bigint): Sv {
	if (width === 1) return { k: "atom", text: `1'b${v}` };
	const digits = Math.ceil(width / 4);
	return {
		k: "atom",
		text: `${width}'h${v.toString(16).padStart(digits, "0")}`,
	};
}

export function constSig(width: number, v: bigint): Sig {
	return { sv: lit(width, v), width, value: v };
}

export function atom(text: string): Sv {
	return { k: "atom", text };
}

const ASSOC: Record<string, true> = {
	"&": true,
	"|": true,
	"^": true,
	"&&": true,
	"||": true,
};

/** Associative chains of one operator print flat; any other nesting is parenthesized. */
export function svText(e: Sv): string {
	const wrap = (c: Sv) =>
		c.k === "bin" || c.k === "tern" ? `(${svText(c)})` : svText(c);
	if (e.k === "atom") return e.text;
	if (e.k === "call") return `${e.fn}(${e.args.map(svText).join(", ")})`;
	if (e.k === "un") return `${e.op}${wrap(e.arg)}`;
	if (e.k === "tern")
		return `${wrap(e.c)} ? ${e.a.k === "tern" ? wrap(e.a) : svText(e.a)} : ${e.b.k === "tern" ? wrap(e.b) : svText(e.b)}`;
	const side = (c: Sv) =>
		(c.k === "bin" && !(c.op === e.op && ASSOC[e.op])) || c.k === "tern"
			? `(${svText(c)})`
			: svText(c);
	return `${side(e.l)} ${e.op} ${side(e.r)}`;
}

export function valName(d: DffReg): string {
	return d.place === "port" ? d.name : `${d.name}_val`;
}

export interface ExprCx {
	src: Src;
	/** Lexical binding, or undefined. */
	lookup(name: string): Binding | undefined;
	/** Binding of a name, `this`, an interface field or a Chan end, or undefined. */
	ref(node: Node): Binding | undefined;
	/** Builtin name an imported local name stands for. */
	builtin(name: string): string | undefined;
	/** User SV package declared at the top level (§2.3). */
	pkg(name: string): SvPkg | undefined;
	/** One wire per distinct call: `fn_<fn>_<n> = pkg::fn(args)`. */
	userCall(pkg: SvPkg, fn: string, args: Sig[], node: Node): Sig;
	/** `let r`: the popped data or inlined result, valid in its producer's segment. */
	useLet(b: LetBinding): Sig;
	/** `x.m(a)` with m an interface method `return <expr>`: the expression (§2.6). */
	macro(node: Expression & { type: "CallExpression" }): Sig | undefined;
}

/** An unsized number literal: takes the width of the other operand. */
type Val = Sig | { lit: bigint; node: Node };

const isLit = (v: Val): v is { lit: bigint; node: Node } => "lit" in v;

/** Non-negative integer literal (widths, indices, wait values). */
export function intLit(src: Src, node: Node | undefined, what: string): bigint {
	if (node?.type !== "NumericLiteral")
		return src.fail(node, `${what} must be an integer literal`);
	const raw = (node.extra?.raw as string | undefined) ?? String(node.value);
	try {
		return BigInt(raw.replaceAll("_", ""));
	} catch {
		return src.fail(node, `${what} must be an integer literal`);
	}
}

export function widthLit(src: Src, node: Node | undefined): number {
	const w = intLit(src, node, "width");
	if (w < 1n || w > 4096n) src.fail(node, "width must be 1..4096");
	return Number(w);
}

/** Literal sized to `width`; errors when it does not fit. */
export function sized(src: Src, node: Node, v: bigint, width: number): Sig {
	if (v >= 1n << BigInt(width))
		src.fail(node, `value ${v} does not fit in ${width} bit(s)`);
	return constSig(width, v);
}

/** `await` is a state; anything else awaited is an error (§3.1, §2.5). */
export const AWAIT_IS_STATE =
	"await marks a state: only await x.wait(v), x.push(v), x.pop() and a sub-FSM call (§3.1); a branch or loop condition is a plain signal expression, e.g. if (a & b) (§2.5)";

/** Evaluate to a signal. `width` sizes a bare literal. */
export function evalSig(
	cx: ExprCx,
	node: Expression,
	o: { width?: number } = {},
): Sig {
	const v = evalVal(cx, node, o.width);
	if (!isLit(v)) {
		if (o.width !== undefined && v.width !== o.width)
			cx.src.fail(node, `width mismatch: expected ${o.width}, got ${v.width}`);
		return v;
	}
	if (o.width === undefined)
		cx.src.fail(
			node,
			"a bare number has no width here; write Const(N, v) or compare it with a signal",
		);
	return sized(cx.src, node, v.lit, o.width);
}

const BIT_OPS: Record<string, true> = { "&": true, "|": true, "^": true };
const CMP_OPS: Record<string, string> = {
	"===": "==",
	"!==": "!=",
	"<": "<",
	">": ">",
	"<=": "<=",
	">=": ">=",
};

/** `hint`: the width the context expects; sizes a ?: whose arms are both bare numbers. */
function evalVal(cx: ExprCx, node: Expression, hint?: number): Val {
	const src: Src = cx.src;
	switch (node.type) {
		case "NumericLiteral":
			return { lit: intLit(src, node, "number"), node };
		case "BooleanLiteral":
			return src.fail(node, "use ALWAYS_1 / ALWAYS_0 for constant conditions");
		case "Identifier": {
			const b = cx.lookup(node.name);
			if (b?.k === "sig" && b.lit !== undefined) {
				if (b.use) b.use.used = true;
				return { lit: b.lit, node };
			}
			if (b) return bindingSig(cx, b, node.name, node);
			const bi = cx.builtin(node.name);
			if (bi === "ALWAYS_0") return constSig(1, 0n);
			if (bi === "ALWAYS_1") return constSig(1, 1n);
			return src.fail(
				node,
				bi ? `${node.name} is not a signal` : `unknown name ${node.name}`,
			);
		}
		case "ThisExpression":
			return src.fail(node, "read a field of this interface: this.<field>");
		case "MemberExpression": {
			if (
				node.property.type === "Identifier" &&
				!node.computed &&
				node.property.name === "val"
			) {
				const b = cx.ref(node.object);
				if (b?.k === "dff") {
					b.read = true;
					return { sv: atom(valName(b)), width: b.width, named: true };
				}
			}
			const b = cx.ref(node);
			if (b) return bindingSig(cx, b, cx.src.textOf(node), node);
			return src.fail(
				node,
				"only <Dff>.val and interface fields can be read from an object",
			);
		}
		case "AwaitExpression":
			return src.fail(node, AWAIT_IS_STATE);
		case "CallExpression":
			return call(cx, node);
		case "UnaryExpression": {
			if (node.operator !== "!" && node.operator !== "~")
				src.fail(node, `operator ${node.operator} is not supported (§2.1)`);
			const arg = evalVal(cx, node.argument);
			if (isLit(arg))
				src.fail(node, `${node.operator} on a bare number; write Const(N, v)`);
			if (node.operator === "!" && arg.width !== 1)
				src.fail(node, `! needs a 1-bit operand, got ${arg.width} bits`);
			return {
				sv: { k: "un", op: node.operator, arg: arg.sv },
				width: arg.width,
			};
		}
		case "LogicalExpression": {
			if (node.operator === "??")
				src.fail(node, "operator ?? is not supported");
			const l = evalSig(cx, node.left, { width: 1 });
			const r = evalSig(cx, node.right, { width: 1 });
			return {
				sv: { k: "bin", op: node.operator, l: l.sv, r: r.sv },
				width: 1,
			};
		}
		case "ConditionalExpression": {
			const c = evalVal(cx, node.test);
			if (isLit(c) || c.width !== 1)
				src.fail(node.test, "the ?: condition is a 1-bit channel");
			const av = evalVal(cx, node.consequent);
			const bv = evalVal(cx, node.alternate);
			if (isLit(av) && isLit(bv) && hint === undefined)
				src.fail(
					node,
					"both ?: arms are bare numbers; write Const(N, v) for one of them",
				);
			const w = isLit(av)
				? isLit(bv)
					? (hint as number)
					: bv.width
				: av.width;
			const a = isLit(av) ? sized(src, av.node, av.lit, w) : av;
			const b = isLit(bv) ? sized(src, bv.node, bv.lit, w) : bv;
			if (a.width !== b.width)
				src.fail(node, `width mismatch: ${a.width} vs ${b.width} bits`);
			return { sv: { k: "tern", c: c.sv, a: a.sv, b: b.sv }, width: w };
		}
		case "BinaryExpression": {
			const op = node.operator;
			if (op === "==" || op === "!=")
				src.fail(node, `use ${op}= instead of ${op} (§2.1)`);
			if (!BIT_OPS[op] && !(op in CMP_OPS))
				src.fail(
					node,
					`operator ${op} is not supported (§2.1); write it as a user SV function`,
				);
			if (node.left.type === "PrivateName")
				return src.fail(node, "unsupported operand");
			const lv = evalVal(cx, node.left);
			const rv = evalVal(cx, node.right);
			if (isLit(lv) && isLit(rv))
				src.fail(node, "both operands are bare numbers");
			const w = isLit(lv) ? (rv as Sig).width : lv.width;
			const l = isLit(lv) ? sized(src, lv.node, lv.lit, w) : lv;
			const r = isLit(rv) ? sized(src, rv.node, rv.lit, w) : rv;
			if (l.width !== r.width)
				src.fail(node, `width mismatch: ${l.width} vs ${r.width} bits`);
			const cmp = CMP_OPS[op];
			return cmp
				? { sv: { k: "bin", op: cmp, l: l.sv, r: r.sv }, width: 1 }
				: { sv: { k: "bin", op, l: l.sv, r: r.sv }, width: w };
		}
		case "ArrayExpression":
			return src.fail(
				node,
				"concatenation is not supported (§2.1); write a user SV function",
			);
		default:
			return src.fail(node, `unsupported expression (${node.type})`);
	}
}

function bindingSig(cx: ExprCx, b: Binding, name: string, node: Node): Sig {
	const src: Src = cx.src;
	switch (b.k) {
		case "input":
			b.used = true;
			return { sv: atom(b.name), width: b.width, named: true };
		case "output":
			return src.fail(
				node,
				`${name} is an output; outputs cannot be read (§6.5)`,
			);
		case "dff":
			return src.fail(node, `read the register through ${name}.val`);
		case "push":
		case "pop":
			return src.fail(
				node,
				`${name} is a channel end; move data with await ${name}.push(v) / ${name}.pop() (§6.2)`,
			);
		case "chan":
			return src.fail(
				node,
				`${name} is a channel; move data with await ${name}.push(v) / ${name}.pop() (§6.2)`,
			);
		case "iface":
			return src.fail(
				node,
				`${name} is an interface; read its fields or call its methods (§2.6)`,
			);
		case "sig":
			if (b.start > (node.start ?? 0))
				src.fail(node, `${name} is used before its declaration`);
			if (b.wire) b.wire.used = true;
			if (b.use) b.use.used = true;
			return b.sig;
		case "let":
			return cx.useLet(b);
	}
}

function call(cx: ExprCx, node: Expression & { type: "CallExpression" }): Sig {
	const src: Src = cx.src;
	if (
		node.callee.type === "Identifier" &&
		cx.builtin(node.callee.name) === "Const"
	) {
		const [w, v] = node.arguments;
		if (node.arguments.length !== 2)
			src.fail(node, "Const(N, v) takes two arguments");
		const width = widthLit(src, w);
		return sized(src, v as Node, intLit(src, v, "Const value"), width);
	}
	const callee = node.callee;
	if (
		callee.type === "MemberExpression" &&
		callee.object.type === "Identifier" &&
		callee.property.type === "Identifier" &&
		!callee.computed &&
		!cx.lookup(callee.object.name)
	) {
		const pkg = cx.pkg(callee.object.name);
		if (pkg) {
			const fn = pkg.fns.get(callee.property.name);
			if (!fn)
				return src.fail(
					callee.property,
					`${pkg.name} declares no function ${callee.property.name}`,
				);
			if (node.arguments.length !== fn.args.length)
				src.fail(
					node,
					`${pkg.name}::${callee.property.name} takes ${fn.args.length} argument(s)`,
				);
			const args = node.arguments.map((a, i) =>
				a.type === "SpreadElement" || a.type === "ArgumentPlaceholder"
					? src.fail(a, "unsupported argument")
					: evalSig(cx, a, { width: fn.args[i] }),
			);
			return cx.userCall(pkg, callee.property.name, args, node);
		}
	}
	if (isMethodCall(node, "bits")) {
		const obj = evalVal(cx, node.callee.object as Expression);
		if (isLit(obj) || !obj.named)
			src.fail(
				node,
				"bits() selects from a named signal: a port, a const, or a Dff .val",
			);
		const args = node.arguments;
		if (args.length < 1 || args.length > 2)
			src.fail(node, "bits(i) or bits(hi, lo)");
		const hi = Number(intLit(src, args[0], "bit index"));
		const lo =
			args.length === 2 ? Number(intLit(src, args[1], "bit index")) : hi;
		if (!(obj.width > hi && hi >= lo && lo >= 0))
			src.fail(
				node,
				`bits(${hi}, ${lo}) is out of range for ${obj.width} bits`,
			);
		const base = svText(obj.sv);
		return {
			sv: atom(args.length === 2 ? `${base}[${hi}:${lo}]` : `${base}[${hi}]`),
			width: hi - lo + 1,
		};
	}
	return cx.macro(node) ?? src.fail(node, "unsupported call in an expression");
}

type MethodCall = Expression & {
	type: "CallExpression";
	callee: {
		type: "MemberExpression";
		object: Expression;
		property: { type: "Identifier"; name: string };
	};
};

/** `<obj>.<name>(...)` with a plain identifier property. */
export function isMethodCall(
	n: Node | null | undefined,
	name?: string,
): n is MethodCall {
	return (
		n?.type === "CallExpression" &&
		n.callee.type === "MemberExpression" &&
		!n.callee.computed &&
		n.callee.property.type === "Identifier" &&
		(name === undefined || n.callee.property.name === name)
	);
}
