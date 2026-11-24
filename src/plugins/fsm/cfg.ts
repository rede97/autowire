// Method body → control-flow graph (§3): states are awaits, everything else
// is a path between two awaits. Expanding a state's path gives its exit tree.

import type {
	Expression,
	Node,
	Statement,
	VariableDeclaration,
} from "@babel/types";
import {
	atom,
	constSig,
	type ExprCx,
	evalSig,
	intLit,
	isMethodCall,
	lit,
	sized,
	svText,
} from "./expr.ts";
import {
	dffDecl,
	type FsmMethod,
	NOT_YET,
	notYet,
	reservedName,
} from "./front.ts";
import type {
	Action,
	Binding,
	BrNode,
	Call,
	CNode,
	DffReg,
	JumpNode,
	LetBinding,
	OutputPort,
	State,
	SubShape,
	Sv,
	SvPkg,
	Wire,
} from "./model.ts";
import { checkSvId, type Src, upperSnake } from "./source.ts";

interface Frame {
	kind: "loop" | "block";
	label?: string;
	breakTo: CNode;
	continueTo?: CNode;
}

class Scope {
	readonly map = new Map<string, Binding>();
	constructor(readonly parent?: Scope) {}
	get(name: string): Binding | undefined {
		return this.map.get(name) ?? this.parent?.get(name);
	}
}

/** Everything the body pass collects for one @Fsm method or sub-FSM. */
export interface Body {
	states: State[];
	actions: Action[];
	wires: Wire[];
	privateDffs: DffReg[];
	/** Top-level: head of the while (true) loop. Sub-FSM: jump to the implicit IDLE. */
	head: JumpNode;
	/** Sub-FSM: generated done / result outputs, in port order. */
	implicitPorts: OutputPort[];
	resultWidth: number;
	calls: Call[];
}

/** Sub-FSMs a method may call: name → compiled shape (null: an @Fsm method). */
export type Callees = Map<string, SubShape | null>;

export class BodyCompiler {
	readonly states: State[] = [];
	readonly actions: Action[] = [];
	readonly wires: Wire[] = [];
	readonly privateDffs: DffReg[] = [];
	/** SV names in the module scope (ports, wires, regs, states). */
	private readonly svNames = new Map<string, Node>();
	/** State, loop and block labels: one namespace (§3.6). */
	private readonly labels = new Set<string>();
	private frames: Frame[] = [];
	private scope = new Scope();
	private readonly ecx: ExprCx;
	/** Distinct user function calls; wire names are given in source order after compile. */
	private readonly calls = new Map<
		string,
		{ wire: Wire; ref: { k: "atom"; text: string }; fn: string }
	>();
	/** Sub-FSM call sites in source order, keyed by their CallExpression. */
	private readonly callAt = new Map<Node, Call>();
	private readonly letAt = new Map<Node, LetBinding>();
	/** let results read by the expression being compiled. */
	private touched: Call[] = [];
	private sub = false;
	/** Sub-FSM: the implicit IDLE wait, where returns go. */
	private back?: CNode;
	private done?: OutputPort;
	private result?: OutputPort;
	private readonly returns: { node: Node; value: boolean }[] = [];

	constructor(
		readonly src: Src,
		private readonly builtins: Map<string, string>,
		packages: Map<string, SvPkg>,
		private readonly callees: Callees,
	) {
		this.ecx = {
			src,
			lookup: (n) => this.scope.get(n),
			builtin: (n) => builtins.get(n),
			pkg: (n) => packages.get(n),
			userCall: (pkg, fn, args, node) => {
				const sv: Sv = {
					k: "call",
					fn: `${pkg.name}::${fn}`,
					args: args.map((a) => a.sv),
				};
				const key = svText(sv);
				let c = this.calls.get(key);
				if (!c) {
					const ref = { k: "atom" as const, text: `fn#${this.calls.size}` };
					const ret = pkg.fns.get(fn)?.ret ?? 1;
					c = {
						wire: { name: ref.text, width: ret, sv, node, used: true },
						ref,
						fn,
					};
					this.calls.set(key, c);
					this.wires.push(c.wire);
				} else if ((node.start ?? 0) < (c.wire.node.start ?? 0))
					c.wire.node = node;
				return { sv: c.ref, width: c.wire.width, named: true };
			},
			useLet: (b) => {
				if (!b.call) return src.fail(b.node, `let ${b.name} is never assigned`);
				this.touched.push(b.call);
				return {
					sv: atom(`${b.call.inst}_result`),
					width: b.call.resultWidth,
					named: true,
				};
			},
		};
	}

