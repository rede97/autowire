// Emit SystemVerilog for wishbone-bus decoder / interconnect / crossbar.
// Slave ports use leaf-centric names: `{slave}_i_wb_*` / `{slave}_o_wb_*`
// so they identity-match wishbone-regfile. Masters stay flat m_* vectors when NM>1.

import type { BusDef, WbMaster, WbSlave, WbTagSource } from "./dsl.ts";
import { domainWidth, tagDomainsWidth } from "./dsl.ts";
import { packedTagExpr, tagPinPort, tagPlan, tagPort } from "./tag.ts";

function hex(n: number, width = 32): string {
	return n.toString(16).padStart(Math.ceil(width / 4), "0");
}

function wb(slave: string, stem: string): string {
	return `${slave}_${stem}`;
}

function packedRange(width: number): string {
	return width > 1 ? `[${width - 1}:0]` : "";
}

/** Data slaves. A broadcast window produces a strobe and has no WB port. */
function dataSlaves(def: BusDef): WbSlave[] {
	return dataOf(def.slaves);
}

function dataOf(slaves: readonly WbSlave[]): WbSlave[] {
	return slaves.filter((s) => !s.broadcast);
}

function slotLp(name: string): string {
	return `SLOT_${name.toUpperCase()}`;
}

/** Slave-group slot localparam (crossbar target decode). */
function groupLp(name: string): string {
	return `SG_${name.toUpperCase()}`;
}

function slotSel(name: string, vec = "slot_sel"): string {
	return `${vec}[${slotLp(name)}]`;
}

/**
 * One decode scope: the slaves one `slot_sel` vector covers. The classic
 * decoder / interconnect has a single scope over every slave; a crossbar
 * has one scope per slave group with prefixed `slot_sel` / `unmapped` nets.
 */
type DecodeScope = {
	readonly slaves: readonly WbSlave[];
	readonly slotVec: string;
	readonly unmapped: string;
};

function wholeScope(def: BusDef): DecodeScope {
	return { slaves: def.slaves, slotVec: "slot_sel", unmapped: "unmapped" };
}

export type BusModuleKind = "decoder" | "interconnect" | "crossbar";

/** Module basename: crossbar when grouped; else decoder if NM<=1, else interconnect. */
export function busModuleKind(def: BusDef): BusModuleKind {
	if (def.crossbar) return "crossbar";
	return def.masters.length <= 1 ? "decoder" : "interconnect";
}

export function busModuleName(def: BusDef): string {
	return `${def.name.toLowerCase()}_${busModuleKind(def)}`;
}

/** Type-A wrapper that instantiates the fabric + attached regfile leaves. */
export function busSystemModuleName(def: BusDef): string {
	return `${def.name.toLowerCase()}_bus_cfg`;
}

export type FabricPort = {
	readonly dir: "input" | "output";
	readonly packed: string;
	readonly name: string;
	readonly comment?: string;
};

function slaveTagPorts(s: WbSlave, _def: BusDef): FabricPort[] {
	if (s.regfile) {
		return s.regfile.shadows.map((shadow) => ({
			dir: "output" as const,
			packed: packedRange(shadow.tag_width),
			name: tagPort(wb(s.name, "i_wb"), shadow.name),
		}));
	}
	if (s.bus) {
		return s.bus.tags
			.filter((t) => t.source === "uplink")
			.map((t) => ({
				dir: "output" as const,
				packed: packedRange(domainWidth(t.domain)),
				name: tagPort(wb(s.name, "i_wb"), t.domain.name),
			}));
	}
	const width = s.tag ?? 0;
	return width > 0
		? [
				{
					dir: "output",
					packed: packedRange(width),
					name: tagPort(wb(s.name, "i_wb"), "tag"),
				},
			]
		: [];
}

/** Tag domains a slave port actually reads (`g_tga_<domain>` and friends). */
function consumedTagDomains(
	def: BusDef,
	slaves: readonly WbSlave[],
): Set<string> {
	const names = new Set<string>();
	for (const s of slaves) {
		for (const p of slaveTagPorts(s, def)) {
			const at = p.name.lastIndexOf("_tga_");
			if (at >= 0) names.add(p.name.slice(at + 5));
		}
	}
	return names;
}

/** `<prefix>tga_<domain>` nets no slave in `slaves` reads. */
function unconsumedTagTerms(
	def: BusDef,
	slaves: readonly WbSlave[],
	prefix: string,
): string[] {
	const consumed = consumedTagDomains(def, slaves);
	return def.tags
		.filter((t) => !consumed.has(t.domain.name))
		.map((t) => `${prefix}tga_${t.domain.name}`);
}

/**
 * Read `terms` so Verilator -Wall does not flag protocol nets this topology
 * leaves idle. The sink wire itself is unused; lint_off covers only that.
 */
function emitUnusedSink(id: string, terms: readonly string[]): string[] {
	if (terms.length === 0) return [];
	return [
		"\t// Protocol nets this topology declares but does not consume.",
		"\t/* verilator lint_off UNUSEDSIGNAL */",
		`\twire _unused_${id} = &{1'b0, ${terms.join(", ")}};`,
		"\t/* verilator lint_on UNUSEDSIGNAL */",
	];
}

function slaveWbPorts(s: WbSlave, aw: number, def: BusDef): FabricPort[] {
	const n = s.name;
	const ports: FabricPort[] = [
		{
			dir: "output",
			packed: packedRange(aw),
			name: wb(n, "i_wb_adr"),
			comment: `Slave ${n} — ${s.desc}`,
		},
		{ dir: "output", packed: "[31:0]", name: wb(n, "i_wb_dat") },
		{ dir: "output", packed: "[3:0]", name: wb(n, "i_wb_sel") },
		...slaveTagPorts(s, def),
	];
	ports.push(
		{ dir: "output", packed: "", name: wb(n, "i_wb_cyc") },
		{ dir: "output", packed: "", name: wb(n, "i_wb_stb") },
		{ dir: "output", packed: "", name: wb(n, "i_wb_we") },
		{ dir: "input", packed: "[31:0]", name: wb(n, "o_wb_dat") },
		{ dir: "input", packed: "", name: wb(n, "o_wb_ack") },
	);
	return ports;
}

function masterWbPorts(
	def: BusDef,
	name: string,
	desc: string,
	aw: number,
): FabricPort[] {
	const ports: FabricPort[] = [
		{
			dir: "input",
			packed: packedRange(aw),
			name: wb(name, "o_wb_adr"),
			comment: `Master ${name} — ${desc}`,
		},
		{ dir: "input", packed: "[31:0]", name: wb(name, "o_wb_dat") },
		{ dir: "input", packed: "[3:0]", name: wb(name, "o_wb_sel") },
		...tagPlan(def).inherited.map((t) => ({
			dir: "input" as const,
			packed: packedRange(domainWidth(t.domain)),
			name: tagPort(wb(name, "o_wb"), t.domain.name),
		})),
	];
	ports.push(
		{ dir: "input", packed: "", name: wb(name, "o_wb_cyc") },
		{ dir: "input", packed: "", name: wb(name, "o_wb_stb") },
		{ dir: "input", packed: "", name: wb(name, "o_wb_we") },
		{ dir: "output", packed: "[31:0]", name: wb(name, "i_wb_dat") },
		{ dir: "output", packed: "", name: wb(name, "i_wb_ack") },
	);
	return ports;
}

