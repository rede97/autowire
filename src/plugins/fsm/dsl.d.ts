// Editor completion for the autowire fsm DSL (docs/state/async-fsm.md).
// Source files are .mjs and never type-checked: the compiler gives operators
// on signals their meaning (§2.1), which TypeScript cannot express.

export interface Signal {
	/** State: wait until this signal equals `v` (§3.1). */
	wait(v: number): Promise<void>;
	/** Bit select: bits(i) or bits(hi, lo) (§2.1). */
	bits(hi: number, lo?: number): Signal;
}

export interface OutputPort {
	/** Output `v` (1 when omitted, 1-bit only) on the move that runs this segment; 0 otherwise (§6.1). */
	pulse(v?: Signal | number): void;
}

export interface DffReg {
	/** Write `v` on the move that runs this segment (§6.5). */
	set(v: Signal | number): void;
	readonly val: Signal;
}

/** A channel message: one N-bit value, or `{ field: value }` for a record channel. */
export type Message = Signal | number | Record<string, Signal | number>;

/** Sending end of a channel: vld / rdy / data or named fields (§6.2). */
export interface PushEnd {
	/** State: hold vld and `v` until rdy; `push()` on a `{}` token channel. */
	push(v?: Message): Promise<void>;
}

/** Receiving end of a channel (§6.2). */
export interface PopEnd {
	/** State: hold rdy until vld; the data (or `r.<field>`) is valid in the segment that follows. */
	pop(): Promise<Signal & Record<string, Signal>>;
}

/** A channel inside an @Fsm: one end for this module, the other for an Instance (§5.3). */
export interface ChanPair extends PushEnd, PopEnd {
	readonly tx: PushEnd;
	readonly rx: PopEnd;
}

/** `Caller(this.sub, { bound })`: a shared server running a sub-FSM (§5.4). */
export interface CallerPort {
	/** Two states, L_REQ then L_RSP: send the unbound Inputs, wait for the result. */
	call(args?: Record<string, Signal | number>): Promise<Signal>;
}

/** An @SvEnum class used as a port, field or register type (§2.8). */
export type EnumClass = abstract new (...args: never[]) => unknown;

/** Width `N` or an @SvEnum class. */
export type Width = number | EnumClass;

/** `N` (or an @SvEnum class) for one data field, or `{ name: width, ... }` (`{}` is a bare token). */
export type Shape = Width | Record<string, Width>;

export interface FsmOptions {
	statePrefix?: string;
	stateEncoding?: "binary" | "onehot";
	exportState?: boolean;
	/** Output port action_o: the action struct, every enter_<S> included. */
	exportAction?: boolean;
	/** Also emit a wrapper module (true: <name>_wrap) whose enum ports (the state type too) are logic. */
	wrap?: boolean | string;
	/** State enum type name; default <module>_state_e. */
	stateType?: string;
	/** @SvEnum package (this file or an imported one) for the state enum and action struct; default <module>_pkg. */
	pkg?: string;
	stateValues?: Record<string, number>;
}

export interface FsmGroupOptions {
	/** Output file stem in plugins_dir/fsm/; default the class name. */
	file?: string;
}

export declare function FsmGroup<T>(cls: T, ctx?: unknown): T;
export declare function FsmGroup(
	options: FsmGroupOptions,
): <T>(cls: T, ctx?: unknown) => T;
export declare function FsmPort<T>(cls: T, ctx?: unknown): T;
export declare function Fsm<T>(method: T, ctx?: unknown): T;
export declare function Fsm(
	options: FsmOptions,
): <T>(method: T, ctx?: unknown) => T;
export declare function Input(width: Width): Signal;
export declare function Output(width: Width): OutputPort;
export declare function Const(width: number, value: number): Signal;
export declare function Dff(
	width: Width,
	options?: { reset?: number | Signal; external?: boolean },
): DffReg;
export declare function PushPort(shape: Shape): PushEnd;
export declare function PopPort(shape: Shape): PopEnd;
export declare function Chan(shape: Shape): ChanPair;
/** An independent process: `Instance(this.fsm, { port: signal | channel end, ... })` (§5.3). */
export declare function Instance(
	target: unknown,
	ports: Record<string, unknown>,
): void;
/** A sub-FSM as a shared server: bound ports are wired once, the rest are call arguments (§5.4). */
export declare function Caller(
	target: unknown,
	bound?: Record<string, unknown>,
): CallerPort;
export declare const ALWAYS_0: Signal;
export declare const ALWAYS_1: Signal;
export declare function SvPackage(
	name: string,
	fns: Record<string, unknown>,
): Record<string, (...args: Signal[]) => Signal>;
export declare function SvFunction(sig: {
	args: Record<string, number>;
	ret: number;
}): unknown;
export declare function Escape(cond: Signal): void;
export declare function Raise(): Error;
/** `@SvEnum({ pkg: "my_pkg" }) class Op { static IDLE = 0; static GO = 1; }`: the
 *  members become `my_pkg::OP_IDLE` ... of `typedef enum ... op_e` (§2.8). */
export declare function SvEnum(options: {
	pkg: string;
	name?: string;
	width?: number;
	prefix?: string;
}): <T>(cls: T, ctx?: unknown) => T;