	claim(name: string, node: Node) {
		if (this.svNames.has(name))
			this.src.fail(node, `name ${name} is already used in this module`);
		this.svNames.set(name, node);
	}

	compile(m: FsmMethod): Body {
		for (const p of m.ports) {
			this.scope.map.set(p.name, p);
			if (p.k === "dff" && p.place === "external")
				for (const s of ["_set", "_next", "_val"])
					this.claim(p.name + s, p.node);
			else this.claim(p.name, p.node);
			if (p.k === "dff" && p.place === "port")
				this.claim(`u_${p.name}`, p.node);
		}
		const stmts = m.node.body.body;
		this.prescan(stmts, [new Map()]);
		let head: JumpNode;
		if (m.sub) {
			// Implicit IDLE waits for start; the first segment runs on the start cycle (§5).
			this.sub = true;
			const done: OutputPort = {
				k: "output",
				name: "done",
				width: 1,
				node: m.node,
				sites: [],
			};
			this.done = done;
			const idle: State = {
				name: "IDLE",
				member: "IDLE",
				label: "",
				index: -1,
				node: m.node,
				cond: atom("start"),
				next: { k: "end" },
			};
			const back: CNode = { k: "wait", state: idle };
			this.back = back;
			head = { k: "jump", to: back, node: m.node };
			this.states.push(idle);
			const end = this.ret(undefined, m.node.body, back, "end");
			idle.next = this.block(stmts, end);
			if (this.result)
				for (const r of this.returns)
					if (!r.value)
						this.src.fail(
							r.node,
							"every return of this sub-FSM gives a result",
						);
		} else {
			const last = stmts.at(-1);
			const top = last?.type === "LabeledStatement" ? last.body : last;
			if (
				top?.type !== "WhileStatement" ||
				top.test.type !== "BooleanLiteral" ||
				!top.test.value
			)
				return this.src.fail(
					last ?? m.node,
					"a top-level @Fsm body is one `while (true) { ... }` (§3.4)",
				);
			for (const s of stmts.slice(0, -1)) {
				if (s.type !== "VariableDeclaration")
					this.src.fail(
						s,
						"only const / let declarations may come before the while (true) loop (§3.4)",
					);
				this.declare(s);
			}
			const label = last?.type === "LabeledStatement" ? last.label : undefined;
			if (label) this.label(label.name, label);
			const end: CNode = { k: "end" };
			head = { k: "jump", to: end, node: top };
			this.frames.push({
				kind: "loop",
				label: label?.name,
				breakTo: end,
				continueTo: head,
			});
			head.to = this.body(top.body, head);
			this.frames.pop();
		}
		this.states.sort((a, b) => (a.node.start ?? 0) - (b.node.start ?? 0));
		// The CFG is built back to front; actions and write sites read in source order.
		const bySource = (a: { node: Node }, b: { node: Node }) =>
			(a.node.start ?? 0) - (b.node.start ?? 0);
		this.actions.sort(bySource);
		const implicit = [
			...(this.done ? [this.done] : []),
			...(this.result ? [this.result] : []),
		];
		for (const p of [...m.ports, ...this.privateDffs, ...implicit])
			if (p.k !== "input") p.sites.sort(bySource);
		// fn_<fn>_<n>: numbered per function in source order.
		const perFn = new Map<string, number>();
		for (const c of [...this.calls.values()].sort((a, b) =>
			bySource(a.wire, b.wire),
		)) {
			const n = perFn.get(c.fn) ?? 0;
			perFn.set(c.fn, n + 1);
			c.ref.text = c.wire.name = `fn_${c.fn}_${n}`;
			this.claim(c.wire.name, c.wire.node);
		}
		this.wires.sort(bySource);
		const upper = new Map<string, string>();
		this.states.forEach((s, i) => {
			s.index = i;
			if (s.name === "") s.name = `S${i}`;
			const prev = upper.get(s.name);
			if (prev !== undefined)
				this.src.fail(
					s.node,
					`state ${prev || s.name} and this state both become ${s.name} in upper case`,
				);
			upper.set(s.name, s.label);
			s.member = m.options.statePrefix
				? `${m.options.statePrefix}_${s.name}`
				: s.name;
			this.claim(s.member, s.node);
		});
		return {
			states: this.states,
			actions: this.actions,
			wires: this.wires,
			privateDffs: this.privateDffs,
			head,
			implicitPorts: implicit,
			resultWidth: this.result?.width ?? 0,
			calls: [...this.callAt.values()],
		};
	}