/** Flattened fabric ports (clk/rst first; then masters; then slaves). */
export function listFabricPorts(def: BusDef): FabricPort[] {
	const kind = busModuleKind(def);
	const aw = def.addr_width;
	const ports: FabricPort[] = [
		{ dir: "input", packed: "", name: "clk" },
		{ dir: "input", packed: "", name: "rst_n" },
	];
	if (kind !== "decoder") {
		ports.push({ dir: "input", packed: "", name: "rb_grant_en" });
	}
	const plan = tagPlan(def);
	for (const p of plan.pins) {
		ports.push({
			dir: "input",
			packed: packedRange(domainWidth(p.domain)),
			name: tagPinPort(p.domain.name),
			comment: `Tag domain ${p.domain.name} — produced here (TagFromPin)`,
		});
	}
	if (kind === "decoder") {
		ports.push(
			{
				dir: "input",
				packed: packedRange(aw),
				name: "m_adr_i",
				comment: "Single master (flat; decoder mode)",
			},
			{ dir: "input", packed: "[31:0]", name: "m_dat_i" },
			{ dir: "input", packed: "[3:0]", name: "m_sel_i" },
			...plan.inherited.map((t) => ({
				dir: "input" as const,
				packed: packedRange(domainWidth(t.domain)),
				name: tagPort("m", t.domain.name),
			})),
		);
		ports.push(
			{ dir: "input", packed: "", name: "m_cyc_i" },
			{ dir: "input", packed: "", name: "m_stb_i" },
			{ dir: "input", packed: "", name: "m_we_i" },
			{ dir: "output", packed: "[31:0]", name: "m_dat_o" },
			{ dir: "output", packed: "", name: "m_ack_o" },
		);
	} else {
		for (const m of def.masters) {
			ports.push(...masterWbPorts(def, m.name, m.desc, aw));
		}
	}
	for (const s of dataSlaves(def)) {
		ports.push(...slaveWbPorts(s, aw, def));
	}
	return ports;
}

function slavePortBlock(s: WbSlave, aw: number, def: BusDef): string[] {
	const n = s.name;
	const adr = packedRange(aw).padEnd(7);
	const lines = [
		`\t// Slave ${n} — ${s.desc}`,
		`\t//   base=0x${hex(s.base)}${s.size !== undefined ? `  size=0x${hex(s.size)}` : ""}  mask=0x${hex(s.mask)}${s.pipe > 0 ? `  pipe=${s.pipe}` : ""}`,
		`\toutput logic ${adr}${wb(n, "i_wb_adr")},`,
		`\toutput logic [31:0] ${wb(n, "i_wb_dat")},`,
		`\toutput logic [3:0]  ${wb(n, "i_wb_sel")},`,
		...slaveTagPorts(s, def).map(
			(p) => `\toutput logic ${p.packed.padEnd(7)}${p.name},`,
		),
	];
	lines.push(
		`\toutput logic ${"".padEnd(7)}${wb(n, "i_wb_cyc")},`,
		`\toutput logic ${"".padEnd(7)}${wb(n, "i_wb_stb")},`,
		`\toutput logic ${"".padEnd(7)}${wb(n, "i_wb_we")},`,
		`\tinput  logic [31:0] ${wb(n, "o_wb_dat")},`,
		`\tinput  logic ${"".padEnd(7)}${wb(n, "o_wb_ack")}`,
	);
	return lines;
}

/** Master port block (interconnect): leaf-centric `{m}_o_wb_*` in / `{m}_i_wb_*` out. */
function masterPortBlock(
	name: string,
	desc: string,
	aw: number,
	pipe: number,
	def: BusDef,
): string[] {
	const adr = packedRange(aw).padEnd(7);
	const lines = [
		`\t// Master ${name} — ${desc}${pipe > 0 ? `  pipe=${pipe}` : ""}`,
		`\tinput  logic ${adr}${wb(name, "o_wb_adr")},`,
		`\tinput  logic [31:0] ${wb(name, "o_wb_dat")},`,
		`\tinput  logic [3:0]  ${wb(name, "o_wb_sel")},`,
		...tagPlan(def).inherited.map(
			(t) =>
				`\tinput  logic ${packedRange(domainWidth(t.domain)).padEnd(7)}${tagPort(wb(name, "o_wb"), t.domain.name)},`,
		),
	];
	lines.push(
		`\tinput  logic ${"".padEnd(7)}${wb(name, "o_wb_cyc")},`,
		`\tinput  logic ${"".padEnd(7)}${wb(name, "o_wb_stb")},`,
		`\tinput  logic ${"".padEnd(7)}${wb(name, "o_wb_we")},`,
		`\toutput logic [31:0] ${wb(name, "i_wb_dat")},`,
		`\toutput logic ${"".padEnd(7)}${wb(name, "i_wb_ack")}`,
	);
	return lines;
}

function formatAlignedPorts(blocks: string[][]): string[] {
	// Last port of last block has no trailing comma — strip commas then re-add.
	const flat: string[] = [];
	for (const [bi, block] of blocks.entries()) {
		for (const [li, line] of block.entries()) {
			const isLast = bi === blocks.length - 1 && li === block.length - 1;
			const trimmed = line.replace(/,\s*$/, "");
			flat.push(isLast ? trimmed : `${trimmed},`);
		}
	}
	return flat;
}

/** `assign <lhs> = t0 | t1 | …;` with aligned continuation lines. */
function pushOrAssign(out: string[], lhs: string, terms: string[]): void {
	const [first, ...rest] = terms;
	if (first === undefined) return;
	if (rest.length === 0) {
		out.push(`\tassign ${lhs} = ${first};`);
		return;
	}
	out.push(`\tassign ${lhs} = ${first}`);
	const cont = `\t${" ".repeat(`assign ${lhs} `.length)}`;
	for (const [i, t] of rest.entries()) {
		out.push(`${cont}| ${t}${i === rest.length - 1 ? ";" : ""}`);
	}
}

/**
 * Address used for decode / slave forwarding. The tag and every bit above it
 * are dropped, so only the low bits below the cut remain.
 */
function emitTagStrip(def: BusDef, gPrefix: string): string[] {
	const plan = tagPlan(def);
	if (plan.addrMask === 0) return [];
	const aw = def.addr_width;
	// Lowest tag bit. Decode keeps only bits strictly below it.
	let lo = 0;
	while (((plan.addrMask >>> lo) & 1) === 0) lo++;
	let keep = 0;
	for (let b = 0; b < lo; b++) keep = (keep | (1 << b)) >>> 0;
	return [
		`\tlogic ${packedRange(aw).padEnd(7)}${gPrefix}adr_dec;`,
		`\t// Tag and every bit above it are dropped (wishbone-bus.md 2.1)`,
		`\tassign ${gPrefix}adr_dec = ${gPrefix}adr & ${aw}'h${hex(keep, aw)};`,
		"",
	];
}

/** Decode-side address name: stripped copy when tags come from ADR. */
function decAdr(def: BusDef, gPrefix: string): string {
	return tagPlan(def).addrMask === 0 ? `${gPrefix}adr` : `${gPrefix}adr_dec`;
}

/** `g_tga_<domain>` driver for every domain on this fabric. */
function emitTagDrive(def: BusDef, gPrefix: string, adrExpr: string): string[] {
	return def.tags.map((t) => {
		const src =
			t.source === "uplink"
				? `${gPrefix}up_${t.domain.name}`
				: t.source === "pin"
					? tagPinPort(t.domain.name)
					: t.source === "addr" && t.addr_bits
						? `${adrExpr}[${t.addr_bits.replace(/\s/g, "")}]`
						: (t.reg_field ?? `${domainWidth(t.domain)}'d0`);
		return `\tassign ${gPrefix}tga_${t.domain.name} = ${src};`;
	});
}

function tagValue(gPrefix: string, tag: WbTagSource): string {
	return `${gPrefix}tga_${tag.domain.name}`;
}

