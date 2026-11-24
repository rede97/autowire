// Fsm → SystemVerilog (§6.5, §7). One file per @FsmGroup: per state machine a
// package with the state enum and a module with one always_comb (next state,
// moves, leaves) and one always_ff (state register).

import { lit, svText, valName } from "./expr.ts";
import type { Action, DffReg, Fsm, HsPort, Signal, Tree } from "./model.ts";

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

/** `code  // comment` with the comment at column 64 when it fits. */
const commented = (code: string, c?: string) =>
	c ? `${code.length < 63 ? code.padEnd(64) : `${code}  `}// ${c}` : code;

const range = (w: number) => (w === 1 ? "" : `[${w - 1}:0]`);
const ors = (sigs: string[]) => [...new Set(sigs)].join(" | ");
const paren = (s: string) => (/[ ]/.test(s) ? `(${s})` : s);

function nextState(f: Fsm): string[] {
	const order: string[] = [];
	const note = (s: Signal) => {
		if (!order.includes(s.name)) order.push(s.name);
		return asg(s.name, "1'b1");
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
		const exit = f.exits.get(s) ?? null;
		let body: St[];
		if (exit === null) body = [asg("state_next", s.member)];
		else {
			const lv = f.leave.get(s);
			const inner = [...(lv ? [note(lv)] : []), ...tree(exit)];
			body =
				typeof s.cond === "boolean"
					? inner
					: [{ k: "if", arms: [{ cond: svText(s.cond), body: inner }] }];
		}
		items.push(`      ${s.member}:`);
		if (body.length === 1) printSts(body, "        ", items);
		else {
			items.push("        begin");
			printSts(body, "          ", items);
			items.push("        end");
		}
	}
	const out = ["  always_comb begin"];
	printSts(
		[asg("state_next", "state_val"), ...order.map((n) => asg(n, "1'b0"))],
		"    ",
		out,
	);
	out.push("    unique case (state_val)", ...items, "      default:");
	out.push(`        state_next = ${f.entry.member};`, "    endcase", "  end");
	return out;
}

const siteSig = (f: Fsm, a: Action) =>
	ors((f.drive.get(a) ?? []).map((s) => s.name));

