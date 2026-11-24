// Data model shared by the fsm compiler passes (front end → CFG → emit).

import type { ClassDeclaration, ClassMethod, Node } from "@babel/types";
import type { Src } from "./source.ts";

/** SV expression tree. Printing adds parentheses (see svText). */
export type Sv =
	| { k: "atom"; text: string }
	| { k: "un"; op: "!" | "~"; arg: Sv }
	| { k: "bin"; op: string; l: Sv; r: Sv }
	| { k: "tern"; c: Sv; a: Sv; b: Sv }
	/** User SV function call `pkg::fn(args)` (§2.3). */
	| { k: "call"; fn: string; args: Sv[] };

/** Source position path: code inlined from a sub-FSM sorts at its call site. */
export type Key = number[];

/** A typed signal value. `value` is set when the signal is a compile-time constant. */
export interface Sig {
	sv: Sv;
	width: number;
	value?: bigint;
	/** Named signal (port, wire, Dff val): bits() may select from it. */
	named?: boolean;
}

export interface InputPort {
	k: "input";
	name: string;
	width: number;
	node: Node;
	used: boolean;
	/** `// title` comment lines above the port: group header in the SV port list. */
	group?: string[];
}

export interface OutputPort {
	k: "output";
	name: string;
	width: number;
	node: Node;
	sites: Action[];
	group?: string[];
	/** Driven by an instance port instead of this module's actions (§5.3). */
	byInst?: Inst;
}

export interface DffReg {
	k: "dff";
	name: string;
	width: number;
	reset: bigint;
	/** port: internal aw_dff, `val` is the output port; external: _set/_next/_val
	 *  ports; body: private aw_dff with a <name>_val wire. */
	place: "port" | "external" | "body";
	node: Node;
	sites: Action[];
	read: boolean;
	group?: string[];
}

/** One end of a handshake channel: <name>_vld / _rdy / _data (§6.2).
 *  push sends (vld and data out), pop receives (rdy out). */
export interface HsPort {
	k: "push" | "pop";
	name: string;
	width: number;
	/** port: a module port (PushPort / PopPort); chan: one end of a Chan. */
	place: "port" | "chan";
	node: Node;
	/** This module's push / pop states on it, source order. */
	sites: HsSite[];
	/** Owned by an instance instead of this module's states (§5.3). */
	byInst?: Inst;
	/** pop: some popped value is read. */
	read: boolean;
	group?: string[];
}

/** `[S:] await x.push(v)` / `[S:] [r =] await x.pop()`: a state held until the handshake. */
export interface HsSite {
	port: HsPort;
	state: State;
	/** push data while waiting in the state. */
	value?: Sig;
	text: string;
	key: Key;
}

/** `const c = Chan(N)` in an @Fsm method: wires between this module and its instances. */
export interface Chan {
	k: "chan";
	name: string;
	width: number;
	node: Node;
	/** Push end (into the channel) and pop end (out of it). */
	tx: HsPort;
	rx: HsPort;
}

/** `x = new C(args)` with C an @FsmPort class: its fields, flattened to <x>_<field>. */
export interface Iface {
	k: "iface";
	name: string;
	cls: IfaceClass;
	args: bigint[];
	fields: Map<string, Port>;
	node: Node;
}

/** `const c = <combinational expression>`: logic c; assign c = ...; */
export interface Wire {
	name: string;
	width: number;
	sv: Sv;
	node: Node;
	key: Key;
	used: boolean;
}

/** A name bound to a signal: a const, a sub-FSM Input argument, an interface method argument. */
export interface SigBinding {
	k: "sig";
	sig: Sig;
	/** Declaration start offset: earlier references are a TDZ error. */
	start: number;
	wire?: Wire;
	/** Argument of an inlined call: marks the callee parameter as read. */
	use?: { used: boolean };
	/** A bare number passed to an interface method: sized where it is used. */
	lit?: bigint;
}

/** Value assigned to a `let`: valid only in the segment its producer ends (§2.4). */
export interface LetSource {
	sv: Sv;
	width: number;
	/** For errors: "the pop in state RSP", "the Scan call". */
	what: string;
	/** pop data: reading it marks the port's data as used. */
	port?: HsPort;
}

/** `let r;` assigned once by `r = await x.pop()` or `r = await this.sub({...})` (§2.4). */
export interface LetBinding {
	k: "let";
	name: string;
	node: Node;
	src?: LetSource;
	read: boolean;
}

export type Binding =
	| InputPort
	| OutputPort
	| DffReg
	| HsPort
	| Chan
	| Iface
	| SigBinding
	| LetBinding;

/** A module port as declared; interfaces are flattened into their fields. */
export type Port = InputPort | OutputPort | DffReg | HsPort;

/** `Instance(target, { port: ... })`: one module instance inside an @Fsm (§5.3). */
export interface Inst {
	/** u_<module> or u_<module>_<n>. */
	name: string;
	module: string;
	node: Node;
	/** SV port of the instance → connected expression, in the target's port order. */
	conn: [string, string][];
}

export type Action =
	| {
			k: "pulse";
			port: OutputPort;
			value: Sig;
			text: string;
			node: Node;
			key: Key;
	  }
	| {
			k: "set";
			dff: DffReg;
			value: Sig;
			text: string;
			node: Node;
			key: Key;
	  };