	private label(name: string, node: Node) {
		if (this.labels.has(name))
			this.src.fail(node, `label ${name} is already used in this method`);
		this.labels.add(name);
	}

	/** Forward walk before the back-to-front build: give each sub-FSM call its
	 *  instance (source order) and bind every `r = await this.m(...)` to its `let r;`. */
	private prescan(list: Statement[], scopes: Map<string, LetBinding>[]) {
		const src: Src = this.src;
		const visit = (s: Statement): void => {
			if (s.type === "VariableDeclaration" && s.kind === "let")
				for (const x of s.declarations)
					if (x.id.type === "Identifier") {
						const lb: LetBinding = { k: "let", name: x.id.name, node: x };
						scopes.at(-1)?.set(x.id.name, lb);
						this.letAt.set(x, lb);
					}
			if (s.type === "BlockStatement") {
				scopes.push(new Map());
				for (const c of s.body) visit(c);
				scopes.pop();
			}
			if (s.type === "IfStatement") {
				visit(s.consequent);
				if (s.alternate) visit(s.alternate);
			}
			if (
				s.type === "WhileStatement" ||
				s.type === "DoWhileStatement" ||
				s.type === "LabeledStatement"
			)
				visit(s.body);
			if (s.type !== "ExpressionStatement") return;
			const e = s.expression;
			const awaited = e.type === "AssignmentExpression" ? e.right : e;
			const callExpr =
				awaited.type === "AwaitExpression" ? awaited.argument : undefined;
			if (
				callExpr?.type !== "CallExpression" ||
				callExpr.callee.type !== "MemberExpression" ||
				callExpr.callee.object.type !== "ThisExpression" ||
				callExpr.callee.property.type !== "Identifier"
			)
				return;
			const callee = callExpr.callee.property.name;
			const shape = this.callees.get(callee);
			if (shape === undefined)
				src.fail(
					callExpr.callee.property,
					`no method ${callee} in this @FsmGroup`,
				);
			if (shape === null)
				src.fail(
					callExpr,
					`${callee} is an @Fsm method; only sub-FSMs can be called (§5)`,
				);
			const n = [...this.callAt.values()].filter(
				(c) => c.callee === callee,
			).length;
			const call: Call = {
				callee,
				inst: n === 0 ? callee : `${callee}_${n}`,
				node: callExpr,
				conn: [],
				resultWidth: shape.resultWidth,
			};
			this.claim(`u_${call.inst}`, callExpr);
			this.claim(`${call.inst}_done`, callExpr);
			if (call.resultWidth > 0) this.claim(`${call.inst}_result`, callExpr);
			this.callAt.set(callExpr, call);
			if (e.type !== "AssignmentExpression") return;
			if (e.operator !== "=" || e.left.type !== "Identifier")
				src.fail(
					e,
					"write the result as r = await this.sub({...}) with `let r;` (§2.4)",
				);
			const name = e.left.name;
			const lb = [...scopes]
				.reverse()
				.find((m) => m.has(name))
				?.get(name);
			if (!lb)
				src.fail(
					e.left,
					`${name} must be declared with \`let ${name};\` before the call (§2.4)`,
				);
			if (lb.call)
				src.fail(
					e.left,
					`let ${name} is assigned twice; a value that changes needs a Dff (§2.4)`,
				);
			if (call.resultWidth === 0) src.fail(e, `${callee} returns no value`);
			lb.call = call;
		};
		for (const s of list) visit(s);
	}

