// Editor completion for the autowire fsm DSL (docs/state/async-fsm.md).
// Source files are .mjs and never type-checked: the compiler gives operators
// on channels their meaning (§2.1), which TypeScript cannot express.

export interface Channel {
	/** State: wait until this channel equals `v` (§3.1). */
	wait(v: number): Promise<void>;
	/** Bit select: bits(i) or bits(hi, lo) (§2.1). */
	bits(hi: number, lo?: number): Channel;
}

export interface OutputPort {
	/** Output `v` (1 when omitted, 1-bit only) on the move that runs this segment; 0 otherwise (§6.1). */
	pulse(v?: Channel | number): void;
}

export interface DffReg {
	/** Write `v` on the move that runs this segment (§6.5). */
	set(v: Channel | number): void;
	readonly val: Channel;
}

export interface FsmOptions {
	exportState?: boolean;
	stateValues?: Record<string, number>;
	stateReg?: "always_ff" | "dff";
}

export declare function FsmGroup<T>(cls: T, ctx?: unknown): T;
export declare function Fsm<T>(method: T, ctx?: unknown): T;
export declare function Fsm(
	options: FsmOptions,
): <T>(method: T, ctx?: unknown) => T;
export declare function Input(width: number): Channel;
export declare function Output(width: number): OutputPort;
export declare function Const(width: number, value: number): Channel;
export declare function Dff(
	width: number,
	options?: { reset?: number; external?: boolean },
): DffReg;
export declare function PushPort(width: number): unknown;
export declare function PopPort(width: number): unknown;
export declare const ALWAYS_0: Channel;
export declare const ALWAYS_1: Channel;
export declare function SvPackage(
	name: string,
	fns: Record<string, unknown>,
): Record<string, (...args: Channel[]) => Channel>;
export declare function SvFunction(sig: {
	args: number[];
	ret: number;
}): unknown;
export declare function Escape(cond: Channel): void;
export declare function Raise(): Error;