function emitDecoderBody(def: BusDef): string[] {
	const aw = def.addr_width;
	const tw = tagDomainsWidth(def.tags);
	const inherited = tagPlan(def).inherited;
	const slaves = dataSlaves(def);
	const out: string[] = [];
	out.push(
		`\tlogic ${packedRange(aw).padEnd(7)}g_adr;`,
		"\tlogic [31:0] g_wdata;",
		"\tlogic [3:0]  g_sel;",
	);
	if (tw > 0) {
		for (const t of def.tags) {
			out.push(
				`\tlogic ${packedRange(domainWidth(t.domain)).padEnd(7)}${`g_tga_${t.domain.name}`};`,
			);
		}
	}
	for (const t of inherited) {
		out.push(
			`\tlogic ${packedRange(domainWidth(t.domain)).padEnd(7)}g_up_${t.domain.name};`,
		);
	}
	out.push(
		"\tlogic        g_cyc;",
		"\tlogic        g_stb;",
		"\tlogic        g_we;",
		"",
	);
	const m = def.masters[0];
	const piped = (m?.pipe ?? 0) > 0;
	if (piped && m) {
		out.push(
			...emitMasterPipe(m, 0, aw, tagPlan(def).inherited, "m", "m_adr_i"),
		);
		out.push(
			"\tassign g_adr   = m_adr_q;",
			"\tassign g_wdata = m_wdat_q;",
			"\tassign g_sel   = m_sel_q;",
		);
		// Unpack the pipe's packed TGA (declaration order, first domain = LSB).
		let lo = 0;
		for (const t of inherited) {
			const w = domainWidth(t.domain);
			const slice = w === 1 ? `m_tga_q[${lo}]` : `m_tga_q[${lo + w - 1}:${lo}]`;
			out.push(`\tassign g_up_${t.domain.name} = ${slice};`);
			lo += w;
		}
		out.push(...emitTagDrive(def, "g_", "m_adr_q"));
		out.push(
			"\tassign g_cyc   = m_cyc_q;",
			"\tassign g_stb   = m_stb_q;",
			"\tassign g_we    = m_we_q;",
			"",
		);
	} else {
		out.push(
			"\tassign g_adr   = m_adr_i;",
			"\tassign g_wdata = m_dat_i;",
			"\tassign g_sel   = m_sel_i;",
		);
		for (const t of inherited) {
			out.push(
				`\tassign g_up_${t.domain.name} = ${tagPort("m", t.domain.name)};`,
			);
		}
		out.push(...emitTagDrive(def, "g_", "m_adr_i"));
		out.push(
			"\tassign g_cyc   = m_cyc_i;",
			"\tassign g_stb   = m_stb_i;",
			"\tassign g_we    = m_we_i;",
			"",
		);
	}
	out.push(...emitTagStrip(def, "g_"));
	out.push(...emitDecodeAndSlaves(def, "g_"));
	out.push("", "\tlogic [31:0] rsp_dat;", "\tlogic        rsp_ack;", "");
	out.push(...emitResponseMux(slaves, "rsp_dat", "rsp_ack", "g_stb"));
	if (piped) {
		out.push(
			"\tassign m_rdat_q = rsp_dat;",
			"\tassign m_ack_q  = rsp_ack;",
			"\tassign m_dat_o  = m_prdat;",
			"\tassign m_ack_o  = m_pack;",
			"",
		);
	} else {
		out.push("\tassign m_dat_o = rsp_dat;", "\tassign m_ack_o = rsp_ack;", "");
	}
	const clkUsed = piped || slaves.some((s) => (s.pipe ?? 0) > 0);
	out.push(
		...emitUnusedSink("dec", [
			...(clkUsed ? [] : ["clk", "rst_n"]),
			...unconsumedTagTerms(def, def.slaves, "g_"),
		]),
	);
	return out;
}

type IndexedMaster = WbMaster & { readonly i: number };

/**
 * Request-side source of one master: the pipe queue net `m<i>_*_q` when the
 * master is piped, else its port.
 */
function masterSrc(m: IndexedMaster, q: string, port: string): string {
	return (m.pipe ?? 0) > 0 ? `m${m.i}_${q}_q` : wb(m.name, port);
}

/**
 * Inherited tag domain of one master. A piped master carries all inherited
 * domains packed in `m<i>_tga_q` (declaration order, first domain = LSB).
 */
function masterUpSrc(
	m: IndexedMaster,
	t: WbTagSource,
	inherited: readonly WbTagSource[],
): string {
	if ((m.pipe ?? 0) === 0) {
		return wb(m.name, tagPort("o_wb", t.domain.name));
	}
	let lo = 0;
	for (const d of inherited) {
		if (d === t) break;
		lo += domainWidth(d.domain);
	}
	const w = domainWidth(t.domain);
	return w === 1
		? `m${m.i}_tga_q[${lo}]`
		: `m${m.i}_tga_q[${lo + w - 1}:${lo}]`;
}

type ArbiterSpec = {
	/** Net prefix (`""` on the interconnect, `mg_<g>_` / `sg_<j>_` on a crossbar). */
	readonly prefix: string;
	/** Number of requesters. */
	readonly n: number;
	/** Request vector net (bit i = requester i), already declared by the caller. */
	readonly reqVec: string;
	/** Per-requester request expression used by the fixed-priority chain. */
	readonly reqTerm: (i: number) => string;
};

/** Arbiter state declarations (`grant`, `busy`, ...). */
function arbiterDecls(a: ArbiterSpec): string[] {
	const pk = `[${a.n - 1}:0]`;
	const p = a.prefix;
	return [
		`\tlogic ${pk} ${p}grant;`,
		`\tlogic ${"".padEnd(pk.length)} ${p}busy;`,
		`\tlogic ${pk} ${p}grant_nxt;`,
		`\tlogic ${pk} ${p}prio_gnt;`,
		`\tlogic ${pk} ${p}rr_hi_gnt;`,
		`\tlogic ${pk} ${p}last_gnt;`,
		`\tlogic ${pk} ${p}rr_mask;`,
		`\tlogic ${pk} ${p}rr_req_hi;`,
	];
}

/**
 * Locked arbiter: grant is taken while idle and held until the granted
 * request drops. `rb_grant_en` selects fixed priority (0) or round-robin (1).
 */
function arbiterLogic(a: ArbiterSpec): string[] {
	const { n, prefix: p } = a;
	const onehot = (i: number) =>
		`${n}'b${"0".repeat(n - 1 - i)}1${"0".repeat(i)}`;
	const zero = `${n}'b${"0".repeat(n)}`;
	const shiftFills: string[] = [];
	for (let s = 1; s < n; s <<= 1) {
		shiftFills.push(`\t\t${p}rr_mask = ${p}rr_mask | (${p}rr_mask >> ${s});`);
	}
	const out: string[] = [];
	const condPad = Math.max(
		...Array.from({ length: n }, (_, i) => `(${a.reqTerm(i)})`.length),
	);
	out.push("\talways_comb begin");
	for (let i = 0; i < n; i++) {
		const kw = i === 0 ? "if      " : "else if ";
		const cond = `(${a.reqTerm(i)})`.padEnd(condPad);
		out.push(`\t\t${kw}${cond} ${p}prio_gnt = ${onehot(i)};`);
	}
	out.push(
		`\t\t${"else".padEnd(`else if `.length + condPad + 1)}${p}prio_gnt = ${zero};`,
		"\tend",
		"",
		"\talways_comb begin",
		`\t\t${p}rr_mask = ${p}last_gnt;`,
		...shiftFills,
		"\tend",
		`\tassign ${p}rr_req_hi = ${a.reqVec} & ~${p}rr_mask;`,
		"",
		"\talways_comb begin",
	);
	for (let i = 0; i < n; i++) {
		const kw = i === 0 ? "if      " : "else if ";
		out.push(`\t\t${kw}(${p}rr_req_hi[${i}]) ${p}rr_hi_gnt = ${onehot(i)};`);
	}
	out.push(
		`\t\telse              ${p}rr_hi_gnt = ${zero};`,
		"\tend",
		"",
		`\tassign ${p}grant_nxt = (rb_grant_en && |${p}rr_req_hi) ? ${p}rr_hi_gnt : ${p}prio_gnt;`,
		"",
		"\talways_ff @(posedge clk or negedge rst_n) begin",
		"\t\tif (!rst_n) begin",
		`\t\t\t${p}busy     <= 1'b0;`,
		`\t\t\t${p}grant    <= ${n}'b0;`,
		`\t\t\t${p}last_gnt <= ${n}'b0;`,
		`\t\tend else if (!${p}busy) begin`,
		`\t\t\tif (|${a.reqVec}) begin`,
		`\t\t\t\t${p}busy     <= 1'b1;`,
		`\t\t\t\t${p}grant    <= ${p}grant_nxt;`,
		`\t\t\t\t${p}last_gnt <= ${p}grant_nxt;`,
		"\t\t\tend",
		`\t\tend else if (!(|(${a.reqVec} & ${p}grant))) begin`,
		`\t\t\t${p}busy <= 1'b0;`,
		"\t\tend",
		"\tend",
		"",
		`\tlogic [${n - 1}:0] ${p}gsel;`,
		`\tassign ${p}gsel = ${p}grant & {${n}{${p}busy}};`,
		"",
	);
	return out;
}

