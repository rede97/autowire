// Builtins of the autowire fsm DSL (docs/state/async-fsm.md). The compiler
// reads the .mjs source and never runs it; these no-ops only keep an
// accidental run (Bun turns decorators into real calls) from crashing.

function signal() {
	const c = {
		wait: async () => {},
		bits: () => signal(),
		pulse() {},
		set() {},
		push: async () => {},
		pop: async () => c,
	};
	c.val = c;
	c.tx = c;
	c.rx = c;
	return c;
}

export function FsmGroup(cls) {
	return cls;
}

export function FsmPort(cls) {
	return cls;
}

/** `@Fsm` or `@Fsm({ ... })`. */
export function Fsm(target) {
	return typeof target === "function" ? target : (m) => m;
}

export const Input = signal;
export const Output = signal;
export const Const = signal;
export const Dff = signal;
export const PushPort = signal;
export const PopPort = signal;
export const Chan = signal;
export const ALWAYS_0 = signal();
export const ALWAYS_1 = signal();

export function Instance() {}

export function SvPackage() {
	return new Proxy({}, { get: () => signal });
}

export function SvFunction() {
	return {};
}

export function Escape() {}

export function Raise() {
	return new Error("Raise");
}
