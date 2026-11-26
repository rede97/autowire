// Fsm → SystemVerilog (§6.5, §7). One file per @FsmGroup: per state machine a
// package with the state enum and a module with one always_comb (next state,
// moves, leaves), one always_ff for the state register and one per Dff. Every
// always block is named: comb_<x> / ff_<x>.

import { lit, svText, valName } from "./expr.ts";
import type {
	Action,
	DffReg,
	EnumType,
	Fsm,
	HsPort,
	Signal,
	Tree,
	Ty,
} from "./model.ts";
import { FsmError } from "./source.ts";

/** SV type of an @SvEnum value (§2.8). */
const enumText = (t: EnumType) => `${t.pkg}::${t.name}`;

/** An and-or select is plain bits: cast it back when the target is an enum. */
const castTo = (t: Ty, expr: string) =>
	t.enum ? `${enumText(t.enum)}'(${expr})` : expr;

type St =
	| { k: "asg"; lhs: string; rhs: string }
	| { k: "if"; arms: { cond: string | null; body: St[] }[] };

const asg = (lhs: string, rhs: string): St => ({ k: "asg", lhs, rhs });

function printSts(sts: St[], ind: string, out: string[]) {
	let run: { lhs: string; rhs: string }[] = [];
	const flush = () => {
		const w = Math.max(...run.map((a) => a.lhs.length));
		for (const a of run) out.push(`${ind}${a.lhs.padEnd(w)} = ${a.rhs};`);
		run = [];
	};
	for (const s of sts) {
		if (s.k === "asg") {
			run.push(s);
			continue;
		}
		flush();
		s.arms.forEach((a, j) => {
			const head =
				j === 0
					? `if (${a.cond})`
					: a.cond === null
						? "else"
						: `else if (${a.cond})`;
			out.push(`${ind}${j === 0 ? "" : "end "}${head} begin`);
			printSts(a.body, `${ind}  `, out);
		});
		out.push(`${ind}end`);
	}
	flush();
}

/** The DSL text a statement comes from, as a comment line above it. */
const above = (c?: string) => (c ? [`  // ${c}`] : []);

const range = (w: number) => (w === 1 ? "" : `[${w - 1}:0]`);
const ors = (sigs: string[]) => [...new Set(sigs)].join(" | ");
const paren = (s: string) => (/[ ]/.test(s) ? `(${s})` : s);

/** The control signals live in one packed struct, `action` (§4). */
const act = (s: Signal) => `action.${s.name}`;

/** `if (a | b | c) begin`, one OR term per line when the line would pass 100 columns. */
function ifHead(head: string, cond: string, out: string[]) {
	const parts = topOrs(cond);
	const one = `${head}${cond}) begin`;
	if (parts.length < 2 || one.length < 100) {
		out.push(one);
		return;
	}
	const pad = " ".repeat(head.length - 2);
	out.push(`${head}${parts[0]}`);
	parts.slice(1).forEach((p, i) => {
		out.push(`${pad}| ${p}${i === parts.length - 2 ? ") begin" : ""}`);
	});
}

/** `always_ff ... begin : ff_<name>`: reset value, then `next` when `set` (no `set`: every cycle). */
function ffBlock(
	name: string,
	q: string,
	rst: string,
	set: string | null,
	next: string,
	c?: string,
): string[] {
	const out = [
		...above(c),
		`  always_ff @(posedge clk or negedge rst_n) begin : ff_${name}`,
		"    if (!rst_n) begin",
		`      ${q} <= ${rst};`,
	];
	if (set) ifHead("    end else if (", set, out);
	else out.push("    end else begin");
	out.push(`      ${q} <= ${next};`, "    end", "  end");
	return out;
}

/** Constant `v` of type `t`: the enum member with that value, else a sized literal (cast). */
function constOf(t: Ty, v: bigint): string {
	if (!t.enum) return svText(lit(t.width, v));
	const m = [...t.enum.members.values()].find((x) => x.value === v);
	return m ? `${t.enum.pkg}::${m.sv}` : castTo(t, svText(lit(t.width, v)));
}