/** `{m_cyc, m_stb, m_we}` request vectors of a master set (bit k = masters[k]). */
function emitMasterVectors(
	out: string[],
	prefix: string,
	masters: readonly IndexedMaster[],
): void {
	for (const [sig, q, port] of [
		["m_cyc", "cyc", "o_wb_cyc"],
		["m_stb", "stb", "o_wb_stb"],
		["m_we ", "we", "o_wb_we"],
	] as const) {
		const msbFirst = [...masters].reverse().map((m) => masterSrc(m, q, port));
		out.push(`\tassign ${prefix}${sig} = {${msbFirst.join(", ")}};`);
	}
}

/** Declare the granted-request nets `<p>adr`, `<p>wdata`, ..., `<p>we`. */
function emitRequestDecls(
	out: string[],
	def: BusDef,
	p: string,
	withUp: boolean,
): void {
	const aw = def.addr_width;
	out.push(
		`\tlogic ${packedRange(aw).padEnd(7)}${p}adr;`,
		`\tlogic [31:0] ${p}wdata;`,
		`\tlogic [3:0]  ${p}sel;`,
	);
	if (withUp) {
		for (const t of tagPlan(def).inherited) {
			out.push(
				`\tlogic ${packedRange(domainWidth(t.domain)).padEnd(7)}${p}up_${t.domain.name};`,
			);
		}
	}
	for (const t of def.tags) {
		out.push(
			`\tlogic ${packedRange(domainWidth(t.domain)).padEnd(7)}${p}tga_${t.domain.name};`,
		);
	}
	out.push(
		`\tlogic        ${p}cyc;`,
		`\tlogic        ${p}stb;`,
		`\tlogic        ${p}we;`,
		"",
	);
}

/**
 * Mux the granted master of one arbiter onto `<p>adr` / `<p>wdata` / `<p>sel`
 * / `<p>up_<dom>`; `gsel` is the one-hot `<arb>gsel` vector, bit k = masters[k].
 */
function emitGrantedMux(
	out: string[],
	def: BusDef,
	p: string,
	gsel: string,
	masters: readonly IndexedMaster[],
): void {
	const aw = def.addr_width;
	const inherited = tagPlan(def).inherited;
	const muxVec = (lhs: string, src: (m: IndexedMaster) => string, w: number) =>
		pushOrAssign(
			out,
			lhs,
			masters.map((m, k) => `({${w}{${gsel}[${k}]}} & ${src(m)})`),
		);
	muxVec(`${p}adr  `, (m) => masterSrc(m, "adr", "o_wb_adr"), aw);
	muxVec(`${p}wdata`, (m) => masterSrc(m, "wdat", "o_wb_dat"), 32);
	muxVec(`${p}sel  `, (m) => masterSrc(m, "sel", "o_wb_sel"), 4);
	for (const t of inherited) {
		muxVec(
			`${p}up_${t.domain.name}`,
			(m) => masterUpSrc(m, t, inherited),
			domainWidth(t.domain),
		);
	}
}

function emitInterconnectBody(def: BusDef): string[] {
	const nm = def.masters.length;
	const aw = def.addr_width;
	const slaves = dataSlaves(def);
	const out: string[] = [];
	const masters: IndexedMaster[] = def.masters.map((m, i) => ({ ...m, i }));
	const pk = `[${nm - 1}:0]`;
	const piped = masters.some((m) => (m.pipe ?? 0) > 0);
	if (piped) {
		const inherited = tagPlan(def).inherited;
		out.push(
			"\t//------------------------------------------------------------------------------",
			"\t//  Master pipes (posted write / blocking read), in front of the arbiter",
			"\t//  The arbiter requests and holds its grant from each pipe's s_cyc",
			"\t//------------------------------------------------------------------------------",
		);
		for (const m of masters) {
			if ((m.pipe ?? 0) === 0) continue;
			out.push(...emitMasterPipe(m, m.i, aw, inherited));
		}
		out.push("");
	}
	const arb: ArbiterSpec = {
		prefix: "",
		n: nm,
		reqVec: "m_cyc",
		reqTerm: (i) => {
			const m = masters[i];
			return m ? masterSrc(m, "cyc", "o_wb_cyc") : "1'b0";
		},
	};
	out.push(
		"\t//------------------------------------------------------------------------------",
		"\t//  Arbitration: locked while grant holds CYC",
		"\t//  rb_grant_en=0: lowest master index wins (fixed)",
		"\t//  rb_grant_en=1: round-robin — next requester after last_gnt, wrap to lowest",
		"\t//------------------------------------------------------------------------------",
		...arbiterDecls(arb),
		`\tlogic ${pk} m_cyc;`,
		`\tlogic ${pk} m_stb;`,
		`\tlogic ${pk} m_we;`,
		"",
	);
	// Slot vectors (bit i = masters[i]); a piped master contributes its pipe s_*.
	emitMasterVectors(out, "", masters);
	out.push("");
	out.push(...arbiterLogic(arb));

	// Granted-request mux (master port arb): grant & replicate, OR-reduce.
	emitRequestDecls(out, def, "g_", true);
	emitGrantedMux(out, def, "g_", "gsel", masters);
	out.push(...emitTagDrive(def, "g_", "g_adr"));
	out.push(
		`\tassign g_cyc   = |(gsel & m_cyc);`,
		`\tassign g_stb   = |(gsel & m_stb);`,
		`\tassign g_we    = |(gsel & m_we);`,
		"",
	);

	out.push(...emitTagStrip(def, "g_"));
	out.push(...emitDecodeAndSlaves(def, "g_"));

	out.push("", "\tlogic [31:0] rsp_dat;", "\tlogic        rsp_ack;", "");
	out.push(...emitResponseMux(slaves, "rsp_dat", "rsp_ack", "g_stb"));

	out.push(
		"",
		"\t//------------------------------------------------------------------------------",
		"\t//  Master response: only the granted slot sees DAT/ACK",
		"\t//------------------------------------------------------------------------------",
	);
	const datPad = Math.max(...masters.map((m) => wb(m.name, "i_wb_dat").length));
	for (const m of masters) {
		const dat = wb(m.name, "i_wb_dat").padEnd(datPad);
		const ack = wb(m.name, "i_wb_ack").padEnd(datPad);
		if ((m.pipe ?? 0) > 0) {
			out.push(
				`\tassign m${m.i}_rdat_q = {32{gsel[${m.i}]}} & rsp_dat;`,
				`\tassign m${m.i}_ack_q  = gsel[${m.i}] & rsp_ack;`,
				`\tassign ${dat} = m${m.i}_prdat;`,
				`\tassign ${ack} = m${m.i}_pack;`,
			);
		} else {
			out.push(
				`\tassign ${dat} = {32{gsel[${m.i}]}} & rsp_dat;`,
				`\tassign ${ack} = gsel[${m.i}] & rsp_ack;`,
			);
		}
	}
	out.push(...emitUnusedSink("fab", unconsumedTagTerms(def, def.slaves, "g_")));
	out.push("");
	return out;
}

type MasterGroupView = {
	readonly name: string;
	readonly g: number;
	readonly prefix: string;
	readonly members: readonly IndexedMaster[];
};

type SlaveGroupView = {
	readonly name: string;
	readonly j: number;
	readonly prefix: string;
	readonly slaves: readonly WbSlave[];
};

function crossbarViews(def: BusDef): {
	mgs: MasterGroupView[];
	sgs: SlaveGroupView[];
} {
	const xb = def.crossbar;
	if (!xb) throw new Error(`wishbone-bus: ${def.name} is not a crossbar`);
	const masters: IndexedMaster[] = def.masters.map((m, i) => ({ ...m, i }));
	const mgs = xb.masters.map((grp, g) => ({
		name: grp.name,
		g,
		prefix: `mg_${grp.name}_`,
		members: grp.members.flatMap((n) => {
			const m = masters.find((x) => x.name === n);
			return m ? [m] : [];
		}),
	}));
	const sgs = xb.slaves.map((grp, j) => ({
		name: grp.name,
		j,
		prefix: `sg_${grp.name}_`,
		slaves: grp.members.flatMap((n) => {
			const s = def.slaves.find((x) => x.name === n);
			return s ? [s] : [];
		}),
	}));
	return { mgs, sgs };
}

/**
 * Crossbar (wishbone-bus.md 4.2). Two arbitration layers:
 *
 *   master group  mg_<g>_*  arbiter among its masters → one request,
 *                           decoded to a target slave group `mg_<g>_tgt`
 *   slave group   sg_<j>_*  arbiter among master groups → classic decode
 *                           over the group's own slaves
 *
 * A master group holds at most one slave group at a time and releases it
 * when CYC drops, so distinct (master group, slave group) pairs proceed in
 * parallel and no hold-and-wait cycle can form.
 */