	/** Sub-FSM exit: done (and result) pulse on the move back to IDLE. */
	private ret(
		value: Expression | null | undefined,
		node: Node,
		back: CNode,
		how: "return" | "end",
	): CNode {
		const src: Src = this.src;
		const done = this.done;
		if (!done) return src.fail(node, "only a sub-FSM returns");
		let next = back;
		if (value) {
			this.touched = [];
			const v = evalSig(
				this.ecx,
				value,
				this.result ? { width: this.result.width } : {},
			);
			this.result ??= {
				k: "output",
				name: "result",
				width: v.width,
				node,
				sites: [],
			};
			if (v.width !== this.result.width)
				src.fail(
					value,
					`result width ${v.width} differs from another return (${this.result.width})`,
				);
			const r: Action = {
				k: "pulse",
				port: this.result,
				value: v,
				text: src.textOf(node),
				node,
				implicit: how,
			};
			this.result.sites.push(r);
			next = this.act(r, next);
		}
		if (how === "return") this.returns.push({ node, value: Boolean(value) });
		const d: Action = {
			k: "pulse",
			port: done,
			value: constSig(1, 1n),
			text: "",
			node,
			implicit: how,
		};
		done.sites.push(d);
		this.touched = [];
		return this.act(d, next);
	}

	private declare(d: VariableDeclaration) {
		const src: Src = this.src;
		if (d.kind === "let") {
			for (const x of d.declarations) {
				if (x.init)
					src.fail(
						x,
						"a `let` cannot take a value here; a value that changes needs a Dff (§2.4)",
					);
				const lb = this.letAt.get(x);
				if (!lb?.call)
					return src.fail(
						x,
						"a `let` is only assigned once, by r = await this.sub({...}) (§2.4)",
					);
				this.scope.map.set(lb.name, lb);
			}
			return;
		}
		if (d.kind !== "const") src.fail(d, "declare channels with const (§2.4)");
		for (const x of d.declarations) {
			if (x.id.type !== "Identifier")
				return src.fail(x.id, "destructuring is not supported");
			const name = x.id.name;
			const init = x.init;
			if (!init) return src.fail(x, "const needs a value");
			const kind =
				init.type === "CallExpression" && init.callee.type === "Identifier"
					? this.builtins.get(init.callee.name)
					: undefined;
			if (kind && NOT_YET[kind]) notYet(src, init, NOT_YET[kind]);
			if (kind === "Input" || kind === "Output")
				src.fail(
					init,
					`${kind}(...) declares a port; write it in the method parameters`,
				);
			if (kind === "Dff" && init.type === "CallExpression") {
				checkSvId(src, x.id, name, "register");
				if (reservedName(name))
					src.fail(x.id, `name ${name} is reserved by the generator`);
				const reg = dffDecl(
					src,
					name,
					x,
					init.arguments[0],
					init.arguments[1],
					false,
				);
				this.claim(`${name}_val`, x);
				this.claim(`u_${name}`, x);
				this.privateDffs.push(reg);
				this.scope.map.set(name, reg);
				continue;
			}
			this.touched = [];
			const sig = evalSig(this.ecx, init);
			if (this.touched.length > 0)
				src.fail(
					init,
					"a sub-FSM result is valid only on its done cycle; latch it with Dff.set(r) (§2.4)",
				);
			const start = x.start ?? 0;
			if (sig.value !== undefined || sig.named) {
				this.scope.map.set(name, { k: "chan", sig, start });
				continue;
			}
			checkSvId(src, x.id, name, "const");
			if (reservedName(name))
				src.fail(x.id, `name ${name} is reserved by the generator`);
			this.claim(name, x);
			const wire: Wire = {
				name,
				width: sig.width,
				sv: sig.sv,
				node: x,
				used: false,
			};
			this.wires.push(wire);
			this.scope.map.set(name, {
				k: "chan",
				sig: { sv: atom(name), width: sig.width, named: true },
				start,
				wire,
			});
		}
	}

	private block(list: Statement[], k: CNode): CNode {
		const outer = this.scope;
		this.scope = new Scope(outer);
		try {
			list.forEach((s, i) => {
				if (
					(s.type === "BreakStatement" ||
						s.type === "ContinueStatement" ||
						s.type === "ReturnStatement") &&
					i + 1 < list.length
				)
					this.src.fail(
						list[i + 1],
						"unreachable statement after break / continue",
					);
				if (s.type === "VariableDeclaration") this.declare(s);
			});
			let next = k;
			for (const s of [...list].reverse()) next = this.stmt(s, next);
			return next;
		} finally {
			this.scope = outer;
		}
	}