/** Next state and the control signals; `order` lists the struct members. */
function nextState(f: Fsm): { lines: string[]; order: string[] } {
	const order: string[] = [];
	const note = (s: Signal) => {
		if (!order.includes(s.name)) order.push(s.name);
		return asg(act(s), "1'b1");
	};
	const tree = (t: Tree): St[] => {
		if (t.k === "leaf")
			return [
				asg("state_next", t.edge.to.member),
				...(f.onEdge.get(t.edge) ?? []).map(note),
			];
		const yes = { cond: svText(t.cond), body: tree(t.yes) };
		const no = tree(t.no);
		const only = no.length === 1 ? no[0] : undefined;
		const tail = only?.k === "if" ? only.arms : [{ cond: null, body: no }];
		return [{ k: "if", arms: [yes, ...tail] }];
	};
	const items: string[] = [];
	for (const s of f.states) {
		const exit = f.exits.get(s);
		const lv = f.leave.get(s);
		// leave_S is high on every way out of S, escapes included (§3.7).
		const leaving = (t: Tree): St[] => [...(lv ? [note(lv)] : []), ...tree(t)];
		const arms: { cond: string | null; body: St[] }[] = (
			exit?.escapes ?? []
		).map((e) => ({ cond: svText(e.cond), body: leaving(e.tree) }));
		let body: St[];
		if (!exit?.tree)
			body =
				arms.length > 0 ? [{ k: "if", arms }] : [asg("state_next", s.member)];
		else {
			const inner = leaving(exit.tree);
			if (typeof s.cond !== "boolean")
				arms.push({ cond: svText(s.cond), body: inner });
			else if (arms.length > 0) arms.push({ cond: null, body: inner });
			body = arms.length > 0 ? [{ k: "if", arms }] : inner;
		}
		items.push(`      ${s.member}:`);
		if (body.length === 1) printSts(body, "        ", items);
		else {
			items.push("        begin");
			printSts(body, "          ", items);
			items.push("        end");
		}
	}
	const out = ["  always_comb begin : comb_state"];
	printSts(
		[
			asg("state_next", "state_val"),
			...(order.length > 0 ? [asg("action", "'0")] : []),
		],
		"    ",
		out,
	);
	out.push("    unique case (state_val)", ...items, "      default:");
	out.push(`        state_next = ${f.entry.member};`, "    endcase", "  end");
	return { lines: out, order };
}

const siteSig = (f: Fsm, a: Action) => ors((f.drive.get(a) ?? []).map(act));

/** Written with two or more different values: a Dff at any width, an Output only when
 *  wider than 1 bit or an enum (a 1-bit pulse stays an OR). */
const caseSelect = (ty: Ty, sites: Action[], keepZero: boolean, dff = false) =>
	(dff || ty.width > 1 || ty.enum !== undefined) &&
	new Set(
		sites
			.filter((a) => keepZero || a.value.value !== 0n)
			.map((a) => svText(a.value.sv)),
	).size > 1;

/** `unique case (1'b1)` over the sites' control signals (exclusive: one move per cycle);
 *  `dflt` null leaves the target unchanged. Long item lists go one signal per line; a
 *  row of several statements is a `begin` / `end` block. */