function emitCrossbarBody(def: BusDef): string[] {
	const aw = def.addr_width;
	const plan = tagPlan(def);
	const inherited = plan.inherited;
	const { mgs, sgs } = crossbarViews(def);
	const ng = mgs.length;
	const nsg = sgs.length;
	const out: string[] = [];
	const masters: IndexedMaster[] = def.masters.map((m, i) => ({ ...m, i }));
	const bar =
		"\t//------------------------------------------------------------------------------";

	if (masters.some((m) => (m.pipe ?? 0) > 0)) {
		out.push(
			bar,
			"\t//  Master pipes (posted write / blocking read), in front of the arbiters",
			"\t//  Each arbiter requests and holds its grant from the pipe's s_cyc",
			bar,
		);
		for (const m of masters) {
			if ((m.pipe ?? 0) === 0) continue;
			out.push(...emitMasterPipe(m, m.i, aw, inherited));
		}
		out.push("");
	}

	// Slave-group slots: the master-side target decode indexes `mg_<g>_tgt` by SG_<NAME>.
	const sgPad = Math.max(...sgs.map((s) => groupLp(s.name).length));
	out.push(
		bar,
		"\t//  Slave groups: one decoder each; SG_<NAME> indexes the master-side target vector",
		bar,
	);
	for (const sg of sgs) {
		out.push(
			`\tlocalparam int unsigned ${groupLp(sg.name).padEnd(sgPad)} = ${sg.j};  // ${sg.slaves.map((s) => s.name).join(", ")}`,
		);
	}
	out.push("");

	//--------------------------------------------------------------------------
	//  Master groups
	//--------------------------------------------------------------------------
	for (const mg of mgs) {
		const p = mg.prefix;
		const nk = mg.members.length;
		out.push(
			bar,
			`\t//  Master group ${mg.name}: ${mg.members.map((m) => m.name).join(", ")}`,
			nk > 1
				? "\t//  Arbiter among members, locked while grant holds CYC (rb_grant_en: 0 fixed / 1 round-robin)"
				: "\t//  Single master: no arbiter",
			bar,
		);
		if (nk > 1) {
			const pk = `[${nk - 1}:0]`;
			const arb: ArbiterSpec = {
				prefix: p,
				n: nk,
				reqVec: `${p}m_cyc`,
				reqTerm: (k) => {
					const m = mg.members[k];
					return m ? masterSrc(m, "cyc", "o_wb_cyc") : "1'b0";
				},
			};
			out.push(
				...arbiterDecls(arb),
				`\tlogic ${pk} ${p}m_cyc;`,
				`\tlogic ${pk} ${p}m_stb;`,
				`\tlogic ${pk} ${p}m_we;`,
				"",
			);
			emitMasterVectors(out, p, mg.members);
			out.push("");
			out.push(...arbiterLogic(arb));
			emitRequestDecls(out, def, p, true);
			emitGrantedMux(out, def, p, `${p}gsel`, mg.members);
			out.push(...emitTagDrive(def, p, `${p}adr`));
			out.push(
				`\tassign ${p}cyc   = |(${p}gsel & ${p}m_cyc);`,
				`\tassign ${p}stb   = |(${p}gsel & ${p}m_stb);`,
				`\tassign ${p}we    = |(${p}gsel & ${p}m_we);`,
				"",
			);
		} else {
			const m = mg.members[0];
			if (!m) continue;
			emitRequestDecls(out, def, p, true);
			out.push(
				`\tassign ${p}adr   = ${masterSrc(m, "adr", "o_wb_adr")};`,
				`\tassign ${p}wdata = ${masterSrc(m, "wdat", "o_wb_dat")};`,
				`\tassign ${p}sel   = ${masterSrc(m, "sel", "o_wb_sel")};`,
			);
			for (const t of inherited) {
				out.push(
					`\tassign ${p}up_${t.domain.name} = ${masterUpSrc(m, t, inherited)};`,
				);
			}
			out.push(...emitTagDrive(def, p, `${p}adr`));
			out.push(
				`\tassign ${p}cyc   = ${masterSrc(m, "cyc", "o_wb_cyc")};`,
				`\tassign ${p}stb   = ${masterSrc(m, "stb", "o_wb_stb")};`,
				`\tassign ${p}we    = ${masterSrc(m, "we", "o_wb_we")};`,
				"",
			);
		}
		out.push(...emitTagStrip(def, p));
		// Target decode: which slave group owns the address (windows never overlap).
		const adr = decAdr(def, p);
		out.push(
			`\t// Target slave group of ${mg.name}; unmapped ACKs here without touching any group`,
			`\tlogic ${`[${nsg - 1}:0]`.padEnd(7)}${p}tgt;`,
			`\tlogic        ${p}unmapped;`,
			`\tlogic [31:0] ${p}rsp_dat;`,
			`\tlogic        ${p}rsp_ack;`,
			"",
			"\talways_comb begin",
			`\t\t${p}tgt      = ${nsg}'b0;`,
			`\t\t${p}unmapped = 1'b1;`,
		);
		for (let j = nsg - 1; j >= 0; j--) {
			const sg = sgs[j];
			if (!sg) continue;
			for (let k = sg.slaves.length - 1; k >= 0; k--) {
				const s = sg.slaves[k];
				if (!s) continue;
				out.push(
					`\t\tif ((${adr} & ${aw}'h${hex(s.mask, aw)}) == ${aw}'h${hex(s.base, aw)}) begin  // ${s.name}`,
					`\t\t\t${p}tgt      = ${nsg}'d1 << ${groupLp(sg.name)};`,
					`\t\t\t${p}unmapped = 1'b0;`,
					"\t\tend",
				);
			}
		}
		out.push("\tend", "");
	}

	//--------------------------------------------------------------------------
	//  Slave groups
	//--------------------------------------------------------------------------
	for (const sg of sgs) {
		const q = sg.prefix;
		const lp = groupLp(sg.name);
		const pk = `[${ng - 1}:0]`;
		out.push(
			bar,
			`\t//  Slave group ${sg.name}: ${sg.slaves.map((s) => s.name).join(", ")}`,
			ng > 1
				? "\t//  Arbiter among master groups, locked while the granted group targets this group"
				: "\t//  Single master group: no arbiter",
			bar,
			`\tlogic ${pk} ${q}req;`,
			`\tlogic ${pk} ${q}stb_v;`,
			`\tlogic ${pk} ${q}we_v;`,
		);
		const msbFirst = [...mgs].reverse();
		out.push(
			`\tassign ${q}req   = {${msbFirst.map((mg) => `${mg.prefix}cyc & ${mg.prefix}tgt[${lp}]`).join(", ")}};`,
			`\tassign ${q}stb_v = {${msbFirst.map((mg) => `${mg.prefix}stb & ${mg.prefix}tgt[${lp}]`).join(", ")}};`,
			`\tassign ${q}we_v  = {${msbFirst.map((mg) => `${mg.prefix}we`).join(", ")}};`,
			"",
		);
		if (ng > 1) {
			const arb: ArbiterSpec = {
				prefix: q,
				n: ng,
				reqVec: `${q}req`,
				reqTerm: (g) => `${q}req[${g}]`,
			};
			out.push(...arbiterDecls(arb), "");
			out.push(...arbiterLogic(arb));
		} else {
			out.push(`\tlogic [0:0] ${q}gsel;`, `\tassign ${q}gsel = ${q}req;`, "");
		}
		emitRequestDecls(out, def, q, false);
		const muxVec = (
			lhs: string,
			src: (mg: MasterGroupView) => string,
			w: number,
		) =>
			pushOrAssign(
				out,
				lhs,
				mgs.map((mg) => `({${w}{${q}gsel[${mg.g}]}} & ${src(mg)})`),
			);
		muxVec(`${q}adr  `, (mg) => `${mg.prefix}adr`, aw);
		muxVec(`${q}wdata`, (mg) => `${mg.prefix}wdata`, 32);
		muxVec(`${q}sel  `, (mg) => `${mg.prefix}sel`, 4);
		for (const t of def.tags) {
			muxVec(
				`${q}tga_${t.domain.name}`,
				(mg) => `${mg.prefix}tga_${t.domain.name}`,
				domainWidth(t.domain),
			);
		}
		out.push(
			`\tassign ${q}cyc   = |(${q}gsel & ${q}req);`,
			`\tassign ${q}stb   = |(${q}gsel & ${q}stb_v);`,
			`\tassign ${q}we    = |(${q}gsel & ${q}we_v);`,
			"",
		);
		out.push(...emitTagStrip(def, q));
		out.push(
			...emitDecodeAndSlaves(def, q, {
				slaves: sg.slaves,
				slotVec: `${q}slot_sel`,
				unmapped: `${q}unmapped`,
			}),
		);
		out.push(
			"",
			`\tlogic [31:0] ${q}rsp_dat;`,
			`\tlogic        ${q}rsp_ack;`,
			"",
		);
		out.push(
			...emitResponseMux(
				dataOf(sg.slaves),
				`${q}rsp_dat`,
				`${q}rsp_ack`,
				`${q}stb`,
				`${q}slot_sel`,
				`${q}unmapped`,
			),
		);
		out.push(
			...emitUnusedSink(`sg${sg.j}`, unconsumedTagTerms(def, sg.slaves, q)),
		);
		out.push("");
	}

	//--------------------------------------------------------------------------
	//  Responses
	//--------------------------------------------------------------------------
	out.push(
		bar,
		"\t//  Master group response: the slave group that granted this group, or the",
		"\t//  immediate unmapped ACK",
		bar,
	);
	for (const mg of mgs) {
		const p = mg.prefix;
		pushOrAssign(
			out,
			`${p}rsp_dat`,
			sgs.map(
				(sg) => `({32{${sg.prefix}gsel[${mg.g}]}} & ${sg.prefix}rsp_dat)`,
			),
		);
		pushOrAssign(out, `${p}rsp_ack`, [
			`(${p}unmapped & ${p}stb)`,
			...sgs.map((sg) => `(${sg.prefix}gsel[${mg.g}] & ${sg.prefix}rsp_ack)`),
		]);
	}
	out.push(
		"",
		bar,
		"\t//  Master response: only the granted member of a group sees DAT/ACK",
		bar,
	);
	const datPad = Math.max(...masters.map((m) => wb(m.name, "i_wb_dat").length));
	for (const mg of mgs) {
		const p = mg.prefix;
		const nk = mg.members.length;
		for (const [k, m] of mg.members.entries()) {
			const dat = wb(m.name, "i_wb_dat").padEnd(datPad);
			const ack = wb(m.name, "i_wb_ack").padEnd(datPad);
			const datSrc =
				nk > 1 ? `{32{${p}gsel[${k}]}} & ${p}rsp_dat` : `${p}rsp_dat`;
			const ackSrc = nk > 1 ? `${p}gsel[${k}] & ${p}rsp_ack` : `${p}rsp_ack`;
			if ((m.pipe ?? 0) > 0) {
				out.push(
					`\tassign m${m.i}_rdat_q = ${datSrc};`,
					`\tassign m${m.i}_ack_q  = ${ackSrc};`,
					`\tassign ${dat} = m${m.i}_prdat;`,
					`\tassign ${ack} = m${m.i}_pack;`,
				);
			} else {
				out.push(
					`\tassign ${dat} = ${datSrc};`,
					`\tassign ${ack} = ${ackSrc};`,
				);
			}
		}
	}
	const hasArbiter = mgs.some((mg) => mg.members.length > 1) || mgs.length > 1;
	const hasPipe =
		masters.some((m) => (m.pipe ?? 0) > 0) ||
		def.slaves.some((s) => (s.pipe ?? 0) > 0);
	const proto: string[] = [];
	if (!hasPipe && !hasArbiter) proto.push("clk", "rst_n");
	if (!hasArbiter) proto.push("rb_grant_en");
	out.push(...emitUnusedSink("xb", proto));
	out.push("");
	return out;
}

