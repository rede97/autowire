// Method body → control-flow graph (§3): states are awaits, everything else
// is a path between two awaits. Sub-FSM and interface calls are inlined:
// their states join the caller's state register (§5).

import type {
	ClassMethod,
	Expression,
	Node,
	Statement,
	VariableDeclaration,
} from "@babel/types";
import {
	AWAIT_IS_STATE,
	atom,
	type ExprCx,
	evalSig,
	intLit,
	isMethodCall,
	lit,
	sized,
	svText,
	widthLit,
} from "./expr.ts";
import { dffDecl, hsPort, NOT_YET, notYet, reservedName } from "./front.ts";
import type {
	Action,
	Binding,
	BrNode,
	Chan,
	CNode,
	DffReg,
	FsmMethod,
	Group,
	Iface,
	Inst,
	JumpNode,
	Key,
	LetBinding,
	LetSource,
	Port,
	Sig,
	State,
	Sv,
	Unit,
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

/** A call the compiler inlines: a sub-FSM (`this.m({...})`) or an interface method (`x.m(a)`). */
type Callee =
	| { k: "sub"; m: FsmMethod }
	| { k: "iface"; x: Iface; m: ClassMethod; name: string };

/** Where `return` goes inside an inlined call (§5). */
interface Ret {
	to: CNode;
	callee: string;
	/** The caller's `r =`: filled by the first return with a value. */
	result?: LetSource;
	width?: number;
	values: { node: Node; value: boolean }[];
}

/** Everything the body pass collects for one @Fsm method. */
export interface Body {
	states: State[];
	actions: Action[];
	wires: Wire[];
	privateDffs: DffReg[];
	chans: Chan[];
	insts: Inst[];
	/** Head of the while (true) loop. */
	head: JumpNode;
}

const byKey = (a: { key: Key }, b: { key: Key }) => {
	const n = Math.min(a.key.length, b.key.length);
	for (let i = 0; i < n; i++) {
		const d = (a.key[i] ?? 0) - (b.key[i] ?? 0);
		if (d !== 0) return d;
	}
	return a.key.length - b.key.length;
};

/** SV names a port takes in the module. */
export function portNames(p: Port): string[] {
	if (p.k === "push" || p.k === "pop")
		return [`${p.name}_vld`, `${p.name}_rdy`, `${p.name}_data`];
	if (p.k === "dff" && p.place === "external")
		return [`${p.name}_set`, `${p.name}_next`, `${p.name}_val`];
	if (p.k === "dff" && p.place === "port") return [p.name, `u_${p.name}`];
	return [p.name];
}

const LET_LATE =
	"a let value is valid only in the segment its producer ends; latch it with Dff.set(r) (§2.4)";

const KIND_TEXT: Record<string, string> = {
	output: "Output",
	dff: "Dff",
	push: "PushPort",
	pop: "PopPort",
};

/** Constructor arguments of an interface: equal ones mean equal widths. */
const svArgs = (x: Iface) => x.args.join(", ");

export class BodyCompiler {
	readonly states: State[] = [];
	readonly actions: Action[] = [];
	readonly wires: Wire[] = [];
	readonly privateDffs: DffReg[] = [];
	readonly chans: Chan[] = [];
	readonly insts: Inst[] = [];
	/** SV names in the module scope (ports, wires, regs, states). */
	private readonly svNames = new Map<string, Node>();
	/** State, loop and block labels of the method being compiled: one namespace (§3.6). */
	private labels = new Set<string>();
	private frames: Frame[] = [];
	private scope = new Scope();
	private readonly ecx: ExprCx;
	/** Distinct user function calls; wire names are given in source order after compile. */
	private readonly calls = new Map<
		string,
		{ wire: Wire; ref: { k: "atom"; text: string }; fn: string }
	>();
	/** let values read by the expression being compiled. */
	private touched: LetSource[] = [];
	private readonly lets: { b: LetBinding; src: Src }[] = [];
	/** Inlining context: the file, `this.m` group, return target, name prefixes, sort key. */
	private unit: Unit;
	private group?: Group;
	private ret?: Ret;
	private statePrefix = "";
	private svPrefix = "";
	private key: Key = [];
	/** Inside a sync interface method: actions only. */
	private sync = false;
	private readonly stack: Node[] = [];
	private readonly instCount = new Map<string, number>();

	constructor(
		unit: Unit,
		/** Sub-FSMs inlined anywhere (for "never called"). */
		private readonly used: Set<Node>,
	) {
		this.unit = unit;
		const self = this;
		this.ecx = {
			get src() {
				return self.unit.src;
			},
			lookup: (n) => this.scope.get(n),
			ref: (n) => this.ref(n),
			builtin: (n) => this.unit.builtins.get(n),
			pkg: (n) => this.unit.packages.get(n),
			userCall: (pkg, fn, args, node) => {
				const sv: Sv = {
					k: "call",
					fn: `${pkg.name}::${fn}`,
					args: args.map((a) => a.sv),
				};
				const key = svText(sv);
				const at = this.at(node);
				let c = this.calls.get(key);
				if (!c) {
					const ref = { k: "atom" as const, text: `fn#${this.calls.size}` };
					const ret = pkg.fns.get(fn)?.ret ?? 1;
					c = {
						wire: { name: ref.text, width: ret, sv, node, key: at, used: true },
						ref,
						fn,
					};
					this.calls.set(key, c);
					this.wires.push(c.wire);
				} else if (byKey({ key: at }, c.wire) < 0) {
					c.wire.node = node;
					c.wire.key = at;
				}
				return { sv: c.ref, width: c.wire.width, named: true };
			},
			useLet: (b) => {
				if (!b.src)
					return this.src.fail(
						b.node,
						`let ${b.name} is read before it is assigned (§2.4)`,
					);
				b.read = true;
				if (b.src.port) b.src.port.read = true;
				this.touched.push(b.src);
				return {
					sv: b.src.sv,
					width: b.src.width,
					named: b.src.sv.k === "atom",
				};
			},
			macro: (node) => this.macro(node),
		};
	}

	private get src(): Src {
		return this.unit.src;
	}

	private at(node: Node): Key {
		return [...this.key, node.start ?? 0];
	}

	claim(name: string, node: Node) {
		if (this.svNames.has(name))
			this.src.fail(node, `name ${name} is already used in this module`);
		this.svNames.set(name, node);
	}

	/** One @Fsm method: optional const / let / Instance lines, then `while (true) { ... }`. */
	compile(m: FsmMethod): Body {
		this.group = m.group;
		for (const [name, p] of m.params) this.scope.map.set(name, p);
		for (const p of m.ports)
			for (const n of portNames(p)) this.claim(n, p.node);
		const stmts = m.node.body.body;
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
			if (s.type === "VariableDeclaration") this.declare(s, true);
			else if (
				s.type === "ExpressionStatement" &&
				s.expression.type === "CallExpression" &&
				s.expression.callee.type === "Identifier" &&
				this.unit.builtins.get(s.expression.callee.name) === "Instance"
			)
				this.instance(s.expression);
			else
				this.src.fail(
					s,
					"only const / let declarations and Instance(...) may come before the while (true) loop (§3.4)",
				);
		}
		const label = last?.type === "LabeledStatement" ? last.label : undefined;
		if (label) this.label(label.name, label);
		const end: CNode = { k: "end" };
		const head: JumpNode = { k: "jump", to: end, node: top };
		this.frames.push({
			kind: "loop",
			label: label?.name,
			breakTo: end,
			continueTo: head,
		});
		head.to = this.body(top.body, head);
		this.frames.pop();
		this.finish(m);
		return {
			states: this.states,
			actions: this.actions,
			wires: this.wires,
			privateDffs: this.privateDffs,
			chans: this.chans,
			insts: this.insts,
			head,
		};
	}

	/** Source order, generated names and the checks that need the whole body. */
	private finish(m: FsmMethod) {
		this.unit = m.group.unit;
		this.states.sort(byKey);
		this.actions.sort(byKey);
		for (const p of [...m.ports, ...this.privateDffs])
			if (p.k === "output" || p.k === "dff") p.sites.sort(byKey);
		for (const c of this.chans)
			for (const e of [c.tx, c.rx]) e.sites.sort(byKey);
		for (const p of m.ports)
			if (p.k === "push" || p.k === "pop") p.sites.sort(byKey);
		// fn_<fn>_<n>: numbered per function in source order.
		const perFn = new Map<string, number>();
		for (const c of [...this.calls.values()].sort((a, b) =>
			byKey(a.wire, b.wire),
		)) {
			const n = perFn.get(c.fn) ?? 0;
			perFn.set(c.fn, n + 1);
			c.ref.text = c.wire.name = `fn_${c.fn}_${n}`;
			this.claim(c.wire.name, c.wire.node);
		}
		this.wires.sort(byKey);
		const upper = new Map<string, string>();
		this.states.forEach((s, i) => {
			s.index = i;
			if (s.name === "") s.name = `${s.prefix}S${i}`;
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
		for (const c of this.chans) {
			if (c.tx.sites.length > 0 && c.rx.sites.length > 0)
				this.src.fail(
					c.node,
					`${c.name}: this module pushes and pops on one channel; connect one end to an Instance (§5.3)`,
				);
			if (c.tx.sites.length === 0 && !c.tx.byInst)
				this.src.fail(c.node, `nobody pushes into channel ${c.name}`);
			if (c.rx.sites.length === 0 && !c.rx.byInst)
				this.src.fail(c.node, `nobody pops from channel ${c.name}`);
			if (c.rx.sites.length > 0 && !c.rx.read)
				this.src.fail(c.node, `the data popped from ${c.name} is never read`);
		}
		for (const { b, src } of this.lets)
			if (!b.read)
				src.fail(
					b.node,
					b.src
						? `let ${b.name} is never read; drop \`${b.name} =\``
						: `let ${b.name} is never assigned`,
				);
	}

	private label(name: string, node: Node) {
		if (this.labels.has(name))
			this.src.fail(node, `label ${name} is already used in this method`);
		this.labels.add(name);
	}

	/** A name, `this`, an interface field (`x.f`, `this.f`) or a Chan end (`c.tx`). */
	private ref(e: Node): Binding | undefined {
		if (e.type === "Identifier") return this.scope.get(e.name);
		if (e.type === "ThisExpression") return this.scope.get("this");
		if (
			e.type !== "MemberExpression" ||
			e.computed ||
			e.property.type !== "Identifier"
		)
			return undefined;
		const base = this.ref(e.object);
		const f = e.property.name;
		if (base?.k === "iface") return base.fields.get(f);
		if (base?.k === "chan")
			return f === "tx" ? base.tx : f === "rx" ? base.rx : undefined;
		return undefined;
	}

	/** `top`: the @Fsm head before while (true), where Chan is allowed. */
	private declare(d: VariableDeclaration, top: boolean) {
		const src: Src = this.src;
		if (this.sync)
			src.fail(
				d,
				"a sync interface method holds actions only; no declarations",
			);
		if (d.kind === "let") {
			for (const x of d.declarations) {
				if (x.id.type !== "Identifier")
					return src.fail(x.id, "destructuring is not supported");
				if (x.init)
					src.fail(
						x,
						"a `let` cannot take a value here; a value that changes needs a Dff (§2.4)",
					);
				const lb: LetBinding = {
					k: "let",
					name: x.id.name,
					node: x,
					read: false,
				};
				this.lets.push({ b: lb, src });
				this.scope.map.set(lb.name, lb);
			}
			return;
		}
		if (d.kind !== "const") src.fail(d, "declare signals with const (§2.4)");
		for (const x of d.declarations) {
			if (x.id.type !== "Identifier")
				return src.fail(x.id, "destructuring is not supported");
			const name = x.id.name;
			const sv = this.svPrefix + name;
			const init = x.init;
			if (!init) return src.fail(x, "const needs a value");
			const kind =
				init.type === "CallExpression" && init.callee.type === "Identifier"
					? this.unit.builtins.get(init.callee.name)
					: undefined;
			if (kind && NOT_YET[kind]) notYet(src, init, NOT_YET[kind]);
			if (
				kind === "Input" ||
				kind === "Output" ||
				kind === "PushPort" ||
				kind === "PopPort"
			)
				src.fail(
					init,
					`${kind}(...) declares a port; write it in the method parameters`,
				);
			if (kind === "Instance")
				src.fail(init, "Instance(...) is a statement, not a value (§5.3)");
			if (
				(kind === "Dff" || kind === "Chan") &&
				init.type === "CallExpression"
			) {
				checkSvId(src, x.id, name, kind === "Dff" ? "register" : "channel");
				if (reservedName(name))
					src.fail(x.id, `name ${name} is reserved by the generator`);
				const [a0, a1] = init.arguments;
				const width = widthLit(src, a0);
				if (kind === "Dff") {
					const reg = dffDecl(src, sv, x, width, a1, false);
					this.claim(`${sv}_val`, x);
					this.claim(`u_${sv}`, x);
					this.privateDffs.push(reg);
					this.scope.map.set(name, reg);
					continue;
				}
				if (!top)
					src.fail(
						x,
						"a Chan belongs before while (true) of an @Fsm method (§5.3)",
					);
				if (a1) src.fail(a1, "Chan(N) takes one width");
				const c: Chan = {
					k: "chan",
					name: sv,
					width,
					node: x,
					tx: hsPort("push", sv, width, "chan", x),
					rx: hsPort("pop", sv, width, "chan", x),
				};
				for (const n of portNames(c.tx)) this.claim(n, x);
				this.chans.push(c);
				this.scope.map.set(name, c);
				continue;
			}
			this.touched = [];
			const sig = evalSig(this.ecx, init);
			if (this.touched.length > 0) src.fail(init, LET_LATE);
			const start = x.start ?? 0;
			if (sig.value !== undefined || sig.named) {
				this.scope.map.set(name, { k: "sig", sig, start });
				continue;
			}
			checkSvId(src, x.id, name, "const");
			if (reservedName(name))
				src.fail(x.id, `name ${name} is reserved by the generator`);
			this.claim(sv, x);
			const wire: Wire = {
				name: sv,
				width: sig.width,
				sv: sig.sv,
				node: x,
				key: this.at(x),
				used: false,
			};
			this.wires.push(wire);
			this.scope.map.set(name, {
				k: "sig",
				sig: { sv: atom(sv), width: sig.width, named: true },
				start,
				wire,
			});
		}
	}

	/** `Instance(this.m | Group.m, { port: ..., ... })`: an independent process (§5.3). */
	private instance(e: Expression & { type: "CallExpression" }) {
		const src: Src = this.src;
		const [t, conns] = e.arguments;
		const target = t?.type === "MemberExpression" ? this.method(t) : undefined;
		if (
			!target ||
			e.arguments.length !== 2 ||
			conns?.type !== "ObjectExpression"
		)
			return src.fail(
				e,
				"Instance(this.fsm | Group.fsm, { port: signal or channel, ... })",
			);
		if (target.sub)
			src.fail(
				t,
				`${target.name} is a sub-FSM: call it with await this.${target.name}({...}) (§5); Instance takes an @Fsm method`,
			);
		const n = this.instCount.get(target.name) ?? 0;
		this.instCount.set(target.name, n + 1);
		const inst: Inst = {
			name: n === 0 ? `u_${target.name}` : `u_${target.name}_${n}`,
			module: target.name,
			node: e,
			conn: [],
		};
		this.claim(inst.name, e);
		const given = this.args(conns, target.name, [...target.params.keys()]);
		for (const [name, p] of target.params) {
			const v = given.get(name) as Expression;
			if (p.k !== "iface") {
				this.connect(inst, p, v);
				continue;
			}
			const b = this.ref(v);
			if (b?.k !== "iface" || b.cls !== p.cls || svArgs(b) !== svArgs(p))
				src.fail(
					v,
					`${name} is a ${p.cls.name}(${svArgs(p)}): connect an interface of the same class and arguments`,
				);
			for (const [f, q] of p.fields) this.connect(inst, q, v, b.fields.get(f));
		}
		this.insts.push(inst);
	}

	/** `{ port: value, ... }` checked against the callee's port names. */
	private args(
		o: Expression & { type: "ObjectExpression" },
		callee: string,
		names: string[],
	): Map<string, Expression> {
		const src: Src = this.src;
		const given = new Map<string, Expression>();
		for (const p of o.properties) {
			if (
				p.type !== "ObjectProperty" ||
				p.key.type !== "Identifier" ||
				p.computed ||
				p.value.type === "AssignmentPattern"
			)
				return src.fail(p, "each connection is port: value");
			const key = p.key.name;
			if (!names.includes(key)) src.fail(p.key, `${callee} has no port ${key}`);
			if (given.has(key)) src.fail(p.key, `port ${key} is connected twice`);
			given.set(key, p.value as Expression);
		}
		for (const n of names)
			if (!given.has(n)) src.fail(o, `port ${n} of ${callee} is not connected`);
		return given;
	}

	/** One instance port: a signal into an Input, this module's Output out of an
	 *  Output, a channel end or a forwarded channel port for PushPort / PopPort. */
	private connect(inst: Inst, p: Port, v: Expression, field?: Port) {
		const src: Src = this.src;
		if (p.k === "input") {
			const b = field ?? undefined;
			let text: string;
			if (b) {
				if (b.k !== "input")
					return src.fail(v, `${p.name} of ${inst.module} is an Input`);
				b.used = true;
				text = b.name;
			} else {
				this.touched = [];
				text = svText(evalSig(this.ecx, v, { width: p.width }).sv);
				if (this.touched.length > 0) src.fail(v, LET_LATE);
			}
			inst.conn.push([p.name, text]);
			return;
		}
		const b = field ?? this.ref(v);
		if (p.k === "output" || (p.k === "dff" && p.place === "port")) {
			if (b?.k !== "output" || b.width !== p.width)
				return src.fail(
					v,
					`${p.name} is a ${p.width}-bit output of ${inst.module}: connect a ${p.width}-bit Output of this method`,
				);
			if (b.byInst)
				src.fail(v, `${b.name} is already driven by ${b.byInst.name}`);
			b.byInst = inst;
			inst.conn.push([p.name, b.name]);
			return;
		}
		if (p.k === "dff")
			return notYet(src, v, "connecting an external Dff port of an instance");
		const end = b?.k === "chan" ? (p.k === "push" ? b.tx : b.rx) : b;
		if (
			(end?.k !== "push" && end?.k !== "pop") ||
			end.k !== p.k ||
			end.width !== p.width
		)
			return src.fail(
				v,
				`${p.name} is a ${p.width}-bit ${p.k === "push" ? "PushPort" : "PopPort"} of ${inst.module}: connect a Chan of that width or a ${p.k === "push" ? "PushPort" : "PopPort"} of this method`,
			);
		if (end.byInst)
			src.fail(v, `${end.name} is already connected to ${end.byInst.name}`);
		end.byInst = inst;
		for (const s of ["_vld", "_rdy", "_data"])
			inst.conn.push([p.name + s, end.name + s]);
	}

	/** `this.m` / `Group.m`: a method of this group or an imported one. */
	private method(
		e: Expression & { type: "MemberExpression" },
	): FsmMethod | undefined {
		if (e.computed || e.property.type !== "Identifier") return undefined;
		const g =
			e.object.type === "ThisExpression" && !this.scope.get("this")
				? this.group
				: e.object.type === "Identifier" && !this.scope.get(e.object.name)
					? this.unit.groups.get(e.object.name)
					: undefined;
		if (!g) return undefined;
		const name = e.property.name;
		const m = g.methods.find((x) => x.name === name);
		return (
			m ?? this.src.fail(e.property, `no method ${name} in @FsmGroup ${g.name}`)
		);
	}

	/** Statements compile front to back: each one continues at a jump patched to the next. */
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
						"unreachable statement after break / continue / return",
					);
				if (s.type === "VariableDeclaration") this.declare(s, false);
			});
			let entry = k;
			let tail: JumpNode | undefined;
			for (const s of list) {
				const ph: JumpNode = { k: "jump", to: k, node: s };
				const n = this.stmt(s, ph);
				if (tail) tail.to = n;
				else entry = n;
				tail = ph;
			}
			return entry;
		} finally {
			this.scope = outer;
		}
	}

	private body(s: Statement, k: CNode): CNode {
		return s.type === "BlockStatement"
			? this.block(s.body, k)
			: this.stmt(s, k);
	}

	/** Condition plus the let values it reads (checked when the state's exits expand). */
	private cond(test: Expression): [Sv | boolean, LetSource[]] {
		this.touched = [];
		const sig = evalSig(this.ecx, test);
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
				return this.return(s);
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
		if (s.test.type === "BooleanLiteral" && !s.test.value)
			this.src.fail(s.test, "the loop condition is always false");
		const forever = s.test.type === "BooleanLiteral";
		if (s.type === "DoWhileStatement") {
			// The body may assign a let the condition reads: compile it first.
			const head: JumpNode = { k: "jump", to: k, node: s };
			this.frames.push({ kind: "loop", label, breakTo: k, continueTo: head });
			const entry = this.body(s.body, head);
			this.frames.pop();
			const [c, needs] = forever ? [true, []] : this.cond(s.test);
			if (c === false)
				return this.src.fail(s.test, "the loop condition is always false");
			head.to =
				c === true
					? entry
					: { k: "br", cond: c, yes: entry, no: k, node: s, needs };
			return entry;
		}
		const [c, needs] = forever ? [true, []] : this.cond(s.test);
		if (c === false)
			return this.src.fail(s.test, "the loop condition is always false");
		const head: JumpNode | BrNode =
			c === true
				? { k: "jump", to: k, node: s }
				: { k: "br", cond: c, yes: k, no: k, node: s, needs };
		this.frames.push({ kind: "loop", label, breakTo: k, continueTo: head });
		const entry = this.body(s.body, head);
		this.frames.pop();
		if (head.k === "jump") head.to = entry;
		else head.yes = entry;
		return head;
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
			"a label names an await state, a call, a loop or a block (§3.5)",
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
		const assign =
			e.type === "AssignmentExpression" && e.right.type === "AwaitExpression";
		const awaited = assign ? e.right : e;
		if (awaited.type === "AwaitExpression") {
			const a = awaited.argument;
			const to = assign ? this.letTarget(e) : undefined;
			const callee = a.type === "CallExpression" ? this.callee(a) : undefined;
			if (callee && a.type === "CallExpression")
				return this.inline(callee, a, label, k, to, true);
			if (isMethodCall(a, "push") || isMethodCall(a, "pop"))
				return this.hs(a, stmt, k, label, to);
			if (to)
				src.fail(
					e,
					"only a pop or a sub-FSM call gives a value: r = await x.pop()",
				);
			if (isMethodCall(a, "wait")) return this.wait(a, stmt, k, label);
			if (
				isMethodCall(a) &&
				a.callee.object.type === "Identifier" &&
				a.callee.object.name === "Promise"
			)
				notYet(src, a, "Promise.all (§6.3)");
			return src.fail(e, AWAIT_IS_STATE);
		}
		if (e.type === "CallExpression") {
			const callee = this.callee(e);
			if (callee) {
				if (callee.k === "sub" || callee.m.async)
					src.fail(e, "an async call is a state: write await (§5)");
				if (label)
					src.fail(label, "a sync interface method has no states to name");
				return this.inline(callee, e, undefined, k, undefined, false);
			}
		}
		if (isMethodCall(e)) {
			const verb = e.callee.property.name;
			const b = this.ref(e.callee.object);
			if (verb === "pulse" && b?.k === "output") {
				const arg = e.arguments[0];
				if (
					e.arguments.length > 1 ||
					arg?.type === "SpreadElement" ||
					arg?.type === "ArgumentPlaceholder"
				)
					return src.fail(e, "pulse() or pulse(v)");
				if (b.byInst) src.fail(e, `${b.name} is driven by ${b.byInst.name}`);
				if (!arg && b.width > 1)
					src.fail(
						e,
						`${b.name} is ${b.width} bits: write ${src.textOf(e.callee.object)}.pulse(value)`,
					);
				const value = arg
					? evalSig(this.ecx, arg, { width: b.width })
					: { sv: lit(1, 1n), width: 1, value: 1n };
				const act: Action = {
					k: "pulse",
					port: b,
					value,
					text: src.textOf(e),
					node: e,
					key: this.at(e),
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
					key: this.at(e),
				};
				b.sites.push(act);
				return this.act(act, k);
			}
			if (verb === "push" || verb === "pop")
				notYet(src, e, "a push / pop without await (a Future, §6.3)");
		}
		if (
			e.type === "CallExpression" &&
			e.callee.type === "Identifier" &&
			this.unit.builtins.get(e.callee.name) === "Instance"
		)
			src.fail(
				e,
				"Instance(...) belongs before while (true) of an @Fsm method (§5.3)",
			);
		if (e.type === "AssignmentExpression")
			src.fail(
				e,
				"assignment is not supported; a value that changes needs a Dff (§2.4)",
			);
		return src.fail(
			e,
			"unsupported statement: expected an await, x.pulse(), d.set(v) or an interface method call",
		);
	}

	/** `r = await ...`: r must be a `let` assigned only here. */
	private letTarget(e: Expression): LetBinding {
		const src: Src = this.src;
		if (
			e.type !== "AssignmentExpression" ||
			e.operator !== "=" ||
			e.left.type !== "Identifier"
		)
			return src.fail(e, "write r = await ... with `let r;` (§2.4)");
		const b = this.scope.get(e.left.name);
		if (b?.k !== "let")
			return src.fail(
				e.left,
				`${e.left.name} must be declared with \`let ${e.left.name};\` before (§2.4)`,
			);
		if (b.src)
			src.fail(
				e.left,
				`let ${b.name} is assigned twice; a value that changes needs a Dff (§2.4)`,
			);
		return b;
	}

	private act(act: Action, k: CNode): CNode {
		this.actions.push(act);
		const needs = this.touched;
		this.touched = [];
		return { k: "act", act, next: k, needs };
	}

	private newState(
		label: (Node & { type: "LabeledStatement" }) | undefined,
		stmt: Node,
		cond: Sv | boolean,
		k: CNode,
	): State {
		const src: Src = this.src;
		let name = "";
		if (label) {
			checkSvId(src, label.label, label.label.name, "state");
			this.label(label.label.name, label.label);
			name = this.statePrefix + upperSnake(label.label.name);
		}
		const node = label ?? stmt;
		const state: State = {
			name,
			member: "",
			label: label?.label.name ?? "",
			prefix: this.statePrefix,
			index: -1,
			node,
			key: this.at(node),
			cond,
			next: k,
		};
		this.states.push(state);
		return state;
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
		if (this.touched.length > 0) src.fail(call, LET_LATE);
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
		return { k: "wait", state: this.newState(label, stmt, cond, k) };
	}

	/** `[S:] await x.push(v)` / `[S:] [r =] await x.pop()`: held in S until the handshake (§6.2). */
	private hs(
		a: Expression & { type: "CallExpression" },
		stmt: Node,
		k: CNode,
		label: (Node & { type: "LabeledStatement" }) | undefined,
		to: LetBinding | undefined,
	): CNode {
		const src: Src = this.src;
		if (a.callee.type !== "MemberExpression") return src.fail(a, "x.push(v)");
		const push = isMethodCall(a, "push");
		const b = this.ref(a.callee.object);
		const port = b?.k === "chan" ? (push ? b.tx : b.rx) : b;
		const verb = push ? "push" : "pop";
		if (port?.k !== verb)
			return src.fail(
				a.callee.object,
				`${verb} needs a ${push ? "PushPort" : "PopPort"} or a Chan`,
			);
		if (port.byInst)
			src.fail(
				a,
				`${port.name} is connected to ${port.byInst.name}; this module cannot ${verb} on it`,
			);
		let value: Sig | undefined;
		if (push) {
			const v = a.arguments[0];
			if (
				a.arguments.length !== 1 ||
				!v ||
				v.type === "SpreadElement" ||
				v.type === "ArgumentPlaceholder"
			)
				return src.fail(a, "push(v) takes one value");
			this.touched = [];
			value = evalSig(this.ecx, v, { width: port.width });
			if (this.touched.length > 0) src.fail(v, LET_LATE);
		} else if (a.arguments.length > 0) src.fail(a, "pop() takes no argument");
		const state = this.newState(
			label,
			stmt,
			atom(`${port.name}_${push ? "rdy" : "vld"}`),
			k,
		);
		state.hs = { port, state, value, text: src.textOf(a), key: state.key };
		port.sites.push(state.hs);
		if (to) {
			to.src = {
				sv: atom(`${port.name}_data`),
				width: port.width,
				what: `the pop in state ${label?.label.name ?? "(unnamed)"}`,
				port,
			};
			state.produces = to.src;
		}
		return { k: "wait", state };
	}

	/** `this.m(...)` / `Group.m(...)` (sub-FSM) or `x.m(...)` (interface method), else undefined. */
	private callee(
		a: Expression & { type: "CallExpression" },
	): Callee | undefined {
		const c = a.callee;
		if (
			c.type !== "MemberExpression" ||
			c.computed ||
			c.property.type !== "Identifier"
		)
			return undefined;
		const name = c.property.name;
		const b = this.ref(c.object);
		if (b?.k === "iface") {
			const m = b.cls.methods.get(name);
			if (!m)
				return this.src.fail(c.property, `${b.cls.name} has no method ${name}`);
			return { k: "iface", x: b, m, name };
		}
		if (b) return undefined;
		const m = this.method(c);
		if (!m) return undefined;
		if (!m.sub)
			this.src.fail(
				a,
				`${m.name} is an @Fsm method: instantiate it with Instance(...) and talk over channels (§5.3)`,
			);
		return { k: "sub", m };
	}

	private calleeName(c: Callee): string {
		return c.k === "sub" ? c.m.name : `${c.x.cls.name}.${c.name}`;
	}

	/** The callee's parameter scope; `checks` report unused parameters afterwards. */
	private bindArgs(
		c: Callee,
		call: Expression & { type: "CallExpression" },
	): { scope: Scope; checks: (() => void)[] } {
		const src: Src = this.src;
		const name = this.calleeName(c);
		const scope = new Scope();
		const checks: (() => void)[] = [];
		const calleeSrc = c.k === "sub" ? c.m.group.unit.src : c.x.cls.unit.src;
		const value = (
			pname: string,
			v: Expression,
			pnode: Node,
			width?: number,
		) => {
			const lb = v.type === "Identifier" ? this.scope.get(v.name) : undefined;
			if (lb?.k === "let") {
				if (width !== undefined && lb.src && lb.src.width !== width)
					src.fail(v, `width mismatch: expected ${width}, got ${lb.src.width}`);
				scope.map.set(pname, lb);
				return;
			}
			const use = { used: false };
			const bare =
				width !== undefined
					? undefined
					: v.type === "NumericLiteral"
						? intLit(src, v, "number")
						: lb?.k === "sig"
							? lb.lit
							: undefined;
			if (bare !== undefined) {
				const sig = { sv: lit(1, 0n), width: 1 };
				scope.map.set(pname, { k: "sig", sig, start: 0, use, lit: bare });
			} else {
				this.touched = [];
				const sig = evalSig(this.ecx, v, width === undefined ? {} : { width });
				if (this.touched.length > 0) src.fail(v, LET_LATE);
				scope.map.set(pname, { k: "sig", sig, start: 0, use });
			}
			if (lb?.k === "sig" && lb.use) lb.use.used = true;
			checks.push(() => {
				if (!use.used)
					calleeSrc.fail(pnode, `${pname} of ${name} is never read`);
			});
		};
		if (c.k === "iface") {
			scope.map.set("this", c.x);
			const ps = c.m.params;
			if (call.arguments.length !== ps.length)
				src.fail(call, `${name} takes ${ps.length} argument(s)`);
			for (const [i, v] of call.arguments.entries()) {
				const p = ps[i];
				if (
					p?.type !== "Identifier" ||
					v.type === "SpreadElement" ||
					v.type === "ArgumentPlaceholder"
				)
					return src.fail(v, "unsupported argument");
				value(p.name, v, p);
			}
			return { scope, checks };
		}
		const arg = call.arguments[0];
		if (call.arguments.length !== 1 || arg?.type !== "ObjectExpression")
			return src.fail(
				call,
				`connect ${name}'s ports with one object: this.${name}({ port: value, ... })`,
			);
		const given = this.args(arg, name, [...c.m.params.keys()]);
		for (const [pname, p] of c.m.params) {
			const v = given.get(pname) as Expression;
			if (p.k === "input") {
				value(pname, v, p.node, p.width);
				continue;
			}
			const b = this.ref(v);
			if (p.k === "iface") {
				if (b?.k !== "iface" || b.cls !== p.cls || svArgs(b) !== svArgs(p))
					src.fail(
						v,
						`${pname} is a ${p.cls.name}(${svArgs(p)}): pass an interface of the same class and arguments`,
					);
				scope.map.set(pname, b);
				continue;
			}
			const end = b?.k === "chan" ? (p.k === "push" ? b.tx : b.rx) : b;
			if (end?.k !== p.k || end.width !== p.width)
				return src.fail(
					v,
					`${pname} of ${name} is a ${p.width}-bit ${KIND_TEXT[p.k]}: pass a ${p.width}-bit ${KIND_TEXT[p.k]}${p.k === "push" || p.k === "pop" ? " or Chan" : ""} of this method`,
				);
			if ((end.k === "push" || end.k === "pop") && end.byInst)
				src.fail(v, `${end.name} is connected to ${end.byInst.name}`);
			scope.map.set(pname, end);
			// A Dff parameter may be only read, which a caller read hides: not checked.
			if (end.k === "dff") continue;
			const before = end.sites.length;
			checks.push(() => {
				if (end.sites.length === before)
					calleeSrc.fail(p.node, `${pname} of ${name} is never used`);
			});
		}
		return { scope, checks };
	}

	/** Inline a call: the callee's states join this module, named <LABEL>_<STATE> (§5). */
	private inline(
		c: Callee,
		call: Expression & { type: "CallExpression" },
		label: (Node & { type: "LabeledStatement" }) | undefined,
		k: CNode,
		to: LetBinding | undefined,
		awaited: boolean,
	): CNode {
		const src: Src = this.src;
		const name = this.calleeName(c);
		const node = c.k === "sub" ? c.m.node : c.m;
		if (awaited && !label)
			src.fail(
				call,
				`label the call: its states are named <LABEL>_<STATE> (§5)`,
			);
		if (this.stack.includes(node))
			src.fail(call, `recursive sub-FSM call: ${name}`);
		const { scope, checks } = this.bindArgs(c, call);
		let prefix = "";
		if (label) {
			checkSvId(src, label.label, label.label.name, "call label");
			this.label(label.label.name, label.label);
			prefix = upperSnake(label.label.name);
		}
		const ret: Ret = {
			to: k,
			callee: name,
			values: [],
			result: to
				? { sv: atom(""), width: 0, what: `the ${label?.label.name} call` }
				: undefined,
		};
		const fall: JumpNode = { k: "jump", to: k, node: call };
		const saved = {
			unit: this.unit,
			group: this.group,
			scope: this.scope,
			frames: this.frames,
			labels: this.labels,
			ret: this.ret,
			statePrefix: this.statePrefix,
			svPrefix: this.svPrefix,
			key: this.key,
			sync: this.sync,
		};
		this.key = this.at(call);
		this.unit = c.k === "sub" ? c.m.group.unit : c.x.cls.unit;
		this.group = c.k === "sub" ? c.m.group : undefined;
		this.scope = scope;
		this.frames = [];
		this.labels = new Set();
		this.ret = ret;
		if (prefix) {
			this.statePrefix += `${prefix}_`;
			this.svPrefix += `${prefix.toLowerCase()}_`;
		}
		this.sync = !awaited;
		this.stack.push(node);
		let entry: CNode;
		try {
			entry = this.block(node.body.body, fall);
			for (const f of checks) f();
			const valued = ret.values.find((v) => v.value);
			if (valued) {
				for (const v of ret.values)
					if (!v.value)
						this.src.fail(v.node, `every return of ${name} gives a value`);
				fall.miss = `a path reaches the end of ${name} without return <value>`;
			}
		} finally {
			Object.assign(this, saved);
			this.stack.pop();
		}
		if (to) {
			if (!ret.result || ret.result.width === 0)
				src.fail(call, `${name} returns no value`);
			to.src = ret.result;
		}
		if (c.k === "sub") this.used.add(node);
		return entry;
	}

	private return(s: Statement & { type: "ReturnStatement" }): CNode {
		const src: Src = this.src;
		const r = this.ret;
		if (!r)
			return src.fail(
				s,
				"a top-level @Fsm never returns (§3.4); end a one-shot flow in a trap state: await ALWAYS_0.wait(1)",
			);
		const v = s.argument;
		this.touched = [];
		if (v) {
			const sig = evalSig(
				this.ecx,
				v,
				r.width === undefined ? {} : { width: r.width },
			);
			r.width ??= sig.width;
			const res = r.result;
			if (res && res.width === 0) {
				res.sv = sig.sv;
				res.width = sig.width;
			} else if (res && svText(res.sv) !== svText(sig.sv))
				src.fail(
					v,
					`the returns of ${r.callee} give different values (${svText(res.sv)} elsewhere); an inlined call has one result: latch it in a Dff (§5)`,
				);
		}
		r.values.push({ node: s, value: Boolean(v) });
		const needs = this.touched;
		this.touched = [];
		return {
			k: "jump",
			to: r.to,
			node: s,
			produces: v ? r.result : undefined,
			needs,
		};
	}

	/** `x.m(a)` in an expression: an interface method whose body is `return <expr>` (§2.6). */
	private macro(
		node: Expression & { type: "CallExpression" },
	): Sig | undefined {
		const c = this.callee(node);
		if (!c) return undefined;
		const name = this.calleeName(c);
		if (c.k === "sub" || c.m.async)
			return this.src.fail(
				node,
				`${name} is async: a call is a state, write it as a statement with await (§5)`,
			);
		const [only, extra] = c.m.body.body;
		if (only?.type !== "ReturnStatement" || !only.argument || extra)
			return this.src.fail(
				node,
				`${name} is used as a value: its body must be one return <expr> (§2.6)`,
			);
		const { scope, checks } = this.bindArgs(c, node);
		const saved = { unit: this.unit, group: this.group, scope: this.scope };
		this.unit = c.x.cls.unit;
		this.group = undefined;
		this.scope = scope;
		try {
			const sig = evalSig(this.ecx, only.argument);
			for (const f of checks) f();
			return sig;
		} finally {
			Object.assign(this, saved);
		}
	}
}