function siteCase(
	f: Fsm,
	sites: Action[],
	keepZero: boolean,
	stmt: (v: string) => string[],
	dflt: string | null,
	ind: string,
): string[] {
	// Moves that write the same value share one row (items in first-write order).
	const byValue = new Map<string, string[]>();
	for (const a of sites) {
		if (!keepZero && a.value.value === 0n) continue;
		const v = svText(a.value.sv);
		const items = byValue.get(v) ?? [];
		for (const s of (f.drive.get(a) ?? []).map(act))
			if (!items.includes(s)) items.push(s);
		byValue.set(v, items);
	}
	const rows = [...byValue].map(([v, items]): [string[], string[]] => [
		items,
		stmt(v),
	]);
	// The default row: hold (`;`) or the zero value.
	rows.push([["default"], [dflt ?? ";"]]);
	const label = (items: string[]) =>
		items[0] === "default" ? "default:" : `${items.join(", ")}:`;
	const tall = rows.some(
		([items, body]) => label(items).length > 48 || body.length > 1,
	);
	const w = Math.max(...rows.map(([items]) => label(items).length));
	const out = [`${ind}unique case (1'b1)`];
	for (const [items, body] of rows) {
		const [one] = body;
		if (!tall || one === ";") {
			out.push(
				`${ind}  ${tall ? label(items) : label(items).padEnd(w)} ${body.join(" ")}`,
			);
			continue;
		}
		const many = body.length > 1;
		for (const [i, it] of items.entries())
			out.push(
				`${ind}  ${it}${i + 1 < items.length ? "," : many ? ": begin" : ":"}`,
			);
		for (const l of body) out.push(`${ind}    ${l}`);
		if (many) out.push(`${ind}  end`);
	}
	out.push(`${ind}endcase`);
	return out;
}

/** `always_comb begin : comb_<lhs>` holding a site case; 0 when no site fires. */
function combCase(
	f: Fsm,
	lhs: string,
	ty: Ty,
	sites: Action[],
	keepZero: boolean,
	c?: string,
): string[] {
	return [
		...above(c),
		`  always_comb begin : comb_${lhs}`,
		...siteCase(
			f,
			sites,
			keepZero,
			(v) => [`${lhs} = ${v};`],
			`${lhs} = ${constOf(ty, 0n)};`,
			"    ",
		),
		"  end",
	];
}

/** Priority-free and-or select of the written values; 0 when no site fires (§6.1, §6.5). */
function andOr(f: Fsm, ty: Ty, sites: Action[]): string {
	const { width } = ty;
	const ones: string[] = [];
	const terms: string[] = [];
	for (const a of sites) {
		const v = a.value;
		if (v.value === 0n) continue;
		if (width === 1 && v.value === 1n) {
			ones.push(...(f.drive.get(a) ?? []).map(act));
			continue;
		}
		const s = siteSig(f, a);
		terms.push(
			width === 1
				? `${paren(s)} & ${paren(svText(v.sv))}`
				: `{${width}{${s}}} & ${paren(svText(v.sv))}`,
		);
	}
	const parts = [
		...(ones.length > 0 ? [ors(ones)] : []),
		...(ones.length + terms.length > 1 ? terms.map(paren) : terms),
	];
	return castTo(
		ty,
		parts.length > 0 ? parts.join(" | ") : svText(lit(width, 0n)),
	);
}

/** `next` of a register: the one written value, else the and-or select. */
function nextExpr(f: Fsm, d: DffReg): string {
	const first = d.sites[0]?.value;
	if (first && d.sites.every((a) => svText(a.value.sv) === svText(first.sv)))
		return svText(first.sv);
	return andOr(f, d, d.sites);
}

type Drv =
	| { k: "asg"; lhs: string; rhs: string; c?: string }
	| { k: "raw"; lines: string[] };