function emitDecodeAndSlaves(
	def: BusDef,
	gPrefix: string,
	scope: DecodeScope = wholeScope(def),
): string[] {
	const slaves = dataOf(scope.slaves);
	const ns = slaves.length;
	const aw = def.addr_width;
	const adr = decAdr(def, gPrefix);
	const out: string[] = [];
	const lpPad = Math.max(...slaves.map((s) => slotLp(s.name).length));
	out.push(
		"\t//------------------------------------------------------------------------------",
		"\t//  Address decode: lowest matching slave wins (mutually exclusive)",
		"\t//------------------------------------------------------------------------------",
	);
	for (let i = 0; i < ns; i++) {
		const s = slaves[i];
		if (s === undefined) continue;
		out.push(
			`\tlocalparam int unsigned ${slotLp(s.name).padEnd(lpPad)} = ${i};`,
		);
	}
	out.push(
		`\tlogic [${ns - 1}:0] ${scope.slotVec};`,
		`\tlogic        ${scope.unmapped};`,
		"",
		"\talways_comb begin",
		`\t\t${scope.slotVec} = ${ns}'b0;`,
		`\t\t${scope.unmapped} = 1'b1;`,
	);
	// High→low so the last write is the lowest index (priority).
	for (let i = ns - 1; i >= 0; i--) {
		const s = slaves[i];
		if (s === undefined) continue;
		out.push(
			`\t\tif ((${adr} & ${aw}'h${hex(s.mask, aw)}) == ${aw}'h${hex(s.base, aw)}) begin`,
			`\t\t\t${scope.slotVec} = ${ns}'d1 << ${slotLp(s.name)};`,
			`\t\t\t${scope.unmapped} = 1'b0;`,
			"\t\tend",
		);
	}
	out.push("\tend", "");
	for (const s of scope.slaves) {
		if (!s.broadcast) continue;
		out.push(
			`\t// Broadcast ${s.broadcast}: no WB data port; writes fan out, reads OR subscriber DAT`,
			`\tlogic broadcast_${s.broadcast};`,
			`\tassign broadcast_${s.broadcast} = (${adr} & ${aw}'h${hex(s.mask, aw)}) == ${aw}'h${hex(s.base, aw)};`,
			`\t// Window offset shared by every ${s.broadcast} subscriber`,
			`\tlogic ${packedRange(aw)} ${s.broadcast}_off;`,
			`\tassign ${s.broadcast}_off = ${adr} - ${aw}'h${hex(s.base, aw)};`,
			"",
		);
	}

	out.push(
		"\t//------------------------------------------------------------------------------",
		"\t//  Named slave drive (window offset ADR)",
		"\t//------------------------------------------------------------------------------",
	);
	const combo = slaves.filter((s) => (s.pipe ?? 0) === 0);
	const namePad =
		combo.length > 0
			? Math.max(...combo.map((s) => wb(s.name, "i_wb_adr").length))
			: 0;
	const slotPad = Math.max(
		...slaves.map((s) => slotSel(s.name, scope.slotVec).length),
	);
	for (let i = 0; i < ns; i++) {
		const s = slaves[i];
		if (s === undefined) continue;
		if ((s.pipe ?? 0) > 0) {
			out.push(...emitSlavePipe(s, aw, gPrefix, adr, def, scope.slotVec));
		} else {
			out.push(
				...emitSlaveCombo(
					s,
					aw,
					gPrefix,
					namePad,
					slotPad,
					adr,
					def,
					scope.slotVec,
				),
			);
		}
		if (i < ns - 1) out.push("");
	}
	return out;
}