	private body(s: Statement, k: CNode): CNode {
		return s.type === "BlockStatement"
			? this.block(s.body, k)
			: this.stmt(s, k);
	}

	/** Condition plus the let results it reads (checked when the state's exits expand). */
	private cond(test: Expression): [Sv | boolean, Call[]] {
		this.touched = [];
		const sig = evalSig(this.ecx, test, { cond: true });
		const needs = this.touched;
		this.touched = [];
		if (sig.width !== 1)
			this.src.fail(
				test,
				`a condition is 1 bit, got ${sig.width}; compare with === (§2.1)`,
			);
		return [sig.value !== undefined ? sig.value === 1n : sig.sv, needs];
	}

	private stmt(s: Statement, k: CNode): CNode {
		const src: Src = this.src;
		switch (s.type) {
			case "EmptyStatement":
			case "VariableDeclaration":
				return k;
			case "BlockStatement":
				return this.block(s.body, k);
			case "LabeledStatement":
				return this.labeled(s, k);
			case "ExpressionStatement":
				return this.expression(s.expression, s, k, undefined);
			case "IfStatement": {
				const [c, needs] = this.cond(s.test);
				const yes = c === false ? k : this.body(s.consequent, k);
				const no = s.alternate && c !== true ? this.body(s.alternate, k) : k;
				if (typeof c === "boolean") return c ? yes : no;
				return { k: "br", cond: c, yes, no, node: s, needs };
			}
			case "WhileStatement":
			case "DoWhileStatement":
				return this.loop(s, k, undefined);
			case "BreakStatement":
			case "ContinueStatement": {
				const brk = s.type === "BreakStatement";
				const name = s.label?.name;
				const f = [...this.frames]
					.reverse()
					.find((x) => (name ? x.label === name : x.kind === "loop"));
				const to = brk ? f?.breakTo : f?.continueTo;
				if (!to) return src.fail(s, "no matching loop or block for this jump");
				return { k: "jump", to, node: s };
			}
			case "ReturnStatement":
				if (!this.sub || !this.back)
					return src.fail(
						s,
						"a top-level @Fsm never returns (§3.4); end a one-shot flow in a trap state: await ALWAYS_0.wait(1)",
					);
				return this.ret(s.argument, s, this.back, "return");
			case "TryStatement":
			case "ThrowStatement":
				return notYet(src, s, "exception regions (§3.7)");
			case "ForStatement":
			case "ForInStatement":
			case "ForOfStatement":
				return src.fail(
					s,
					"for loops are not supported (§3.6); use while / do ... while",
				);
			case "SwitchStatement":
				return src.fail(s, "switch is not supported (§11); use if / else");
			default:
				return src.fail(s, `unsupported statement (${s.type})`);
		}
	}

	private loop(
		s: Statement & { type: "WhileStatement" | "DoWhileStatement" },
		k: CNode,
		label: string | undefined,
	): CNode {
		const forever = s.test.type === "BooleanLiteral";
		if (s.test.type === "BooleanLiteral" && !s.test.value)
			this.src.fail(s.test, "the loop condition is always false");
		const [c, needs] = forever ? [true, []] : this.cond(s.test);
		if (c === false)
			this.src.fail(s.test, "the loop condition is always false");
		const head: JumpNode | BrNode =
			c === true
				? { k: "jump", to: k, node: s }
				: { k: "br", cond: c, yes: k, no: k, node: s, needs };
		this.frames.push({ kind: "loop", label, breakTo: k, continueTo: head });
		const entry = this.body(s.body, head);
		this.frames.pop();
		if (head.k === "jump") head.to = entry;
		else head.yes = entry;
		return s.type === "WhileStatement" ? head : entry;
	}

	private labeled(
		s: Statement & { type: "LabeledStatement" },
		k: CNode,
	): CNode {
		const src: Src = this.src;
		const name = s.label.name;
		const b = s.body;
		if (b.type === "LabeledStatement")
			return src.fail(b, "one label per statement (§3.5)");
		if (b.type === "WhileStatement" || b.type === "DoWhileStatement") {
			this.label(name, s.label);
			return this.loop(b, k, name);
		}
		if (b.type === "BlockStatement") {
			this.label(name, s.label);
			this.frames.push({ kind: "block", label: name, breakTo: k });
			const entry = this.block(b.body, k);
			this.frames.pop();
			return entry;
		}
		if (
			b.type === "ExpressionStatement" &&
			(b.expression.type === "AwaitExpression" ||
				(b.expression.type === "AssignmentExpression" &&
					b.expression.right.type === "AwaitExpression"))
		)
			return this.expression(b.expression, b, k, s);
		return src.fail(
			s,
			"a label names an await state, a loop or a block (§3.5)",
		);
	}

