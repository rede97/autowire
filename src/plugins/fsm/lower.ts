// Expand each state's exit paths into a decision tree (§3.2, §3.6) and pick
// the control signal that drives every action (enter_T / leave_S / A_to_B / keep_S).

import type { Node } from "@babel/types";
import { type Body, unread } from "./cfg.ts";
import type {
	Action,
	CNode,
	Edge,
	Exit,
	Fsm,
	FsmMethod,
	LetSource,
	Port,
	Signal,
	State,
	Tree,
} from "./model.ts";
import type { Src } from "./source.ts";

const target = (a: Action) => (a.k === "pulse" ? a.port : a.dff);

/** `live`: let values produced earlier in this segment (a pop state, an inlined return). */
function expand(
	src: Src,
	method: Node,
	n: CNode,
	from: State,
	acts: Action[],
	path: Set<CNode>,
	last: Node | undefined,
	edges: Edge[],
	live: ReadonlySet<LetSource>,
): Tree {
	if (n.k === "wait") {
		const edge: Edge = { from, to: n.state, acts };
		edges.push(edge);
		return { k: "leaf", edge };
	}
	if (n.k === "end")
		return src.fail(
			last ?? method,
			"this path reaches the end of the method; a top-level @Fsm runs forever (§3.4): end a one-shot flow in a trap state, await ALWAYS_0.wait(1)",
		);
	const at = n.k === "act" ? n.act.node : n.node;
	if (path.has(n))
		src.fail(
			at,
			"this loop can repeat without passing an await: a combinational loop (§3.6)",
		);
	path.add(n);
	const needs = n.k === "jump" ? (n.needs ?? []) : n.needs;
	for (const s of needs)
		if (!live.has(s))
			src.fail(
				at,
				`this reads the value of ${s.what} outside the segment that follows it; latch it with Dff.set(r) (§2.4)`,
			);
	if (n.k === "jump" && n.miss) src.fail(n.node, n.miss);
	let t: Tree;
	if (n.k === "act") {
		const dup = acts.find((a) => target(a) === target(n.act));
		if (dup)
			src.fail(
				n.act.node,
				`${target(n.act).name} is written twice in one segment (§6.1)`,
			);
		t = expand(
			src,
			method,
			n.next,
			from,
			[...acts, n.act],
			path,
			last,
			edges,
			live,
		);
	} else if (n.k === "br") {
		t = {
			k: "if",
			cond: n.cond,
			yes: expand(src, method, n.yes, from, acts, path, last, edges, live),
			no: expand(src, method, n.no, from, acts, path, last, edges, live),
		};
	} else {
		const next = n.produces ? new Set([...live, n.produces]) : live;
		t = expand(src, method, n.to, from, acts, path, n.node, edges, next);
	}
	path.delete(n);
	return t;
}

const subset = (a: Set<Edge>, b: Set<Edge>) => [...a].every((e) => b.has(e));

