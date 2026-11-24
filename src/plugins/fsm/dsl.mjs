// Builtins of the autowire fsm DSL (docs/state/async-fsm.md). The compiler
// reads the .mjs source and never runs it; these no-ops only keep an
// accidental run (Bun turns decorators into real calls) from crashing.

function channel() {
	const c = {
		wait: async () => {},
		bits: () => channel(),
		pulse() {},
		set() {},
		push: async () => {},
		pop: async () => c,
	};
	c.val = c;
	return c;
}

export function FsmGroup(cls) {
	return cls;
}

/** `@Fsm` or `@Fsm({ ... })`. */
export function Fsm(target) {
	return typeof target === "function" ? target : (m) => m;
}

export const Input = channel;
export const Output = channel;
export const Const = channel;
export const Dff = channel;
export const PushPort = channel;
export const PopPort = channel;
export const ALWAYS_0 = channel();
export const ALWAYS_1 = channel();

export function SvPackage() {
	return new Proxy({}, { get: () => channel });
}

export function SvFunction() {
	return {};
}

export function Escape() {}

export function Raise() {
	return new Error("Raise");
}