function emitSlaveCombo(
	s: WbSlave,
	aw: number,
	gPrefix: string,
	namePad: number,
	slotPad: number,
	adr: string,
	def: BusDef,
	slotVec: string,
): string[] {
	const n = s.name;
	const port = (stem: string) => wb(n, stem).padEnd(namePad);
	const slot = slotSel(n, slotVec).padEnd(slotPad);
	const bcast = (s.broadcastBy ?? []).filter((name) =>
		def.slaves.some((src) => src.broadcast === name),
	);
	const hit =
		bcast.length > 0
			? `(${slot.trim()} || ${bcast.map((name) => `broadcast_${name}`).join(" || ")})`
			: slot.trim();
	const offset =
		bcast.length === 0
			? adr
			: [
					`({${aw}{${slot.trim()}}} & ${adr})`,
					...bcast.map((name) => {
						const src = def.slaves.find((item) => item.broadcast === name);
						return src ? `({${aw}{broadcast_${name}}} & ${name}_off)` : "";
					}),
				]
					.filter((term) => term !== "")
					.join(" | ");
	const masked = bcast.length === 0 ? offset : ["(", offset, ")"].join("");
	const out = [
		`\tassign ${port("i_wb_adr")} = ${hit} ? ${masked} & ~${aw}'h${hex(s.mask, aw)} : ${aw}'d0;`,
		`\tassign ${port("i_wb_dat")} = ${gPrefix}wdata;`,
		`\tassign ${port("i_wb_sel")} = ${gPrefix}sel;`,
	];
	for (const p of slaveTagPorts(s, def)) {
		const domain = p.name.slice(p.name.lastIndexOf("_tga_") + 5);
		out.push(`\tassign ${p.name.padEnd(namePad)} = ${gPrefix}tga_${domain};`);
	}
	out.push(
		`\tassign ${port("i_wb_cyc")} = ${hit} & ${gPrefix}cyc;`,
		`\tassign ${port("i_wb_stb")} = ${hit} & ${gPrefix}stb;`,
		`\tassign ${port("i_wb_we ")} = ${gPrefix}we;`,
	);
	return out;
}

/**
 * `wb_cfg_pipe` between a master port and the arbiter (or, on a decoder,
 * between the flat `m_*` port and address decode). The arbiter must request
 * and hold its grant from the pipe `s_cyc`: a posted write drops the port
 * `CYC` while the beat is still queued.
 *
 * `idx` names the queue nets `m<idx>_*`. The decoder passes `idxName = "m"`
 * so the nets are `m_*` and the flat `m_*_i` ports feed the pipe.
 */
function emitMasterPipe(
	m: WbMaster & { i?: number },
	idx: number,
	aw: number,
	tags: readonly WbTagSource[],
	idxName?: string,
	adrPort?: string,
): string[] {
	const p = idxName ?? `m${idx}`;
	const pin = (stem: string) =>
		idxName ? `${idxName}_${stem}` : wb(m.name, stem);
	// Decoder master tags are flat `m_tga_<domain>`; interconnect masters are
	// `<m>_o_wb_tga_<domain>`.
	const tw = tagDomainsWidth(tags);
	// Callers pass pipe>0 only. A combo master keeps its port names; declaring
	// m<i>_*_q for it leaves nets that nothing reads.
	if ((m.pipe ?? 0) === 0) return [];
	const nc = `u_${m.name}_mpipe_tga_nc`;
	const out: string[] = [
		`\tlogic ${packedRange(aw).padEnd(7)}${p}_adr_q;`,
		`\tlogic [31:0] ${p}_wdat_q;`,
		`\tlogic [3:0]  ${p}_sel_q;`,
	];
	if (tw > 0) {
		out.push(`\tlogic ${packedRange(tw).padEnd(7)}${p}_tga_q;`);
	}
	out.push(
		`\tlogic        ${p}_cyc_q;`,
		`\tlogic        ${p}_stb_q;`,
		`\tlogic        ${p}_we_q;`,
		`\tlogic [31:0] ${p}_rdat_q;`,
		`\tlogic        ${p}_ack_q;`,
	);
	if (tw === 0) out.push(`\tlogic        ${nc};`);
	out.push(
		`\tlogic [31:0] ${p}_prdat;`,
		`\tlogic        ${p}_pack;`,
		`\twb_cfg_pipe #(.PIPE(${m.pipe ?? 0}), .AW(${aw}), .TW(${tw > 0 ? tw : 1})) u_${m.name}_mpipe (`,
		"\t\t.clk(clk),",
		"\t\t.rst_n(rst_n),",
		`\t\t.m_cyc(${pin(idxName ? "cyc_i" : "o_wb_cyc")}),`,
		`\t\t.m_stb(${pin(idxName ? "stb_i" : "o_wb_stb")}),`,
		`\t\t.m_we(${pin(idxName ? "we_i" : "o_wb_we")}),`,
		`\t\t.m_adr(${adrPort ?? pin("o_wb_adr")}),`,
		`\t\t.m_dat(${pin(idxName ? "dat_i" : "o_wb_dat")}),`,
		`\t\t.m_sel(${pin(idxName ? "sel_i" : "o_wb_sel")}),`,
	);
	out.push(
		tw > 0
			? `\t\t.m_tga(${packedTagExpr(tags, (t) => tagPort(idxName ?? pin("o_wb"), t.domain.name))}),`
			: "\t\t.m_tga(1'b0),",
		`\t\t.m_ack(${p}_pack),`,
		`\t\t.m_rdat(${p}_prdat),`,
		`\t\t.s_cyc(${p}_cyc_q),`,
		`\t\t.s_stb(${p}_stb_q),`,
		`\t\t.s_we(${p}_we_q),`,
		`\t\t.s_adr(${p}_adr_q),`,
		`\t\t.s_dat(${p}_wdat_q),`,
		`\t\t.s_sel(${p}_sel_q),`,
	);
	out.push(
		tw > 0 ? `\t\t.s_tga(${p}_tga_q),` : `\t\t.s_tga(${nc}),`,
		`\t\t.s_ack(${p}_ack_q),`,
		`\t\t.s_rdat(${p}_rdat_q)`,
		"\t);",
	);
	if (tw === 0) out.push(...emitUnusedSink(nc, [nc]));
	return out;
}

/** Instantiate wb_cfg_pipe. TW=0 still ties the dummy TGA ports. */
function emitSlavePipe(
	s: WbSlave,
	aw: number,
	gPrefix: string,
	adr: string,
	def: BusDef,
	slotVec: string,
): string[] {
	const n = s.name;
	const pipe = s.pipe;
	const tags = slaveTagPorts(s, def);
	const st = tagDomainsWidth(
		def.tags.filter((t) =>
			tags.some((p) => p.name.endsWith(`_tga_${t.domain.name}`)),
		),
	);
	const slot = slotSel(n, slotVec);
	const bcast = (s.broadcastBy ?? []).filter((name) =>
		def.slaves.some((src) => src.broadcast === name),
	);
	const hit =
		bcast.length > 0
			? `(${slot} || ${bcast.map((name) => `broadcast_${name}`).join(" || ")})`
			: slot;
	const offset =
		bcast.length === 0
			? adr
			: [
					`({${aw}{${slot}}} & ${adr})`,
					...bcast.map((name) => {
						const src = def.slaves.find((item) => item.broadcast === name);
						return src ? `({${aw}{broadcast_${name}}} & ${name}_off)` : "";
					}),
				]
					.filter((term) => term !== "")
					.join(" | ");
	const masked = bcast.length === 0 ? offset : ["(", offset, ")"].join("");
	const winAdr = `${hit} ? ${masked} & ~${aw}'h${hex(s.mask, aw)} : ${aw}'d0`;
	const ack = `${n}_pipe_ack`;
	const rdat = `${n}_pipe_rdat`;
	const nc = `u_${n}_pipe_tga_nc`;
	const out: string[] = [
		"\t//------------------------------------------------------------------------------",
		`\t//  Slave ${n} — wb_cfg_pipe PIPE=${pipe} (posted write / blocking read)`,
		"\t//------------------------------------------------------------------------------",
		`\tlogic        ${ack};`,
		`\tlogic [31:0] ${rdat};`,
		...(st === 0 ? [`\tlogic        ${nc};`] : []),
		`\twb_cfg_pipe #(.PIPE(${pipe}), .AW(${aw}), .TW(${st > 0 ? st : 1})) u_${n}_pipe (`,
		"\t\t.clk(clk),",
		"\t\t.rst_n(rst_n),",
		`\t\t.m_cyc(${hit} & ${gPrefix}cyc),`,
		`\t\t.m_stb(${hit} & ${gPrefix}stb),`,
		`\t\t.m_we(${gPrefix}we),`,
		`\t\t.m_adr(${winAdr}),`,
		`\t\t.m_dat(${gPrefix}wdata),`,
		`\t\t.m_sel(${gPrefix}sel),`,
	];
	const slaveTags = def.tags.filter((t) =>
		tags.some((p) => p.name.endsWith(`_tga_${t.domain.name}`)),
	);
	out.push(
		st > 0
			? `\t\t.m_tga(${packedTagExpr(slaveTags, (t) => tagValue(gPrefix, t))}),`
			: "\t\t.m_tga(1'b0),",
	);
	out.push(
		`\t\t.m_ack(${ack}),`,
		`\t\t.m_rdat(${rdat}),`,
		`\t\t.s_cyc(${wb(n, "i_wb_cyc")}),`,
		`\t\t.s_stb(${wb(n, "i_wb_stb")}),`,
		`\t\t.s_we(${wb(n, "i_wb_we")}),`,
		`\t\t.s_adr(${wb(n, "i_wb_adr")}),`,
		`\t\t.s_dat(${wb(n, "i_wb_dat")}),`,
		`\t\t.s_sel(${wb(n, "i_wb_sel")}),`,
	);
	out.push(
		st > 0
			? `\t\t.s_tga(${packedTagExpr(slaveTags, (t) => tagPort(wb(n, "i_wb"), t.domain.name))}),`
			: `\t\t.s_tga(${nc}),`,
		`\t\t.s_ack(${wb(n, "o_wb_ack")}),`,
		`\t\t.s_rdat(${wb(n, "o_wb_dat")})`,
		"\t);",
	);
	if (st === 0) out.push(...emitUnusedSink(nc, [nc]));
	return out;
}