/** A push / pop end this module drives from its waiting states (§6.2). */
function hsDrivers(p: HsPort): Drv[] {
	if (p.sites.length === 0 || p.byInst) return [];
	const dec = p.sites.map((s) => `state_val == ${s.state.member}`);
	const held =
		dec.length === 1 ? (dec[0] as string) : dec.map(paren).join(" | ");
	const c = [...new Set(p.sites.map((s) => s.text))].join(" / ");
	if (p.k === "pop") return [{ k: "asg", lhs: `${p.name}_rdy`, rhs: held, c }];
	const fields = p.msg.fields.map((f, j) => {
		const vals = p.sites.map((s) =>
			svText((s.values[j] ?? { sv: lit(f.width, 0n) }).sv),
		);
		return { f, lhs: `${p.name}_${f.name}`, vals };
	});
	if (fields.every((x) => new Set(x.vals).size === 1))
		return [
			{ k: "asg", lhs: `${p.name}_vld`, rhs: held, c },
			...fields.map(
				(x): Drv => ({ k: "asg", lhs: x.lhs, rhs: x.vals[0] as string }),
			),
		];
	// The data changes with the waiting state: one case on state_val drives vld and
	// every field. Plain fields share one concatenation with vld; an enum field is
	// assigned on its own (a concatenation is untyped bits).
	const plain = fields.filter((x) => !x.f.enum);
	const enums = fields.filter((x) => x.f.enum);
	const lhs = [`${p.name}_vld`, ...plain.map((x) => x.lhs)];
	const cat = (xs: string[]) =>
		xs.length === 1 ? xs[0] : `{${xs.join(", ")}}`;
	const row = (i: number) => {
		const s = [
			`${cat(lhs)} = ${cat(["1'b1", ...plain.map((x) => x.vals[i] as string)])};`,
			...enums.map((x) => `${x.lhs} = ${x.vals[i]};`),
		];
		return s.length === 1 ? (s[0] as string) : `begin ${s.join(" ")} end`;
	};
	const labels = p.sites.map((s) => `${s.state.member}:`);
	const w = Math.max(8, ...labels.map((l) => l.length));
	return [
		{
			k: "raw",
			lines: [
				...above(c),
				`  always_comb begin : comb_${p.name}`,
				`    ${cat(lhs)} = ${lhs.length === 1 ? "1'b0" : "'0"};`,
				...enums.map((x) => `    ${x.lhs} = ${constOf(x.f, 0n)};`),
				"    case (state_val)",
				...labels.map((l, i) => `      ${l.padEnd(w)} ${row(i)}`),
				`      ${"default:".padEnd(w)} ;`,
				"    endcase",
				"  end",
			],
		},
	];
}

function drivers(f: Fsm): string[] {
	const items: Drv[] = [];
	const texts = (sites: Action[]) =>
		[...new Set(sites.map((a) => a.text))].join(" / ");
	const set = (sites: Action[]) => ors(sites.map((a) => siteSig(f, a)));
	const ends = f.chans.flatMap((c) => [c.tx, c.rx]);
	for (const p of [...f.ports, ...ends, ...f.privateDffs]) {
		if (p.k === "output" && !p.byInst)
			items.push(
				caseSelect(p, p.sites, false)
					? {
							k: "raw",
							lines: combCase(f, p.name, p, p.sites, false, texts(p.sites)),
						}
					: {
							k: "asg",
							lhs: p.name,
							rhs: andOr(f, p, p.sites),
							c: texts(p.sites),
						},
			);
		if (p.k === "push" || p.k === "pop") items.push(...hsDrivers(p));
		if (p.k !== "dff") continue;
		if (p.place === "external") {
			if (caseSelect(p, p.sites, true, true)) {
				// One block drives both ports: each move sets the register to its value.
				const s = `${p.name}_set`;
				const n = `${p.name}_next`;
				const w = Math.max(s.length, n.length);
				items.push({
					k: "raw",
					lines: [
						...above(texts(p.sites)),
						`  always_comb begin : comb_${p.name}`,
						`    ${s.padEnd(w)} = 1'b0;`,
						`    ${n.padEnd(w)} = ${constOf(p, 0n)};`,
						...siteCase(
							f,
							p.sites,
							true,
							(v) => [`${s.padEnd(w)} = 1'b1;`, `${n.padEnd(w)} = ${v};`],
							null,
							"    ",
						),
						"  end",
					],
				});
				continue;
			}
			items.push({
				k: "asg",
				lhs: `${p.name}_set`,
				rhs: set(p.sites),
				c: texts(p.sites),
			});
			items.push({ k: "asg", lhs: `${p.name}_next`, rhs: nextExpr(f, p) });
			continue;
		}
		const q = valName(p);
		items.push({
			k: "raw",
			lines: caseSelect(p, p.sites, true, true)
				? [
						...above(texts(p.sites)),
						`  always_ff @(posedge clk or negedge rst_n) begin : ff_${p.name}`,
						"    if (!rst_n) begin",
						`      ${q} <= ${constOf(p, p.reset)};`,
						"    end else begin",
						...siteCase(
							f,
							p.sites,
							true,
							(v) => [`${q} <= ${v};`],
							null,
							"      ",
						),
						"    end",
						"  end",
					]
				: ffBlock(
						p.name,
						q,
						constOf(p, p.reset),
						set(p.sites),
						nextExpr(f, p),
						texts(p.sites),
					),
		});
	}
	const out: string[] = [];
	let run: { lhs: string; rhs: string; c?: string }[] = [];
	const flush = () => {
		const w = Math.max(...run.map((a) => a.lhs.length));
		for (const a of run) {
			const head = `  assign ${a.lhs.padEnd(w)} = `;
			const parts = topOrs(a.rhs);
			const one = `${head}${a.rhs};`;
			out.push(...above(a.c));
			if (parts.length < 2 || one.length < 100) {
				out.push(one);
				continue;
			}
			// One term per line, `|` under `=`.
			out.push(`${head}${parts[0]}`);
			parts.slice(1).forEach((p, i) => {
				out.push(
					`${" ".repeat(head.length - 2)}| ${p}${i === parts.length - 2 ? ";" : ""}`,
				);
			});
		}
		run = [];
	};
	for (const it of items) {
		if (it.k === "asg") run.push(it);
		else {
			flush();
			out.push(...it.lines);
		}
	}
	flush();
	return out;
}

