// Expand each state's exit paths into a decision tree (§3.2, §3.6) and pick
// the control signal that drives every action (move_to_T / leave_S / per edge).

import type { Node } from "@babel/types";
import type { Body } from "./cfg.ts";
import type { FsmMethod } from "./front.ts";
import type {
	Action,
	CNode,
	Edge,
	Fsm,
	Port,
	Signal,
	State,
	Tree,
	Wire,
} from "./model.ts";
import type { Src } from "./source.ts";

const target = (a: Action) => (a.k === "pulse" ? a.port : a.dff);

function expand(
	src: Src,
	method: Node,
	n: CNode,
	from: State,
	acts: Action[],
	path: Set<CNode>,
	last: Node | undefined,
	edges: Edge[],
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
	if (n.k !== "jump")
		for (const c of n.needs)
			if (c.state !== from)
				src.fail(
					at,
					`${c.inst}_result is valid only when leaving state ${c.state?.label || c.state?.name}; latch it with Dff.set(r) (§2.4)`,
				);
	let t: Tree;
	if (n.k === "act") {
		const dup = acts.find((a) => target(a) === target(n.act));
		if (dup)
			src.fail(
				n.act.node,
				`${target(n.act).name} is written twice in one segment (§6.1)`,
			);
		t = expand(src, method, n.next, from, [...acts, n.act], path, last, edges);
	} else if (n.k === "br") {
		t = {
			k: "if",
			cond: n.cond,
			yes: expand(src, method, n.yes, from, acts, path, last, edges),
			no: expand(src, method, n.no, from, acts, path, last, edges),
		};
	} else {
		t = expand(src, method, n.to, from, acts, path, n.node, edges);
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

	const exits = new Map<State, Tree | null>();
	const edges: Edge[] = [];
	const queue = [entry];
	const reached = new Set([entry]);
	while (queue.length > 0) {
		const s = queue.shift() as State;
		if (s.cond === false) {
			exits.set(s, null);
			continue;
		}
		const before = edges.length;
		exits.set(
			s,
			expand(src, m.node, s.next, s, [], new Set(), undefined, edges),
		);
		for (const e of edges.slice(before))
			if (!reached.has(e.to)) {
				reached.add(e.to);
				queue.push(e.to);
			}
	}
	for (const s of states)
		if (!reached.has(s))
			src.fail(s.node, `state ${s.label || s.name} is unreachable`);
	if (m.sub)
		for (const e of edges)
			if (e.from === entry && e.to === entry) {
				const at =
					e.acts.find((a) => a.k === "pulse" && a.implicit)?.node ?? m.node;
				src.fail(
					at,
					"this path ends the sub-FSM in its start cycle, before the caller waits for done; pass an await first (§5)",
				);
			}

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
		if (on.size === 0 && !(a.k === "pulse" && a.implicit))
			src.fail(a.node, "this action never runs");
		if (on.size === 0) continue;
		if (a.k === "pulse" && a.implicit === "end" && body.resultWidth > 0)
			src.fail(
				m.node,
				"a path reaches the end of this sub-FSM without `return <value>`",
			);
		const exact = (m: Map<State, Set<Edge>>) =>
			states.find((s) => {
				const set = m.get(s) as Set<Edge>;
				return set.size === on.size && subset(set, on);
			});
		const t = exact(into);
		const l = t ? undefined : exact(out);
		if (t) {
			drive.set(a, [
				sig(`move_to_${t.name}`, "move", into.get(t) as Set<Edge>),
			]);
			continue;
		}
		if (l) {
			drive.set(a, [sig(`leave_${l.name}`, "leave", out.get(l) as Set<Edge>)]);
			continue;
		}
		// Greedy cover: whole move_to_T, then whole leave_S, then per-edge signals.
		const rest = new Set(on);
		const chosen: Signal[] = [];
		const take = (s: Signal) => {
			chosen.push(s);
			for (const e of s.edges) rest.delete(e);
		};
		for (const s of states) {
			const set = into.get(s) as Set<Edge>;
			if (set.size > 0 && subset(set, rest))
				take(sig(`move_to_${s.name}`, "move", set));
		}
		for (const s of states) {
			const set = out.get(s) as Set<Edge>;
			if (set.size > 0 && subset(set, rest))
				take(sig(`leave_${s.name}`, "leave", set));
		}
		for (const e of [...rest]) {
			if (!rest.has(e)) continue;
			const pair = edges.filter((x) => x.from === e.from && x.to === e.to);
			const base = `move_${e.from.name}_to_${e.to.name}`;
			if (pair.every((x) => rest.has(x)))
				take(sig(base, "edge", new Set(pair)));
			else take(sig(`${base}_${pair.indexOf(e)}`, "edge", new Set([e])));
		}
		drive.set(a, chosen);
	}
	// A call state's start is the move into it (§5).
	for (const c of body.calls)
		if (c.state)
			sig(`move_to_${c.state.name}`, "move", into.get(c.state) as Set<Edge>);
	const onEdge = new Map<Edge, Signal[]>(edges.map((e) => [e, []]));
	const leave = new Map<State, Signal>();
	for (const s of signals.values()) {
		if (s.kind === "leave") for (const e of s.edges) leave.set(e.from, s);
		else for (const e of s.edges) onEdge.get(e)?.push(s);
	}
	checkUse(src, m.ports, body.wires, body.privateDffs);
	return {
		name: m.name,
		comment: m.comment,
		options: m.options,
		ports: [...body.implicitPorts, ...m.ports],
		privateDffs: body.privateDffs,
		wires: body.wires,
		states,
		entry,
		sub: m.sub,
		resultWidth: body.resultWidth,
		calls: body.calls,
		exits,
		drive,
		onEdge,
		leave,
	};
}

/** Unused ports and names would be -Wall warnings in the SV; reject them at the source. */
function checkUse(src: Src, ports: Port[], wires: Wire[], regs: Port[]) {
	for (const w of wires)
		if (!w.used) src.fail(w.node, `const ${w.name} is never used`);
	for (const p of [...ports, ...regs]) {
		if (p.k === "input" && !p.used)
			src.fail(p.node, `input ${p.name} is never read`);
		if (p.k === "output" && p.sites.length === 0 && !p.byCall)
			src.fail(p.node, `output ${p.name} is never pulsed`);
		if (p.k === "output" && p.sites.length > 0 && p.byCall)
			src.fail(
				p.node,
				`output ${p.name} is driven by both pulse() and the ${p.byCall.callee} call`,
			);
		if (p.k === "dff" && p.sites.length === 0)
			src.fail(p.node, `Dff ${p.name} is never set`);
		if (p.k === "dff" && p.place === "body" && !p.read)
			src.fail(p.node, `Dff ${p.name} is never read (.val)`);
	}
}