/** Response OR-reduction (slot_sel is one-hot; unmapped ACKs immediately). */
function emitResponseMux(
	slaves: readonly WbSlave[],
	dat: string,
	ack: string,
	stb: string,
	slotVec = "slot_sel",
	unmapped = "unmapped",
): string[] {
	const out: string[] = [];
	const groups = new Map<string, WbSlave[]>();
	for (const s of slaves) {
		for (const name of s.broadcastBy ?? []) {
			const list = groups.get(name) ?? [];
			list.push(s);
			groups.set(name, list);
		}
	}
	const datTerms = slaves.map((s) =>
		(s.pipe ?? 0) > 0
			? `({32{${slotSel(s.name, slotVec)}}} & ${s.name}_pipe_rdat)`
			: `({32{${slotSel(s.name, slotVec)}}} & ${wb(s.name, "o_wb_dat")})`,
	);
	// Broadcast read: OR every subscriber's read data (any-1 status readback).
	for (const [name, members] of groups) {
		const terms = members.map((s) =>
			(s.pipe ?? 0) > 0 ? `${s.name}_pipe_rdat` : wb(s.name, "o_wb_dat"),
		);
		datTerms.push(`({32{broadcast_${name}}} & (${terms.join(" | ")}))`);
	}
	pushOrAssign(out, dat, datTerms);
	const broadcastAcks = [...groups.entries()].map(([name, members]) => {
		const terms = members.map((s) =>
			(s.pipe ?? 0) > 0 ? `${s.name}_pipe_ack` : wb(s.name, "o_wb_ack"),
		);
		return `(broadcast_${name} & ${terms.join(" & ")})`;
	});
	// A broadcast window hit is not "unmapped": its ACK is the subscriber AND.
	const bcastAny = [...groups.keys()].map((name) => `broadcast_${name}`);
	pushOrAssign(out, ack, [
		bcastAny.length > 0
			? `(${unmapped} & ${stb} & !(${bcastAny.join(" | ")}))`
			: `(${unmapped} & ${stb})`,
		...broadcastAcks,
		...slaves.map((s) =>
			(s.pipe ?? 0) > 0
				? `(${slotSel(s.name, slotVec)} & ${s.name}_pipe_ack)`
				: `(${slotSel(s.name, slotVec)} & ${wb(s.name, "o_wb_ack")})`,
		),
	]);
	return out;
}

export function emitBusSv(def: BusDef): string {
	const kind = busModuleKind(def);
	const mod = busModuleName(def);
	const aw = def.addr_width;
	const nm = def.masters.length;
	const tw = def.tag_width;
	const lines: string[] = [];
	lines.push(
		`// Generated by autowire plugin wishbone (${kind} ${def.name}). Do not edit.`,
		"//",
		"//------------------------------------------------------------------------------",
		`//  Module: ${mod}`,
		`//  Desc:   ${def.desc}`,
		`//  Masters: ${nm} (${kind === "decoder" ? "decoder-only; no arbiter" : "arbiter: rb_grant_en=0 fixed / 1 round-robin"})`,
		`//  Slaves:  ${dataSlaves(def).length} (named {slave}_i_wb_* / {slave}_o_wb_*)`,
	);
	if (def.crossbar) {
		const xb = def.crossbar;
		lines.push(
			`//  Crossbar: ${xb.masters.length} master group(s) x ${xb.slaves.length} slave group(s); groups run in parallel`,
		);
		for (const g of xb.masters) {
			lines.push(`//    master group ${g.name}: ${g.members.join(", ")}`);
		}
		for (const g of xb.slaves) {
			lines.push(`//    slave group  ${g.name}: ${g.members.join(", ")}`);
		}
	}
	if (tw > 0) {
		const src = def.tags
			.filter((t) => t.source !== "uplink")
			.map((t) => `${t.domain.name}<-${t.source}`);
		lines.push(
			`//  Tag:     TGA ${tw} bit${src.length > 0 ? ` (produced here: ${src.join(", ")})` : " (forwarded, not interpreted)"}`,
		);
	}
	if (def.slaves.some((s) => (s.pipe ?? 0) > 0)) {
		lines.push(
			"//  Slave PIPE: wb_cfg_pipe per port (posted write / blocking read)",
		);
	}
	if (def.masters.some((m) => (m.pipe ?? 0) > 0)) {
		lines.push(
			"//  Master PIPE: wb_cfg_pipe in front of the arbiter (s_cyc holds the grant)",
		);
	}
	lines.push(
		"//------------------------------------------------------------------------------",
		"//  Address map:",
	);
	for (const s of def.slaves) {
		const pipeNote = (s.pipe ?? 0) > 0 ? `  pipe=${s.pipe}` : "";
		lines.push(
			`//    0x${hex(s.base)}${s.size !== undefined ? `  size=0x${hex(s.size)}` : ""}  mask=0x${hex(s.mask)}  ${s.name} — ${s.desc}${pipeNote}`,
		);
	}
	lines.push(
		"//------------------------------------------------------------------------------",
		"",
	);
	lines.push(`module ${mod} (`);
	lines.push("\tinput  logic        clk,");
	lines.push("\tinput  logic        rst_n,");
	if (kind !== "decoder") {
		lines.push("\tinput  logic        rb_grant_en,");
	}

	const portBlocks: string[][] = [];
	const plan = tagPlan(def);
	if (plan.pins.length > 0) {
		portBlocks.push(
			plan.pins.map(
				(p) =>
					`\tinput  logic ${packedRange(domainWidth(p.domain))} ${tagPinPort(p.domain.name)}`,
			),
		);
	}
	if (kind === "decoder") {
		const block = [
			"\t// Single master (flat; decoder mode)",
			`\tinput  logic ${packedRange(aw) ? `${packedRange(aw)} ` : ""}m_adr_i`,
			"\tinput  logic [31:0] m_dat_i",
			"\tinput  logic [3:0]  m_sel_i",
			...plan.inherited.map(
				(t) =>
					`\tinput  logic ${packedRange(domainWidth(t.domain))} ${tagPort("m", t.domain.name)}`,
			),
		];
		block.push(
			"\tinput  logic        m_cyc_i",
			"\tinput  logic        m_stb_i",
			"\tinput  logic        m_we_i",
			"\toutput logic [31:0] m_dat_o",
			"\toutput logic        m_ack_o",
		);
		portBlocks.push(block);
	} else {
		for (const m of def.masters) {
			portBlocks.push(masterPortBlock(m.name, m.desc, aw, m.pipe ?? 0, def));
		}
	}
	for (const s of dataSlaves(def)) {
		portBlocks.push(slavePortBlock(s, aw, def));
	}
	lines.push(...formatAlignedPorts(portBlocks));
	lines.push(");", "");

	if (kind === "decoder") {
		lines.push(...emitDecoderBody(def));
	} else if (kind === "crossbar") {
		lines.push(...emitCrossbarBody(def));
	} else {
		lines.push(...emitInterconnectBody(def));
	}
	lines.push("endmodule", "");
	return lines.join("\n");
}