/** Split `a | (b | c) | d` at the ORs outside parentheses and braces. */
function topOrs(s: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (ch === "(" || ch === "{") depth++;
		else if (ch === ")" || ch === "}") depth--;
		else if (depth === 0 && s.startsWith(" | ", i)) {
			out.push(s.slice(start, i));
			start = i + 3;
		}
	}
	out.push(s.slice(start));
	return out;
}

/** The state enum type: `@Fsm({ stateType })`, default `<module>_state_e`. */
export const stateType = (f: Fsm) => f.options.stateType ?? `${f.name}_state_e`;

/** The state enum and action struct of one state machine, for the package `pkg`. */
export interface PkgPart {
	pkg: string;
	/** Module that declares them. */
	from: string;
	/** typedef lines, indented for a package body. */
	types: string[];
	/** Package-scope names they declare: enum members and type names. */
	names: string[];
}

/** One state machine: its package types, its module and the optional logic-port wrapper. */
function emitFsm(f: Fsm): { part: PkgPart; mod: string[]; wrap: string[] } {
	const n = f.name;
	const st = stateType(f);
	const enc = f.options.stateEncoding;
	const count = f.states.length;
	const bits =
		enc === "onehot" ? count : Math.max(1, Math.ceil(Math.log2(count)));
	const values = f.options.stateValues?.values;
	const members = f.states.map((s, i) =>
		values
			? `${s.member} = ${bits}'d${values.get(s.member)}`
			: enc === "binary"
				? `${s.member} = ${bits}'d${i}`
				: enc === "onehot"
					? `${s.member} = ${bits}'b${(1n << BigInt(i)).toString(2).padStart(bits, "0")}`
					: s.member,
	);
	const { lines: comb, order } = nextState(f);
	const types = [
		`  typedef enum logic [${bits - 1}:0] {`,
		...members.map((m, i) => `    ${m}${i + 1 < members.length ? "," : ""}`),
		`  } ${st};`,
		...(order.length > 0
			? [
					"",
					"  typedef struct packed {",
					...order.map((m) => `    logic ${m};`),
					`  } ${n}_action_t;`,
				]
			: []),
	];
	const pkg = f.options.pkg?.name ?? `${n}_pkg`;
	const part: PkgPart = {
		pkg,
		from: n,
		types,
		names: [
			...f.states.map((s) => s.member),
			st,
			...(order.length > 0 ? [`${n}_action_t`] : []),
		],
	};
	const out = [
		...f.comment.map((l) => (l === "" ? "//" : `// ${l}`)),
		`module ${n}`,
		`  import ${pkg}::*;`,
		"(",
	];
	const ports = portList(f);
	printPorts(out, ports, (t, rw) =>
		t === "state"
			? st
			: t === "action"
				? `${n}_action_t`
				: t.enum
					? enumText(t.enum)
					: `logic${rw > 0 ? ` ${range(t.width).padEnd(rw)}` : ""}`,
	);
	const one: Ty = { width: 1 };
	const data: [Ty, string][] = [
		...f.chans.flatMap((c): [Ty, string][] => [
			[one, `${c.name}_vld`],
			[one, `${c.name}_rdy`],
			...c.msg.fields.map((m): [Ty, string] => [m, `${c.name}_${m.name}`]),
		]),
		...f.wires.map((w): [Ty, string] => [w, w.name]),
		...f.privateDffs.map((d): [Ty, string] => [d, valName(d)]),
	];
	const narrow = data
		.filter(([t]) => t.width === 1 && !t.enum)
		.map(([, name]) => name);
	const decls: [string, string][] = [[st, "state_val, state_next"]];
	if (order.length > 0) decls.push([`${n}_action_t`, "action"]);
	if (narrow.length > 0) decls.push(["logic", narrow.join(", ")]);
	for (const [t, name] of data)
		if (t.enum) decls.push([enumText(t.enum), name]);
		else if (t.width > 1) decls.push([`logic ${range(t.width)}`, name]);
	const tw = Math.max(...decls.map(([t]) => t.length));
	for (const [t, names] of decls) out.push(`  ${t.padEnd(tw)} ${names};`);
	out.push("");
	if (f.wires.length > 0) {
		const w = Math.max(...f.wires.map((x) => x.name.length));
		for (const x of f.wires)
			out.push(`  assign ${x.name.padEnd(w)} = ${svText(x.sv)};`);
		out.push("");
	}
	out.push(...comb, "");
	out.push(
		...ffBlock("state", "state_val", f.entry.member, null, "state_next"),
		"",
	);
	for (const inst of f.insts) {
		const w = Math.max(...inst.conn.map(([p]) => p.length));
		out.push(`  ${inst.module} ${inst.name} (`, "    .clk, .rst_n,");
		for (const [i, [p, e]] of inst.conn.entries())
			out.push(
				`    .${p.padEnd(w)} (${e})${i + 1 < inst.conn.length ? "," : ""}`,
			);
		out.push("  );", "");
	}
	const dr = drivers(f);
	out.push(...dr);
	if (f.options.exportState) {
		if (dr.length > 0) out.push("");
		out.push(
			"  // exportState",
			`  assign state_set_o  = ${order.length > 0 ? "|action" : "1'b0"};`,
			"  assign state_next_o = state_next;",
			"  assign state_val_o  = state_val;",
		);
	}
	if (f.options.exportAction) {
		if (dr.length > 0 || f.options.exportState) out.push("");
		out.push("  // exportAction", "  assign action_o = action;");
	}
	out.push("endmodule");
	const wrap = f.options.wrap
		? emitWrap(f, f.options.wrap, ports, bits, order.length)
		: [];
	return { part, mod: out, wrap };
}