export interface State {
	/** UPPER_SNAKE name from the label (or <prefix>S<index>); used in move_to_* / leave_*. */
	name: string;
	/** enum member: name with the @Fsm statePrefix. */
	member: string;
	/** Author label as written; "" for an anonymous state. */
	label: string;
	/** Inlined call prefixes (SCAN_), for an anonymous state's name. */
	prefix: string;
	/** Source order index (enum order). */
	index: number;
	node: Node;
	key: Key;
	/** Leave condition; true = leaves on the next cycle, false = trap. */
	cond: Sv | boolean;
	/** Code after the await: walked on every leave. */
	next: CNode;
	/** push / pop state: the handshake held while waiting. */
	hs?: HsSite;
	/** pop state with `r =`: the value its leaving segment may read. */
	produces?: LetSource;
}

/** Control-flow graph built from the method body. */
export type CNode = WaitNode | ActNode | BrNode | JumpNode | EndNode;
export interface WaitNode {
	k: "wait";
	state: State;
}
export interface ActNode {
	k: "act";
	act: Action;
	next: CNode;
	/** let values this action reads: valid only in their producer's segment. */
	needs: LetSource[];
}
export interface BrNode {
	k: "br";
	cond: Sv;
	yes: CNode;
	no: CNode;
	node: Node;
	needs: LetSource[];
}
export interface JumpNode {
	k: "jump";
	to: CNode;
	node: Node;
	/** Return of an inlined call: from here on its let value is valid. */
	produces?: LetSource;
	/** A path through here is an error (falling off a sub-FSM that returns a value). */
	miss?: string;
	/** let values a return expression reads. */
	needs?: LetSource[];
}
export interface EndNode {
	k: "end";
}

/** One way out of a state: the leave condition plus one branch path. */
export interface Edge {
	from: State;
	to: State;
	acts: Action[];
}

export type Tree =
	| { k: "leaf"; edge: Edge }
	| { k: "if"; cond: Sv; yes: Tree; no: Tree };

/** A move-like control signal: high on exactly the cycles one of `edges` is taken. */
export interface Signal {
	name: string;
	kind: "move" | "leave" | "edge";
	edges: Set<Edge>;
}

/** @Fsm({ statePrefix, stateEncoding }) (§6.5). */
export interface FsmOptions {
	/** Prepended to every enum member: <prefix>_<STATE>. */
	statePrefix?: string;
	/** Omitted: no enum values, the synthesizer picks the encoding. */
	stateEncoding?: "binary" | "onehot";
}

export interface Fsm {
	name: string;
	comment: string[];
	options: FsmOptions;
	ports: Port[];
	/** Body-declared Dffs, declaration order. */
	privateDffs: DffReg[];
	wires: Wire[];
	chans: Chan[];
	insts: Inst[];
	states: State[];
	entry: State;
	/** Per state: its exit tree, or null for a trap state. */
	exits: Map<State, Tree | null>;
	/** Signals driving each action site. */
	drive: Map<Action, Signal[]>;
	/** Signals asserted on each edge (move and edge kinds). */
	onEdge: Map<Edge, Signal[]>;
	/** leave_S signal of a state, when some action uses it. */
	leave: Map<State, Signal>;
}

/** One function of a user SV package (§2.3). */
export interface SvFn {
	/** Argument widths in declaration order. */
	args: number[];
	ret: number;
}

/** `const x = SvPackage("name", { ... })`: never generated, only called. */
export interface SvPkg {
	name: string;
	fns: Map<string, SvFn>;
}

/** A field of an @FsmPort class: `this.f = Kind(args)` in its constructor. */
export interface IfaceField {
	name: string;
	kind: string;
	args: Node[];
	node: Node;
}

/** `@FsmPort class C { constructor(n) { this.f = Input(n); ... } m() { ... } }` (§2.6). */
export interface IfaceClass {
	name: string;
	unit: Unit;
	node: ClassDeclaration;
	params: string[];
	fields: IfaceField[];
	methods: Map<string, ClassMethod>;
}

/** An @Fsm method (a module) or an undecorated one (a sub-FSM, inlined at each call). */
export interface FsmMethod {
	node: ClassMethod;
	name: string;
	comment: string[];
	/** Parameter name → its port, or the interface it declares. */
	params: Map<string, Port | Iface>;
	/** Flat module ports in declaration order. */
	ports: Port[];
	options: FsmOptions;
	sub: boolean;
	group: Group;
}

export interface Group {
	name: string;
	comment: string[];
	exported: boolean;
	methods: FsmMethod[];
	unit: Unit;
}

/** One parsed .mjs file: what its names stand for. */
export interface Unit {
	src: Src;
	abs: string;
	/** Local import name → builtin name. */
	builtins: Map<string, string>;
	/** SV packages by local name (declared here or imported) (§2.3). */
	packages: Map<string, SvPkg>;
	/** @FsmPort classes by local name. */
	ifaces: Map<string, IfaceClass>;
	/** @FsmGroup classes by local name, imported ones included. */
	groups: Map<string, Group>;
	/** The file's own @FsmGroup class. */
	group?: Group;
	/** Exported names: groups, interfaces, packages. */
	exports: Map<string, Group | IfaceClass | SvPkg>;
}