export function lower(src: Src, m: FsmMethod, body: Body): Fsm {
	const { states, actions } = body;
	// Entry: the first await of the while (true) body, reached without actions or branches.
	let n: CNode = body.head;
	const seen = new Set<CNode>();
	while (n.k === "jump") {
		if (seen.has(n))
			src.fail(body.head.node, "the while (true) body has no await");
		seen.add(n);
		n = n.to;
	}
	if (n.k === "act")
		src.fail(
			n.act.node,
			"no action before the first await of while (true): reset enters without a move cycle (§3.4)",
		);
	if (n.k === "br")
		src.fail(
			n.node,
			"no branch or loop before the first await of while (true) (§3.4, §3.6)",
		);
	if (n.k !== "wait")
		return src.fail(body.head.node, "the while (true) body has no await");
	const entry = n.state;

	const exits = new Map<State, Exit>();
	const edges: Edge[] = [];
	const queue = [entry];
	const reached = new Set([entry]);
	while (queue.length > 0) {
		const s = queue.shift() as State;
		const before = edges.length;
		// An escape leaves without the handshake: no let value of S is live (§3.7).
		const escapes = s.escapes.map((e) => ({
			cond: e.cond,
			tree: expand(
				src,
				m.node,
				e.to,
				s,
				[],
				new Set(),
				e.node,
				edges,
				new Set(),
			),
		}));
		const tree =
			s.cond === false
				? null
				: expand(
						src,
						m.node,
						s.next,
						s,
						[],
						new Set(),
						undefined,
						edges,
						new Set(s.produces ? [s.produces] : []),
					);
		exits.set(s, { escapes, tree });
		for (const e of edges.slice(before))
			if (!reached.has(e.to)) {
				reached.add(e.to);
				queue.push(e.to);
			}
	}
	for (const s of states)
		if (!reached.has(s))
			src.fail(s.node, `state ${s.label || s.name} is unreachable`);

	const into = new Map<State, Set<Edge>>(states.map((s) => [s, new Set()]));
	const out = new Map<State, Set<Edge>>(states.map((s) => [s, new Set()]));
	for (const e of edges) {
		into.get(e.to)?.add(e);
		out.get(e.from)?.add(e);
	}
	const signals = new Map<string, Signal>();
	const sig = (name: string, kind: Signal["kind"], set: Set<Edge>) => {
		let s = signals.get(name);
		if (!s) {
			s = { name, kind, edges: set };
			signals.set(name, s);
		}
		return s;
	};
	const drive = new Map<Action, Signal[]>();
	for (const a of actions) {
		const on = new Set(edges.filter((e) => e.acts.includes(a)));
		if (on.size === 0) src.fail(a.node, "this action never runs");
		const exact = (m: Map<State, Set<Edge>>) =>
			states.find((s) => {
				const set = m.get(s) as Set<Edge>;
				return set.size === on.size && subset(set, on);
			});
		const t = exact(into);
		const l = t ? undefined : exact(out);
		if (t) {
			drive.set(a, [sig(`enter_${t.name}`, "enter", into.get(t) as Set<Edge>)]);
			continue;
		}
		if (l) {
			drive.set(a, [sig(`leave_${l.name}`, "leave", out.get(l) as Set<Edge>)]);
			continue;
		}
		// Greedy cover: whole enter_T, then whole leave_S, then per-edge signals
		// (A_to_B; keep_S for the self-loop S -> S; _<k> when parallel edges differ).
		const rest = new Set(on);
		const chosen: Signal[] = [];
		const take = (s: Signal) => {
			chosen.push(s);
			for (const e of s.edges) rest.delete(e);
		};
		for (const s of states) {
			const set = into.get(s) as Set<Edge>;
			if (set.size > 0 && subset(set, rest))
				take(sig(`enter_${s.name}`, "enter", set));
		}
		for (const s of states) {
			const set = out.get(s) as Set<Edge>;
			if (set.size > 0 && subset(set, rest))
				take(sig(`leave_${s.name}`, "leave", set));
		}
		for (const e of [...rest]) {
			if (!rest.has(e)) continue;
			const pair = edges.filter((x) => x.from === e.from && x.to === e.to);
			const base =
				e.from === e.to
					? `keep_${e.from.name}`
					: `${e.from.name}_to_${e.to.name}`;
			if (pair.every((x) => rest.has(x)))
				take(sig(base, "edge", new Set(pair)));
			else take(sig(`${base}_${pair.indexOf(e)}`, "edge", new Set([e])));
		}
		drive.set(a, chosen);
	}
	// exportState: state_set_o = |action, so every move has a member (enter_<T>) (§6.5).
	if (m.options.exportState)
		for (const s of states) {
			const set = into.get(s) as Set<Edge>;
			if (set.size > 0) sig(`enter_${s.name}`, "enter", set);
		}
	checkValues(src, m, states);
	const onEdge = new Map<Edge, Signal[]>(edges.map((e) => [e, []]));
	const leave = new Map<State, Signal>();
	for (const s of signals.values()) {
		if (s.kind === "leave") for (const e of s.edges) leave.set(e.from, s);
		else for (const e of s.edges) onEdge.get(e)?.push(s);
	}
	checkUse(src, m.ports, body);
	return {
		name: m.name,
		comment: m.comment,
		options: m.options,
		ports: m.ports,
		privateDffs: body.privateDffs,
		wires: body.wires,
		chans: body.chans,
		insts: body.insts,
		states,
		entry,
		exits,
		drive,
		onEdge,
		leave,
	};
}

/** stateValues lists every enum member once, each value fits the enum width (§6.5). */
function checkValues(src: Src, m: FsmMethod, states: State[]) {
	const sv = m.options.stateValues;
	if (!sv) return;
	const bits = Math.max(1, Math.ceil(Math.log2(states.length)));
	const members = new Set(states.map((s) => s.member));
	for (const [name, v] of sv.values) {
		if (!members.has(name))
			src.fail(
				sv.node,
				`stateValues: ${name} is not a state of ${m.name} (members: ${[...members].join(", ")})`,
			);
		if (v >= 1n << BigInt(bits))
			src.fail(
				sv.node,
				`stateValues: ${name} = ${v} does not fit ${bits} bits`,
			);
	}
	const missing = [...members].filter((n) => !sv.values.has(n));
	if (missing.length > 0)
		src.fail(sv.node, `stateValues misses ${missing.join(", ")}`);
	const seen = new Map<bigint, string>();
	for (const [name, v] of sv.values) {
		const other = seen.get(v);
		if (other)
			src.fail(sv.node, `stateValues: ${other} and ${name} are both ${v}`);
		seen.set(v, name);
	}
}

/** Unused ports and names would be -Wall warnings in the SV; reject them at the source. */
function checkUse(src: Src, ports: Port[], body: Body) {
	for (const w of body.wires)
		if (!w.used) src.fail(w.node, `const ${w.name} is never used`);
	for (const p of [...ports, ...body.privateDffs]) {
		if (p.k === "input" && !p.used)
			src.fail(p.node, `input ${p.name} is never read`);
		if (p.k === "output" && p.sites.length === 0 && !p.byInst)
			src.fail(p.node, `output ${p.name} is never pulsed`);
		if (p.k === "output" && p.sites.length > 0 && p.byInst)
			src.fail(
				p.node,
				`output ${p.name} is driven by both pulse() and ${p.byInst.name}`,
			);
		if (p.k === "dff" && p.sites.length === 0)
			src.fail(p.node, `Dff ${p.name} is never set`);
		if (p.k === "dff" && p.place === "body" && !p.read)
			src.fail(p.node, `Dff ${p.name} is never read (.val)`);
		if ((p.k === "push" || p.k === "pop") && p.sites.length === 0 && !p.byInst)
			src.fail(
				p.node,
				`${p.name} is never ${p.k === "push" ? "pushed" : "popped"}`,
			);
		if (p.k === "pop" && p.sites.length > 0 && unread(p).length > 0)
			src.fail(
				p.node,
				`the data popped from ${p.name} is never read (${unread(p).join(", ")})`,
			);
	}
}