/** A port row type: a signal type, or "state" / "action" for the module's state enum /
 *  action struct. */
type PortTy = Ty | "state" | "action";
/** [dir, type, name, group header lines printed above the port] */
type PortRow = [string, PortTy, string, string[]?];

function portList(f: Fsm): PortRow[] {
	const one: Ty = { width: 1 };
	const ports: PortRow[] = [
		["input", one, "clk", ["clock and reset"]],
		["input", one, "rst_n"],
	];
	for (const p of f.ports) {
		switch (p.k) {
			case "input":
			case "output":
				ports.push([p.k, p, p.name, p.group]);
				break;
			case "push":
			case "pop": {
				const [o, i] =
					p.k === "push" ? ["output", "input"] : ["input", "output"];
				ports.push(
					[o, one, `${p.name}_vld`, p.group],
					[i, one, `${p.name}_rdy`],
					...p.msg.fields.map((m): PortRow => [o, m, `${p.name}_${m.name}`]),
				);
				break;
			}
			case "dff":
				if (p.place === "port") ports.push(["output", p, p.name, p.group]);
				// A write-only external register (e.g. an RWW field) has no _val input.
				else
					ports.push(
						["output", one, `${p.name}_set`, p.group],
						["output", p, `${p.name}_next`],
						...(p.read ? [["input", p, `${p.name}_val`] as PortRow] : []),
					);
		}
	}
	if (f.options.exportState)
		ports.push(
			["output", one, "state_set_o", ["exportState"]],
			["output", "state", "state_next_o"],
			["output", "state", "state_val_o"],
		);
	if (f.options.exportAction)
		ports.push(["output", "action", "action_o", ["exportAction"]]);
	// The author's ports never sit under a generated group without their own header.
	const firstUser = ports[2];
	if (firstUser && !firstUser[3]) firstUser[3] = ["ports"];
	return ports;
}