	private expression(
		e: Expression,
		stmt: Node,
		k: CNode,
		label: (Node & { type: "LabeledStatement" }) | undefined,
	): CNode {
		const src: Src = this.src;
		this.touched = [];
		const awaited =
			e.type === "AssignmentExpression" && e.right.type === "AwaitExpression"
				? e.right
				: e;
		if (awaited.type === "AwaitExpression") {
			const a = awaited.argument;
			if (a.type === "CallExpression" && this.callAt.has(a))
				return this.callState(a, stmt, k, label);
			if (awaited !== e)
				src.fail(
					e,
					"only a sub-FSM result can be assigned: r = await this.sub({...})",
				);
			if (isMethodCall(a, "wait")) return this.wait(a, stmt, k, label);
			if (isMethodCall(a, "read"))
				src.fail(
					e,
					"the read() value is unused; read() belongs in an if / while condition (§4)",
				);
			if (a.type === "CallExpression" && a.callee.type === "MemberExpression") {
				if (
					a.callee.object.type === "Identifier" &&
					a.callee.object.name === "Promise"
				)
					notYet(src, a, "Promise.all (§6.3)");
			}
			return src.fail(e, "await x.wait(v) is the only state in this version");
		}
		if (isMethodCall(e) && e.callee.object.type === "Identifier") {
			const verb = e.callee.property.name;
			const b = this.scope.get(e.callee.object.name);
			if (verb === "pulse" && b?.k === "output") {
				const arg = e.arguments[0];
				if (
					e.arguments.length > 1 ||
					arg?.type === "SpreadElement" ||
					arg?.type === "ArgumentPlaceholder"
				)
					return src.fail(e, "pulse() or pulse(v)");
				if (!arg && b.width > 1)
					src.fail(
						e,
						`${b.name} is ${b.width} bits: write ${b.name}.pulse(value)`,
					);
				const value = arg
					? evalSig(this.ecx, arg, { width: b.width })
					: constSig(1, 1n);
				const act: Action = {
					k: "pulse",
					port: b,
					value,
					text: src.textOf(e),
					node: e,
				};
				b.sites.push(act);
				return this.act(act, k);
			}
			if (verb === "set" && b?.k === "dff") {
				const v = e.arguments[0];
				if (
					e.arguments.length !== 1 ||
					!v ||
					v.type === "SpreadElement" ||
					v.type === "ArgumentPlaceholder"
				)
					return src.fail(e, "set(v) takes one value");
				const value = evalSig(this.ecx, v, { width: b.width });
				const act: Action = {
					k: "set",
					dff: b,
					value,
					text: src.textOf(e),
					node: e,
				};
				b.sites.push(act);
				return this.act(act, k);
			}
			if (verb === "push" || verb === "pop")
				notYet(src, e, "push / pop (§6.2)");
		}
		if (e.type === "AssignmentExpression")
			src.fail(
				e,
				"assignment is not supported; a value that changes needs a Dff (§2.4)",
			);
		return src.fail(
			e,
			"unsupported statement: expected await x.wait(v), x.pulse() or d.set(v)",
		);
	}

	private act(act: Action, k: CNode): CNode {
		this.actions.push(act);
		const needs = this.touched;
		this.touched = [];
		return { k: "act", act, next: k, needs };
	}

