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

/** Sending end of a channel: vld / rdy / data (§6.2). */
export interface PushEnd {
	/** State: hold vld and `v` until rdy. */
	push(v: Signal | number): Promise<void>;
}

/** Receiving end of a channel (§6.2). */
export interface PopEnd {
	/** State: hold rdy until vld; the data is valid in the segment that follows. */
	pop(): Promise<Signal>;
}

/** A channel inside an @Fsm: one end for this module, the other for an Instance (§5.3). */
export interface ChanPair extends PushEnd, PopEnd {
	readonly tx: PushEnd;
	readonly rx: PopEnd;
}

export interface FsmOptions {
	statePrefix?: string;
	stateEncoding?: "binary" | "onehot";
	exportState?: boolean;
	stateValues?: Record<string, number>;
	stateReg?: "always_ff" | "dff";
}

export declare function FsmGroup<T>(cls: T, ctx?: unknown): T;
export declare function FsmPort<T>(cls: T, ctx?: unknown): T;
export declare function Fsm<T>(method: T, ctx?: unknown): T;
export declare function Fsm(
	options: FsmOptions,
): <T>(method: T, ctx?: unknown) => T;
export declare function Input(width: number): Signal;
export declare function Output(width: number): OutputPort;
export declare function Const(width: number, value: number): Signal;
export declare function Dff(
	width: number,
	options?: { reset?: number; external?: boolean },
): DffReg;
export declare function PushPort(width: number): PushEnd;
export declare function PopPort(width: number): PopEnd;
export declare function Chan(width: number): ChanPair;
/** An independent process: `Instance(this.fsm, { port: signal | channel end, ... })` (§5.3). */
export declare function Instance(
	target: unknown,
	ports: Record<string, unknown>,
): void;
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