/** Port declarations and `);`. `typeOf` gets the widest plain-logic range text width. */
function printPorts(
	out: string[],
	ports: PortRow[],
	typeOf: (t: PortTy, rw: number) => string,
) {
	const plain = (t: PortTy) =>
		t === "state" || t === "action" || t.enum ? undefined : t.width;
	const rw = Math.max(
		...ports.map(([, t]) => {
			const w = plain(t);
			return w === undefined ? 0 : range(w).length;
		}),
	);
	const pw = Math.max(...ports.map(([, t]) => typeOf(t, rw).length));
	for (const [i, [dir, t, name, group]] of ports.entries()) {
		for (const g of group ?? []) out.push(g === "" ? "  //" : `  // ${g}`);
		out.push(
			`  ${dir.padEnd(6)} ${typeOf(t, rw).padEnd(pw)} ${name}${i + 1 < ports.length ? "," : ""}`,
		);
	}
	out.push(");");
}

/** `@Fsm({ wrap })`: the same ports, every enum (the state type too) and the action struct
 *  as a logic vector, for tools that read plain logic ports only. Enum inputs are cast on
 *  the way in. */
function emitWrap(
	f: Fsm,
	name: string,
	ports: PortRow[],
	bits: number,
	actionBits: number,
): string[] {
	const width = (t: PortTy) =>
		t === "state"
			? bits
			: t === "action"
				? actionBits
				: t.enum
					? t.enum.width
					: t.width;
	const out = [
		`// ${name}: ${f.name} with its enum ports as logic vectors.`,
		`module ${name}`,
		"(",
	];
	const rw = Math.max(...ports.map(([, t]) => range(width(t)).length));
	printPorts(
		out,
		ports,
		(t) => `logic${rw > 0 ? ` ${range(width(t)).padEnd(rw)}` : ""}`,
	);
	const conn = ports.slice(2);
	const w = Math.max(...conn.map(([, , n]) => n.length));
	out.push(`  ${f.name} u_${f.name} (`, "    .clk, .rst_n,");
	for (const [i, [dir, t, n]] of conn.entries()) {
		const e =
			dir === "input" && t !== "state" && t !== "action" ? castTo(t, n) : n;
		out.push(`    .${n.padEnd(w)} (${e})${i + 1 < conn.length ? "," : ""}`);
	}
	out.push("  );", "endmodule");
	return out;
}

/** A group's SV files and the package parts it hands to @SvEnum packages of other files.
 *  One file `stem` by default; with `split` one file per module (its package, module and
 *  wrapper), and `stem` keeps the group's own @SvEnum packages, if any. */