	/** `[S:] [r =] await this.sub({ port: channel, ... })`: a state left on <inst>_done (§5). */
	private callState(
		callExpr: Expression & { type: "CallExpression" },
		stmt: Node,
		k: CNode,
		label: (Node & { type: "LabeledStatement" }) | undefined,
	): CNode {
		const src: Src = this.src;
		const call = this.callAt.get(callExpr);
		const shape = call ? this.callees.get(call.callee) : undefined;
		if (!call || !shape) return src.fail(callExpr, "unknown sub-FSM call");
		const arg = callExpr.arguments[0];
		if (callExpr.arguments.length !== 1 || arg?.type !== "ObjectExpression")
			return src.fail(
				callExpr,
				`connect ${call.callee}'s ports with one object: this.${call.callee}({ port: channel, ... })`,
			);
		const given = new Map<string, Expression>();
		for (const p of arg.properties) {
			if (
				p.type !== "ObjectProperty" ||
				p.key.type !== "Identifier" ||
				p.computed ||
				p.value.type === "AssignmentPattern"
			)
				return src.fail(p, "each connection is port: channel");
			const key = p.key.name;
			if (!shape.ports.some((q) => q.name === key))
				src.fail(p.key, `${call.callee} has no port ${key}`);
			if (given.has(key)) src.fail(p.key, `port ${key} is connected twice`);
			given.set(key, p.value as Expression);
		}
		for (const p of shape.ports) {
			const v = given.get(p.name);
			if (!v)
				return src.fail(
					arg,
					`port ${p.name} of ${call.callee} is not connected`,
				);
			if (p.k === "input") {
				this.touched = [];
				const sig = evalSig(this.ecx, v, { width: p.width });
				if (this.touched.length > 0)
					src.fail(
						v,
						"a sub-FSM result is valid only on its done cycle; latch it with Dff.set(r) (§2.4)",
					);
				call.conn.push({ port: p.name, sv: sig.sv });
			} else if (p.k === "output") {
				const b = v.type === "Identifier" ? this.scope.get(v.name) : undefined;
				if (b?.k !== "output" || b.width !== p.width)
					return src.fail(
						v,
						`${p.name} is a ${p.width}-bit Output of ${call.callee}: connect a ${p.width}-bit Output of this method`,
					);
				if (b.byCall)
					src.fail(v, `${b.name} is already driven by ${b.byCall.inst}`);
				b.byCall = call;
				call.conn.push({ port: p.name, sv: atom(b.name) });
			} else {
				notYet(src, v, "connecting a Dff port of a sub-FSM");
			}
		}
		let name = "";
		if (label) {
			checkSvId(src, label.label, label.label.name, "state");
			this.label(label.label.name, label.label);
			name = upperSnake(label.label.name);
			if (this.sub && name === "IDLE")
				src.fail(label.label, "IDLE is the implicit entry of a sub-FSM (§5)");
		}
		const state: State = {
			name,
			member: "",
			label: label?.label.name ?? "",
			index: -1,
			node: label ?? stmt,
			cond: atom(`${call.inst}_done`),
			next: k,
			call,
		};
		call.state = state;
		this.states.push(state);
		this.touched = [];
		return { k: "wait", state };
	}

	private wait(
		call: Expression & { type: "CallExpression" },
		stmt: Node,
		k: CNode,
		label: (Node & { type: "LabeledStatement" }) | undefined,
	): CNode {
		const src: Src = this.src;
		if (call.callee.type !== "MemberExpression")
			return src.fail(call, "x.wait(v)");
		this.touched = [];
		const sig = evalSig(this.ecx, call.callee.object as Expression);
		if (this.touched.length > 0)
			src.fail(
				call,
				"a sub-FSM result is valid only on its done cycle; latch it with Dff.set(r) (§2.4)",
			);
		const arg = call.arguments[0];
		if (call.arguments.length !== 1 || !arg)
			return src.fail(call, "wait(v) takes one value");
		const v = intLit(src, arg, "wait value");
		sized(src, arg, v, sig.width);
		const cond: Sv | boolean =
			sig.value !== undefined
				? sig.value === v
				: sig.width === 1
					? v === 1n
						? sig.sv
						: { k: "un", op: "!", arg: sig.sv }
					: { k: "bin", op: "==", l: sig.sv, r: lit(sig.width, v) };
		let name = "";
		if (label) {
			checkSvId(src, label.label, label.label.name, "state");
			this.label(label.label.name, label.label);
			name = upperSnake(label.label.name);
			if (this.sub && name === "IDLE")
				src.fail(label.label, "IDLE is the implicit entry of a sub-FSM (§5)");
		}
		const state: State = {
			name,
			member: "",
			label: label?.label.name ?? "",
			index: -1,
			node: label ?? stmt,
			cond,
			next: k,
		};
		this.states.push(state);
		return { k: "wait", state };
	}
}
