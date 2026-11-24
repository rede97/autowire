// Data model shared by the fsm compiler passes (front end → CFG → emit).

import type { Node } from "@babel/types";

/** SV expression tree. Printing adds parentheses (see svText). */
export type Sv =
	| { k: "atom"; text: string }
	| { k: "un"; op: "!" | "~"; arg: Sv }
	| { k: "bin"; op: string; l: Sv; r: Sv }
	| { k: "tern"; c: Sv; a: Sv; b: Sv }
	/** User SV function call `pkg::fn(args)` (§2.3). */
	| { k: "call"; fn: string; args: Sv[] };

/** A typed channel value. `value` is set when the channel is a compile-time constant. */
export interface Sig {
	sv: Sv;
	width: number;
	value?: bigint;
	/** Named channel (port, wire, Dff val): bits() may select from it. */
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
	/** Driven by a sub-FSM instance port instead of this module's actions (§5). */
	byCall?: Call;
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

/** `const c = <combinational expression>`: logic c; assign c = ...; */
export interface Wire {
	name: string;
	width: number;
	sv: Sv;
	node: Node;
	used: boolean;
}

export interface ChanBinding {
	k: "chan";
	sig: Sig;
	/** Declaration start offset: earlier references are a TDZ error. */
	start: number;
	wire?: Wire;
}

/** `let r;` assigned once by `r = await this.sub({...})` (§2.4). */
export interface LetBinding {
	k: "let";
	name: string;
	node: Node;
	call?: Call;
}

export type Binding =
	| InputPort
	| OutputPort
	| DffReg
	| ChanBinding
	| LetBinding;

/** One call site `await this.m({...})`: one callee instance (§5.1). */
export interface Call {
	callee: string;
	/** Signal prefix: <callee> or <callee>_<n>; instance u_<inst>. */
	inst: string;
	node: Node;
	/** The caller's call state; set when the call statement compiles. */
	state?: State;
	/** Callee port → connected caller expression, in callee port order. */
	conn: { port: string; sv: Sv }[];
	/** Callee result width; 0 when the callee returns no value. */
	resultWidth: number;
}

/** What a caller needs from a compiled sub-FSM. */
export interface SubShape {
	ports: Port[];
	resultWidth: number;
}

export type Port = InputPort | OutputPort | DffReg;

export type Action =
	| {
			k: "pulse";
			port: OutputPort;
			value: Sig;
			text: string;
			node: Node;
			/** done / result of a sub-FSM return: made by the generator, not the author. */
			implicit?: "return" | "end";
	  }
	| { k: "set"; dff: DffReg; value: Sig; text: string; node: Node };

export interface State {
	/** UPPER_SNAKE name from the label (or S<index>); used in move_to_* / leave_*. */
	name: string;
	/** enum member: name with the @Fsm statePrefix. */
	member: string;
	/** Author label as written; "" for an anonymous state. */
	label: string;
	/** Source order index (enum order). */
	index: number;
	node: Node;
	/** Leave condition; true = leaves on the next cycle, false = trap. */
	cond: Sv | boolean;
	/** Code after the await: walked on every leave. */
	next: CNode;
	/** Set on a call state: leaves on <inst>_done. */
	call?: Call;
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
	/** let results this action reads: valid only when leaving their call state. */
	needs: Call[];
}
export interface BrNode {
	k: "br";
	cond: Sv;
	yes: CNode;
	no: CNode;
	node: Node;
	needs: Call[];
}
export interface JumpNode {
	k: "jump";
	to: CNode;
	node: Node;
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
	states: State[];
	entry: State;
	/** Sub-FSM: implicit IDLE entry with start / done (/ result) ports (§5). */
	sub: boolean;
	resultWidth: number;
	calls: Call[];
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
