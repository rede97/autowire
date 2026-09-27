// Emit SystemVerilog for wishbone-bus decoder / interconnect.
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
	return def.slaves.filter((s) => !s.broadcast);
}

function slotLp(name: string): string {
	return `SLOT_${name.toUpperCase()}`;
}

function slotSel(name: string): string {
	return `slot_sel[${slotLp(name)}]`;
}

/** Module basename: decoder if NM<=1, else interconnect. */
export function busModuleKind(def: BusDef): "decoder" | "interconnect" {
	return def.masters.length <= 1 ? "decoder" : "interconnect";
}

export function busModuleName(def: BusDef): string {
	return `${def.name.toLowerCase()}_${busModuleKind(def)}`;
}

/** Type-A wrapper that instantiates the fabric + attached regfile leaves. */
export function busSystemModuleName(def: BusDef): string {
	return `${def.name.toLowerCase()}_system`;
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
	if (kind === "interconnect") {
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
 * Address actually used for decode / slave forwarding. `TagFromAddr` bits are
 * carved out here, so one window declaration covers every tag alias.
 */
function emitTagStrip(def: BusDef, gPrefix: string): string[] {
	const plan = tagPlan(def);
	if (plan.addrMask === 0) return [];
	const aw = def.addr_width;
	return [
		`\tlogic ${packedRange(aw).padEnd(7)}${gPrefix}adr_dec;`,
		`\t// Tag address bits are not part of slave addressing (wishbone-bus.md 2.1)`,
		`\tassign ${gPrefix}adr_dec = ${gPrefix}adr & ~${aw}'h${hex(plan.addrMask, aw)};`,
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
	const slaves = dataSlaves(def);
	const out: string[] = [];
	if (tw > 0) {
		for (const t of def.tags) {
			out.push(
				`\tlogic ${packedRange(domainWidth(t.domain)).padEnd(7)}${`g_tga_${t.domain.name}`};`,
			);
		}
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
	return out;
}

function emitInterconnectBody(def: BusDef): string[] {
	const nm = def.masters.length;
	const aw = def.addr_width;
	const slaves = dataSlaves(def);
	const out: string[] = [];
	const masters = def.masters.map((m, i) => ({ ...m, i }));
	const onehot = (i: number) =>
		`${nm}'b${"0".repeat(nm - 1 - i)}1${"0".repeat(i)}`;

	const pk = `[${nm - 1}:0]`;
	const shiftFills: string[] = [];
	for (let s = 1; s < nm; s <<= 1) {
		shiftFills.push(`\t\trr_mask = rr_mask | (rr_mask >> ${s});`);
	}
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
			out.push(...emitMasterPipe(m, m.i, aw, inherited));
		}
		out.push("");
	}
	out.push(
		"\t//------------------------------------------------------------------------------",
		"\t//  Arbitration: locked while grant holds CYC",
		"\t//  rb_grant_en=0: lowest master index wins (fixed)",
		"\t//  rb_grant_en=1: round-robin — next requester after last_gnt, wrap to lowest",
		"\t//------------------------------------------------------------------------------",
		`\tlogic ${pk} grant;`,
		`\tlogic ${"".padEnd(pk.length)} busy;`,
		`\tlogic ${pk} grant_nxt;`,
		`\tlogic ${pk} prio_gnt;`,
		`\tlogic ${pk} rr_hi_gnt;`,
		`\tlogic ${pk} last_gnt;`,
		`\tlogic ${pk} rr_mask;`,
		`\tlogic ${pk} rr_req_hi;`,
		`\tlogic ${pk} m_cyc;`,
		`\tlogic ${pk} m_stb;`,
		`\tlogic ${pk} m_we;`,
		"",
	);
	// Slot vectors (bit i = masters[i]); a piped master contributes its pipe s_*.
	const reqBit = (
		m: (typeof masters)[number],
		q: string,
		port: string,
	): string => ((m.pipe ?? 0) > 0 ? `m${m.i}_${q}_q` : wb(m.name, port));
	for (const [sig, q, port] of [
		["m_cyc", "cyc", "o_wb_cyc"],
		["m_stb", "stb", "o_wb_stb"],
		["m_we ", "we", "o_wb_we"],
	] as const) {
		const msbFirst = [...masters].reverse().map((m) => reqBit(m, q, port));
		out.push(`\tassign ${sig} = {${msbFirst.join(", ")}};`);
	}
	const condPad = Math.max(
		...masters.map((m) => `(${reqBit(m, "cyc", "o_wb_cyc")})`.length),
	);
	out.push("", "\talways_comb begin");
	for (const m of masters) {
		const kw = m.i === 0 ? "if      " : "else if ";
		const cond = `(${reqBit(m, "cyc", "o_wb_cyc")})`.padEnd(condPad);
		out.push(`\t\t${kw}${cond} prio_gnt = ${onehot(m.i)};`);
	}
	out.push(
		`\t\t${"else".padEnd(`else if `.length + condPad + 1)}prio_gnt = ${nm}'b${"0".repeat(nm)};`,
		"\tend",
		"",
		"\talways_comb begin",
		"\t\trr_mask = last_gnt;",
		...shiftFills,
		"\tend",
		`\tassign rr_req_hi = m_cyc & ~rr_mask;`,
		"",
		"\talways_comb begin",
	);
	for (const m of masters) {
		const kw = m.i === 0 ? "if      " : "else if ";
		out.push(`\t\t${kw}(rr_req_hi[${m.i}]) rr_hi_gnt = ${onehot(m.i)};`);
	}
	out.push(
		`\t\telse              rr_hi_gnt = ${nm}'b${"0".repeat(nm)};`,
		"\tend",
		"",
		"\tassign grant_nxt = (rb_grant_en && |rr_req_hi) ? rr_hi_gnt : prio_gnt;",
		"",
		"\talways_ff @(posedge clk or negedge rst_n) begin",
		"\t\tif (!rst_n) begin",
		"\t\t\tbusy     <= 1'b0;",
		`\t\t\tgrant    <= ${nm}'b0;`,
		`\t\t\tlast_gnt <= ${nm}'b0;`,
		"\t\tend else if (!busy) begin",
		"\t\t\tif (|m_cyc) begin",
		"\t\t\t\tbusy     <= 1'b1;",
		"\t\t\t\tgrant    <= grant_nxt;",
		"\t\t\t\tlast_gnt <= grant_nxt;",
		"\t\t\tend",
		"\t\tend else if (!(|(m_cyc & grant))) begin",
		"\t\t\tbusy <= 1'b0;",
		"\t\tend",
		"\tend",
		"",
	);

	// Granted-request mux (master port arb): grant & replicate, OR-reduce.
	out.push(
		`\tlogic [${nm - 1}:0] gsel;`,
		`\tassign gsel = grant & {${nm}{busy}};`,
		"",
		`\tlogic ${packedRange(aw).padEnd(7)}g_adr;`,
		"\tlogic [31:0] g_wdata;",
		"\tlogic [3:0]  g_sel;",
	);
	const plan = tagPlan(def);
	for (const t of plan.inherited) {
		out.push(
			`\tlogic ${packedRange(domainWidth(t.domain)).padEnd(7)}g_up_${t.domain.name};`,
		);
	}
	for (const t of def.tags) {
		out.push(
			`\tlogic ${packedRange(domainWidth(t.domain)).padEnd(7)}g_tga_${t.domain.name};`,
		);
	}
	out.push(
		"\tlogic        g_cyc;",
		"\tlogic        g_stb;",
		"\tlogic        g_we;",
		"",
	);

	const muxSrc = (
		m: (typeof masters)[number],
		q: string,
		port: string,
	): string => ((m.pipe ?? 0) > 0 ? `m${m.i}_${q}_q` : wb(m.name, port));
	const muxVec = (lhs: string, q: string, port: string, width: number) =>
		pushOrAssign(
			out,
			lhs,
			masters.map((m) => `({${width}{gsel[${m.i}]}} & ${muxSrc(m, q, port)})`),
		);
	muxVec("g_adr  ", "adr", "o_wb_adr", aw);
	muxVec("g_wdata", "wdat", "o_wb_dat", 32);
	muxVec("g_sel  ", "sel", "o_wb_sel", 4);
	for (const t of plan.inherited) {
		muxVec(
			`g_up_${t.domain.name}`,
			`tga_${t.domain.name}`,
			tagPort("o_wb", t.domain.name),
			domainWidth(t.domain),
		);
	}
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
	out.push("");
	return out;
}

function emitDecodeAndSlaves(def: BusDef, gPrefix: string): string[] {
	const slaves = dataSlaves(def);
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
		`\tlogic [${ns - 1}:0] slot_sel;`,
		"\tlogic        unmapped;",
		"",
		"\talways_comb begin",
		`\t\tslot_sel = ${ns}'b0;`,
		"\t\tunmapped = 1'b1;",
	);
	// High→low so the last write is the lowest index (priority).
	for (let i = ns - 1; i >= 0; i--) {
		const s = slaves[i];
		if (s === undefined) continue;
		out.push(
			`\t\tif ((${adr} & ${aw}'h${hex(s.mask, aw)}) == ${aw}'h${hex(s.base, aw)}) begin`,
			`\t\t\tslot_sel = ${ns}'d1 << ${slotLp(s.name)};`,
			"\t\t\tunmapped = 1'b0;",
			"\t\tend",
		);
	}
	out.push("\tend", "");
	for (const s of def.slaves) {
		if (!s.broadcast) continue;
		out.push(
			`\t// Broadcast ${s.broadcast}: write-only strobe, no WB data port`,
			`\tlogic broadcast_${s.broadcast};`,
			`\tassign broadcast_${s.broadcast} = ${gPrefix}we && (${adr} & ${aw}'h${hex(s.mask, aw)}) == ${aw}'h${hex(s.base, aw)};`,
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
	const slotPad = Math.max(...slaves.map((s) => slotSel(s.name).length));
	for (let i = 0; i < ns; i++) {
		const s = slaves[i];
		if (s === undefined) continue;
		if ((s.pipe ?? 0) > 0) {
			out.push(...emitSlavePipe(s, aw, gPrefix, adr, def));
		} else {
			out.push(...emitSlaveCombo(s, aw, gPrefix, namePad, slotPad, adr, def));
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
): string[] {
	const n = s.name;
	const port = (stem: string) => wb(n, stem).padEnd(namePad);
	const slot = slotSel(n).padEnd(slotPad);
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
						return src
							? `({${aw}{broadcast_${name}}} & (${adr} - ${aw}'h${hex(src.base, aw)}))`
							: "";
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
	const tw = tagDomainsWidth(tags);
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
	if ((m.pipe ?? 0) === 0) {
		out.push(
			`\tassign ${p}_adr_q  = ${adrPort ?? pin("o_wb_adr")};`,
			`\tassign ${p}_wdat_q = ${pin(idxName ? "dat_i" : "o_wb_dat")};`,
			`\tassign ${p}_sel_q  = ${pin(idxName ? "sel_i" : "o_wb_sel")};`,
		);
		if (tw > 0) {
			out.push(
				`\tassign ${p}_tga_q  = ${packedTagExpr(tags, (t) =>
					tagPort(pin("o_wb"), t.domain.name),
				)};`,
			);
		}
		out.push(
			`\tassign ${p}_cyc_q  = ${pin(idxName ? "cyc_i" : "o_wb_cyc")};`,
			`\tassign ${p}_stb_q  = ${pin(idxName ? "stb_i" : "o_wb_stb")};`,
			`\tassign ${p}_we_q   = ${pin(idxName ? "we_i" : "o_wb_we")};`,
		);
		return out;
	}
	out.push(
		`\tlogic [31:0] ${p}_prdat;`,
		`\tlogic        ${p}_pack;`,
		`\twb_cfg_pipe #(.PIPE(${m.pipe ?? 0}), .AW(${aw}), .TW(${tw})) u_${m.name}_mpipe (`,
		"\t\t.clk(clk),",
		"\t\t.rst_n(rst_n),",
		`\t\t.m_cyc(${pin(idxName ? "cyc_i" : "o_wb_cyc")}),`,
		`\t\t.m_stb(${pin(idxName ? "stb_i" : "o_wb_stb")}),`,
		`\t\t.m_we(${pin(idxName ? "we_i" : "o_wb_we")}),`,
		`\t\t.m_adr(${adrPort ?? pin("o_wb_adr")}),`,
		`\t\t.m_dat(${pin(idxName ? "dat_i" : "o_wb_dat")}),`,
		`\t\t.m_sel(${pin(idxName ? "sel_i" : "o_wb_sel")}),`,
	);
	if (tw > 0) {
		out.push(
			`\t\t.m_tga(${packedTagExpr(tags, (t) => tagPort(pin("o_wb"), t.domain.name))}),`,
		);
	}
	out.push(
		`\t\t.m_ack(${p}_pack),`,
		`\t\t.m_rdat(${p}_prdat),`,
		`\t\t.s_cyc(${p}_cyc_q),`,
		`\t\t.s_stb(${p}_stb_q),`,
		`\t\t.s_we(${p}_we_q),`,
		`\t\t.s_adr(${p}_adr_q),`,
		`\t\t.s_dat(${p}_wdat_q),`,
		`\t\t.s_sel(${p}_sel_q),`,
	);
	if (tw > 0) out.push(`\t\t.s_tga(${p}_tga_q),`);
	out.push(`\t\t.s_ack(${p}_ack_q),`, `\t\t.s_rdat(${p}_rdat_q)`, "\t);");
	return out;
}

/** Instantiate wb_cfg_pipe. TGA ports stay on the module; omit them when tag=0. */
function emitSlavePipe(
	s: WbSlave,
	aw: number,
	gPrefix: string,
	adr: string,
	def: BusDef,
): string[] {
	const n = s.name;
	const pipe = s.pipe;
	const tags = slaveTagPorts(s, def);
	const st = tagDomainsWidth(
		def.tags.filter((t) =>
			tags.some((p) => p.name.endsWith(`_tga_${t.domain.name}`)),
		),
	);
	const slot = slotSel(n);
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
						return src
							? `({${aw}{broadcast_${name}}} & (${adr} - ${aw}'h${hex(src.base, aw)}))`
							: "";
					}),
				]
					.filter((term) => term !== "")
					.join(" | ");
	const masked = bcast.length === 0 ? offset : ["(", offset, ")"].join("");
	const winAdr = `${hit} ? ${masked} & ~${aw}'h${hex(s.mask, aw)} : ${aw}'d0`;
	const ack = `${n}_pipe_ack`;
	const rdat = `${n}_pipe_rdat`;
	const out: string[] = [
		"\t//------------------------------------------------------------------------------",
		`\t//  Slave ${n} — wb_cfg_pipe PIPE=${pipe} (posted write / blocking read)`,
		"\t//------------------------------------------------------------------------------",
		`\tlogic        ${ack};`,
		`\tlogic [31:0] ${rdat};`,
		`\twb_cfg_pipe #(.PIPE(${pipe}), .AW(${aw}), .TW(${st})) u_${n}_pipe (`,
		"\t\t.clk(clk),",
		"\t\t.rst_n(rst_n),",
		`\t\t.m_cyc(${hit} & ${gPrefix}cyc),`,
		`\t\t.m_stb(${hit} & ${gPrefix}stb),`,
		`\t\t.m_we(${gPrefix}we),`,
		`\t\t.m_adr(${winAdr}),`,
		`\t\t.m_dat(${gPrefix}wdata),`,
		`\t\t.m_sel(${gPrefix}sel),`,
	];
	if (st > 0) {
		out.push(
			`\t\t.m_tga(${packedTagExpr(
				def.tags.filter((t) =>
					tags.some((p) => p.name.endsWith(`_tga_${t.domain.name}`)),
				),
				(t) => tagValue(gPrefix, t),
			)}),`,
		);
	}
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
	if (st > 0) {
		out.push(
			`\t\t.s_tga(${packedTagExpr(
				def.tags.filter((t) =>
					tags.some((p) => p.name.endsWith(`_tga_${t.domain.name}`)),
				),
				(t) => tagPort(wb(n, "i_wb"), t.domain.name),
			)}),`,
		);
	}
	out.push(
		`\t\t.s_ack(${wb(n, "o_wb_ack")}),`,
		`\t\t.s_rdat(${wb(n, "o_wb_dat")})`,
		"\t);",
	);
	return out;
}

/** Response OR-reduction (slot_sel is one-hot; unmapped ACKs immediately). */
function emitResponseMux(
	slaves: readonly WbSlave[],
	dat: string,
	ack: string,
	stb: string,
): string[] {
	const out: string[] = [];
	pushOrAssign(
		out,
		dat,
		slaves.map((s) =>
			(s.pipe ?? 0) > 0
				? `({32{${slotSel(s.name)}}} & ${s.name}_pipe_rdat)`
				: `({32{${slotSel(s.name)}}} & ${wb(s.name, "o_wb_dat")})`,
		),
	);
	const groups = new Map<string, WbSlave[]>();
	for (const s of slaves) {
		for (const name of s.broadcastBy ?? []) {
			const list = groups.get(name) ?? [];
			list.push(s);
			groups.set(name, list);
		}
	}
	const broadcastAcks = [...groups.entries()].map(([name, members]) => {
		const terms = members.map((s) =>
			(s.pipe ?? 0) > 0 ? `${s.name}_pipe_ack` : wb(s.name, "o_wb_ack"),
		);
		return `(broadcast_${name} & ${terms.join(" & ")})`;
	});
	pushOrAssign(out, ack, [
		`(unmapped & ${stb})`,
		...broadcastAcks,
		...slaves.map((s) =>
			(s.pipe ?? 0) > 0
				? `(${slotSel(s.name)} & ${s.name}_pipe_ack)`
				: `(${slotSel(s.name)} & ${wb(s.name, "o_wb_ack")})`,
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
	if (kind === "interconnect") {
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
	} else {
		lines.push(...emitInterconnectBody(def));
	}
	lines.push("endmodule", "");
	return lines.join("\n");
}