/** Priority-free and-or select of the written values; 0 when no site fires (§6.1, §6.5). */
function andOr(f: Fsm, width: number, sites: Action[]): string {
	const ones: string[] = [];
	const terms: string[] = [];
	for (const a of sites) {
		const v = a.value;
		if (v.value === 0n) continue;
		if (width === 1 && v.value === 1n) {
			ones.push(...(f.drive.get(a) ?? []).map((s) => s.name));
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
	return parts.length > 0 ? parts.join(" | ") : svText(lit(width, 0n));
}

/** `next` of a register: the one written value, else the and-or select. */
function nextExpr(f: Fsm, d: DffReg): string {
	const first = d.sites[0]?.value;
	if (first && d.sites.every((a) => svText(a.value.sv) === svText(first.sv)))
		return svText(first.sv);
	return andOr(f, d.width, d.sites);
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
	const vals = p.sites.map((s) => svText(s.value?.sv ?? lit(p.width, 0n)));
	const data =
		new Set(vals).size === 1
			? (vals[0] as string)
			: vals
					.map((v, i) =>
						p.width === 1
							? `(${dec[i]}) & ${paren(v)}`
							: `({${p.width}{${dec[i]}}} & ${paren(v)})`,
					)
					.join(" | ");
	return [
		{ k: "asg", lhs: `${p.name}_vld`, rhs: held, c },
		{ k: "asg", lhs: `${p.name}_data`, rhs: data },
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
			items.push({
				k: "asg",
				lhs: p.name,
				rhs: andOr(f, p.width, p.sites),
				c: texts(p.sites),
			});
		if (p.k === "push" || p.k === "pop") items.push(...hsDrivers(p));
		if (p.k !== "dff") continue;
		if (p.place === "external") {
			items.push({
				k: "asg",
				lhs: `${p.name}_set`,
				rhs: set(p.sites),
				c: texts(p.sites),
			});
			items.push({ k: "asg", lhs: `${p.name}_next`, rhs: nextExpr(f, p) });
			continue;
		}
		const params = [
			...(p.width > 1 ? [`.T(logic ${range(p.width)})`] : []),
			...(p.reset !== 0n ? [`.RST(${svText(lit(p.width, p.reset))})`] : []),
		];
		const ps = params.length > 0 ? ` #(${params.join(", ")})` : "";
		items.push({
			k: "raw",
			lines: [
				`  aw_dff${ps} u_${p.name} (.clk, .rst_n,`,
				commented(`    .set(${set(p.sites)}),`, texts(p.sites)),
				`    .next(${nextExpr(f, p)}), .val(${valName(p)}));`,
			],
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
			if (parts.length < 2 || (one.length < 100 && (!a.c || one.length < 63))) {
				out.push(commented(one, a.c));
				continue;
			}
			// One term per line, `|` under `=`.
			out.push(commented(`${head}${parts[0]}`, a.c));
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

function emitFsm(f: Fsm): string[] {
	const n = f.name;
	const enc = f.options.stateEncoding;
	const count = f.states.length;
	const bits =
		enc === "onehot" ? count : Math.max(1, Math.ceil(Math.log2(count)));
	const members = f.states.map((s, i) =>
		enc === "binary"
			? `${s.member} = ${bits}'d${i}`
			: enc === "onehot"
				? `${s.member} = ${bits}'b${(1n << BigInt(i)).toString(2).padStart(bits, "0")}`
				: s.member,
	);
	const out = [
		`package ${n}_pkg;`,
		`  typedef enum logic [${bits - 1}:0] {${members.join(", ")}} state_t;`,
		"endpackage",
		"",
		...f.comment.map((l) => (l === "" ? "//" : `// ${l}`)),
		`module ${n}`,
		`  import ${n}_pkg::*;`,
		"(",
	];
	// [dir, width, name, group header lines printed above the port]
	const ports: [string, number, string, string[]?][] = [
		["input", 1, "clk", ["clock and reset"]],
		["input", 1, "rst_n"],
	];
	for (const p of f.ports) {
		if (p.k === "input") ports.push(["input", p.width, p.name, p.group]);
		else if (p.k === "output") ports.push(["output", p.width, p.name, p.group]);
		else if (p.k === "push" || p.k === "pop") {
			const [o, i] = p.k === "push" ? ["output", "input"] : ["input", "output"];
			ports.push(
				[o, 1, `${p.name}_vld`, p.group],
				[i, 1, `${p.name}_rdy`],
				[o, p.width, `${p.name}_data`],
			);
		} else if (p.place === "port")
			ports.push(["output", p.width, p.name, p.group]);
		else
			ports.push(
				["output", 1, `${p.name}_set`, p.group],
				["output", p.width, `${p.name}_next`],
				["input", p.width, `${p.name}_val`],
			);
	}
	// The author's ports never sit under a generated group without their own header.
	const firstUser = ports[2];
	if (firstUser && !firstUser[3]) firstUser[3] = ["ports"];
	const rw = Math.max(...ports.map(([, w]) => range(w).length));
	for (const [i, [dir, w, name, group]] of ports.entries()) {
		for (const g of group ?? []) out.push(g === "" ? "  //" : `  // ${g}`);
		const r = rw > 0 ? ` ${range(w).padEnd(rw)}` : "";
		out.push(
			`  ${dir.padEnd(6)} logic${r} ${name}${i + 1 < ports.length ? "," : ""}`,
		);
	}
	out.push(");");
	const comb = nextState(f);
	const ctl = comb
		.slice(2)
		.flatMap((l) => /^ {4}(\S+)\s+= 1'b0;$/.exec(l)?.[1] ?? []);
	const data = [
		...f.chans.flatMap((c) => [
			[1, `${c.name}_vld`] as const,
			[1, `${c.name}_rdy`] as const,
			[c.width, `${c.name}_data`] as const,
		]),
		...f.wires.map((w) => [w.width, w.name] as const),
		...f.privateDffs.map((d) => [d.width, valName(d)] as const),
	];
	const narrow = data.filter(([w]) => w === 1).map(([, name]) => name);
	const decls: [string, string][] = [["state_t", "state_val, state_next"]];
	if (ctl.length > 0) decls.push(["logic", ctl.join(", ")]);
	if (narrow.length > 0) decls.push(["logic", narrow.join(", ")]);
	for (const [w, name] of data)
		if (w > 1) decls.push([`logic ${range(w)}`, name]);
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
	out.push("  always_ff @(posedge clk or negedge rst_n)");
	out.push(`    if (!rst_n) state_val <= ${f.entry.member};`);
	out.push("    else        state_val <= state_next;", "");
	for (const inst of f.insts) {
		const w = Math.max(...inst.conn.map(([p]) => p.length));
		out.push(`  ${inst.module} ${inst.name} (`, "    .clk, .rst_n,");
		for (const [i, [p, e]] of inst.conn.entries())
			out.push(
				`    .${p.padEnd(w)} (${e})${i + 1 < inst.conn.length ? "," : ""}`,
			);
		out.push("  );", "");
	}
	out.push(...drivers(f), "endmodule");
	return out;
}

export function emitGroup(
	g: { name: string; comment: string[]; fsms: Fsm[] },
	file: string,
): string {
	const out = [
		`// Generated by autowire fsm (${g.name}). Do not edit: SoT is ${file}.`,
		"",
	];
	if (g.comment.length > 0)
		out.push(...g.comment.map((l) => (l === "" ? "//" : `// ${l}`)), "");
	g.fsms.forEach((f, i) => {
		if (i > 0) out.push("");
		out.push(...emitFsm(f));
	});
	return `${out.join("\n")}\n`;
}