export function emitGroup(
	g: { name: string; comment: string[]; fsms: Fsm[]; enums: EnumType[] },
	file: string,
	stem: string,
	inbound: PkgPart[] = [],
	split = false,
): { files: { stem: string; sv: string }[]; outbound: PkgPart[] } {
	const head = [
		`// Generated by autowire fsm (${g.name}). Do not edit: SoT is ${file}.`,
		"",
	];
	if (g.comment.length > 0)
		head.push(...g.comment.map((l) => (l === "" ? "//" : `// ${l}`)), "");
	const out: string[] = [];
	const fsms = g.fsms.map(emitFsm);
	const own = new Set(g.enums.map((t) => t.pkg));
	const shared = [
		...fsms.map((p) => p.part).filter((p) => own.has(p.pkg)),
		...inbound,
	];
	for (const p of own) {
		const enums = g.enums.filter((x) => x.pkg === p);
		const parts = shared.filter((x) => x.pkg === p);
		// Every name of the package is declared once (statePrefix keeps state members apart).
		const seen = new Map<string, string>();
		const claim = (name: string, by: string) => {
			const prev = seen.get(name);
			if (prev)
				throw new FsmError(
					`fsm: package ${p} declares ${name} twice (${prev} and ${by}); give the state machines a statePrefix`,
				);
			seen.set(name, by);
		};
		for (const t of enums) {
			claim(t.name, `@SvEnum ${t.name}`);
			for (const m of t.members.values()) claim(m.sv, `@SvEnum ${t.name}`);
		}
		for (const x of parts) for (const n of x.names) claim(n, x.from);
		out.push(`package ${p};`);
		enums.forEach((t, j) => {
			// Enums are separated by a blank line; the class doc comment leads each.
			if (j > 0) out.push("");
			out.push(...t.comment.map((l) => (l === "" ? "  //" : `  // ${l}`)));
			const ms = [...t.members.values()];
			out.push(`  typedef enum logic [${t.width - 1}:0] {`);
			for (const [i, m] of ms.entries())
				out.push(
					`    ${m.sv} = ${t.width}'d${m.value}${i + 1 < ms.length ? "," : ""}`,
				);
			out.push(`  } ${t.name};`);
		});
		for (const x of parts)
			out.push("", `  // ${x.from}: state enum and action struct`, ...x.types);
		out.push("endpackage", "");
	}
	// Packages first (every module's types are declared before any module),
	// then the state machines, then their logic-port wrappers.
	const local = (p: PkgPart) => p.pkg === `${p.from}_pkg` && !own.has(p.pkg);
	const pkgBlock = (p: PkgPart) => [
		`package ${p.pkg};`,
		...p.types,
		"endpackage",
	];
	const text = (blocks: string[][], lead: string[]) => {
		const lines = [...head, ...lead];
		blocks.forEach((b, i) => {
			if (i > 0) lines.push("");
			lines.push(...b);
		});
		while (lines.at(-1) === "") lines.pop();
		return `${lines.join("\n")}\n`;
	};
	const files = split
		? [
				...(own.size > 0 ? [{ stem, sv: text([], out) }] : []),
				...fsms.map((p) => ({
					stem: p.part.from,
					sv: text(
						[
							...(local(p.part) ? [pkgBlock(p.part)] : []),
							p.mod,
							...(p.wrap.length > 0 ? [p.wrap] : []),
						],
						[],
					),
				})),
			]
		: [
				{
					stem,
					sv: text(
						[
							...fsms.filter((p) => local(p.part)).map((p) => pkgBlock(p.part)),
							...fsms.map((p) => p.mod),
							...fsms.flatMap((p) => (p.wrap.length > 0 ? [p.wrap] : [])),
						],
						out,
					),
				},
			];
	const outbound = fsms
		.map((p) => p.part)
		.filter((p) => !own.has(p.pkg) && !local(p));
	return { files, outbound };
}
