// Emit SystemVerilog for wishbone-bus decoder / interconnect.
// Slave ports use leaf-centric names: `{slave}_i_wb_*` / `{slave}_o_wb_*`
// so they identity-match wishbone-regfile. Masters stay flat m_* vectors when NM>1.

import type { BusDef, WbSlave } from "./dsl.ts";

function hex(n: number, width = 32): string {
	return n.toString(16).padStart(Math.ceil(width / 4), "0");
}

function wb(slave: string, stem: string): string {
	return `${slave}_${stem}`;
}

function packedRange(width: number): string {
	return width > 1 ? `[${width - 1}:0]` : "";
}

/** Module basename: decoder if NM<=1, else interconnect. */
export function busModuleKind(def: BusDef): "decoder" | "interconnect" {
	return def.masters.length <= 1 ? "decoder" : "interconnect";
}

export function busModuleName(def: BusDef): string {
	return `${def.name.toLowerCase()}_${busModuleKind(def)}`;
}

function slavePortBlock(s: WbSlave, aw: number): string[] {
	const n = s.name;
	const adr = packedRange(aw);
	const st = s.tag ?? 0;
	const lines = [
		`\t// Slave ${n} — ${s.desc}`,
		`\t//   base=0x${hex(s.base)}  mask=0x${hex(s.mask)}`,
		`\toutput logic ${adr ? `${adr} ` : ""}${wb(n, "i_wb_adr")},`,
		`\toutput logic [31:0] ${wb(n, "i_wb_dat")},`,
		`\toutput logic [3:0]  ${wb(n, "i_wb_sel")},`,
	];
	if (st > 0) {
		lines.push(
			`\toutput logic ${packedRange(st).padEnd(7)}${wb(n, "i_wb_tga")},`,
		);
	}
	lines.push(
		`\toutput logic        ${wb(n, "i_wb_cyc")},`,
		`\toutput logic        ${wb(n, "i_wb_stb")},`,
		`\toutput logic        ${wb(n, "i_wb_we")},`,
		`\tinput  logic [31:0] ${wb(n, "o_wb_dat")},`,
		`\tinput  logic        ${wb(n, "o_wb_ack")}`,
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
	const cont = "\t" + " ".repeat(`assign ${lhs} `.length);
	for (const [i, t] of rest.entries()) {
		out.push(`${cont}| ${t}${i === rest.length - 1 ? ";" : ""}`);
	}
}

function emitDecoderBody(def: BusDef): string[] {
	const aw = def.addr_width;
	const tw = def.tag_width;
	const slaves = def.slaves;
	const out: string[] = [];
	out.push(
		`\tlogic ${packedRange(aw).padEnd(7)}g_adr;`,
		"\tlogic [31:0] g_wdata;",
		"\tlogic [3:0]  g_sel;",
	);
	if (tw > 0) {
		out.push(`\tlogic ${packedRange(tw).padEnd(7)}g_tga;`);
	}
	out.push(
		"\tlogic        g_cyc;",
		"\tlogic        g_stb;",
		"\tlogic        g_we;",
		"",
		"\tassign g_adr   = m_adr_i;",
		"\tassign g_wdata = m_dat_i;",
		"\tassign g_sel   = m_sel_i;",
	);
	if (tw > 0) {
		out.push("\tassign g_tga   = m_tga_i;");
	}
	out.push(
		"\tassign g_cyc   = m_cyc_i;",
		"\tassign g_stb   = m_stb_i;",
		"\tassign g_we    = m_we_i;",
		"",
	);
	out.push(...emitDecodeAndSlaves(def, "g_"));
	out.push("", "\tlogic [31:0] rsp_dat;", "\tlogic        rsp_ack;", "");
	out.push(...emitResponseMux(slaves, "rsp_dat", "rsp_ack", "g_stb"));
	out.push("\tassign m_dat_o = rsp_dat;", "\tassign m_ack_o = rsp_ack;", "");
	return out;
}

function emitInterconnectBody(def: BusDef): string[] {
	const nm = def.masters.length;
	const aw = def.addr_width;
	const tw = def.tag_width;
	const slaves = def.slaves;
	const out: string[] = [];
	const onehot = (i: number) =>
		`${nm}'b${"0".repeat(nm - 1 - i)}1${"0".repeat(i)}`;

	out.push(
		"\t//------------------------------------------------------------------------------",
		"\t//  Arbitration: lowest master index wins; locked while grant holds CYC",
		"\t//------------------------------------------------------------------------------",
		`\tlogic [${nm - 1}:0] grant;`,
		"\tlogic        busy;",
		`\tlogic [${nm - 1}:0] grant_nxt;`,
		"",
		"\talways_comb begin",
	);
	for (let i = 0; i < nm; i++) {
		const kw = i === 0 ? "if      " : "else if ";
		out.push(`\t\t${kw}(m_cyc_i[${i}]) grant_nxt = ${onehot(i)};`);
	}
	out.push(
		`\t\t${"else".padEnd(`else if (m_cyc_i[${nm - 1}]) `.length)}grant_nxt = ${nm}'b${"0".repeat(nm)};`,
		"\tend",
		"",
		"\talways_ff @(posedge clk or negedge rst_n) begin",
		"\t\tif (!rst_n) begin",
		"\t\t\tbusy  <= 1'b0;",
		`\t\t\tgrant <= ${nm}'b0;`,
		"\t\tend else if (!busy) begin",
		"\t\t\tif (|m_cyc_i) begin",
		"\t\t\t\tbusy  <= 1'b1;",
		"\t\t\t\tgrant <= grant_nxt;",
		"\t\t\tend",
		"\t\tend else if (!(|(m_cyc_i & grant))) begin",
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
	if (tw > 0) {
		out.push(`\tlogic ${packedRange(tw).padEnd(7)}g_tga;`);
	}
	out.push(
		"\tlogic        g_cyc;",
		"\tlogic        g_stb;",
		"\tlogic        g_we;",
		"",
	);

	const masters = [...Array(nm).keys()];
	const muxVec = (lhs: string, sig: string, width: number, step: number) =>
		pushOrAssign(
			out,
			lhs,
			masters.map(
				(i) => `({${width}{gsel[${i}]}} & ${sig}[${i}*${step} +: ${step}])`,
			),
		);
	muxVec("g_adr  ", "m_adr_i", aw, aw);
	muxVec("g_wdata", "m_dat_i", 32, 32);
	muxVec("g_sel  ", "m_sel_i", 4, 4);
	if (tw > 0) {
		muxVec("g_tga  ", "m_tga_i", tw, tw);
	}
	out.push(
		`\tassign g_cyc   = |(gsel & m_cyc_i);`,
		`\tassign g_stb   = |(gsel & m_stb_i);`,
		`\tassign g_we    = |(gsel & m_we_i);`,
		"",
	);

	out.push(...emitDecodeAndSlaves(def, "g_"));

	out.push("", "\tlogic [31:0] rsp_dat;", "\tlogic        rsp_ack;", "");
	out.push(...emitResponseMux(slaves, "rsp_dat", "rsp_ack", "g_stb"));

	out.push(
		"",
		"\t//------------------------------------------------------------------------------",
		"\t//  Master response: only the granted slot sees DAT/ACK",
		"\t//------------------------------------------------------------------------------",
	);
	const datPad = Math.max(
		...masters.map((i) => `m_dat_o[${i}*32 +: 32]`.length),
	);
	for (const i of masters) {
		const lhs = `m_dat_o[${i}*32 +: 32]`.padEnd(datPad);
		out.push(`\tassign ${lhs} = {32{gsel[${i}]}} & rsp_dat;`);
	}
	out.push(
		`\tassign ${"m_ack_o".padEnd(datPad)} = gsel & {${nm}{rsp_ack}};`,
		"",
	);
	return out;
}

function emitDecodeAndSlaves(def: BusDef, gPrefix: string): string[] {
	const slaves = def.slaves;
	const ns = slaves.length;
	const aw = def.addr_width;
	const out: string[] = [];
	out.push(
		"\t//------------------------------------------------------------------------------",
		"\t//  Address decode: lowest matching slave wins (mutually exclusive)",
		"\t//------------------------------------------------------------------------------",
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
		const onehotHex = (1n << BigInt(i)).toString(16);
		out.push(
			`\t\tif ((${gPrefix}adr & ${aw}'h${hex(s.mask, aw)}) == ${aw}'h${hex(s.base, aw)}) begin`,
			`\t\t\tslot_sel = ${ns}'h${onehotHex};`,
			"\t\t\tunmapped = 1'b0;",
			"\t\tend",
		);
	}
	out.push("\tend", "");

	out.push(
		"\t//------------------------------------------------------------------------------",
		"\t//  Named slave drive (window offset ADR)",
		"\t//------------------------------------------------------------------------------",
	);
	const namePad = Math.max(...slaves.map((s) => wb(s.name, "i_wb_adr").length));
	const slotPad = Math.max(...slaves.map((_, i) => `slot_sel[${i}]`.length));
	for (let i = 0; i < ns; i++) {
		const s = slaves[i];
		if (s === undefined) continue;
		const n = s.name;
		const port = (stem: string) => wb(n, stem).padEnd(namePad);
		const slot = `slot_sel[${i}]`.padEnd(slotPad);
		out.push(
			`\tassign ${port("i_wb_adr")} = ${slot} ? ${gPrefix}adr & ~${aw}'h${hex(s.mask, aw)} : ${aw}'d0;`,
			`\tassign ${port("i_wb_dat")} = ${gPrefix}wdata;`,
			`\tassign ${port("i_wb_sel")} = ${gPrefix}sel;`,
		);
		const st = s.tag ?? 0;
		if (st > 0) {
			out.push(`\tassign ${port("i_wb_tga")} = ${gPrefix}tga[${st - 1}:0];`);
		}
		out.push(
			`\tassign ${port("i_wb_cyc")} = ${slot} & ${gPrefix}cyc;`,
			`\tassign ${port("i_wb_stb")} = ${slot} & ${gPrefix}stb;`,
			`\tassign ${port("i_wb_we ")} = ${gPrefix}we;`,
		);
		if (i < ns - 1) out.push("");
	}
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
		slaves.map((s, i) => `({32{slot_sel[${i}]}} & ${wb(s.name, "o_wb_dat")})`),
	);
	pushOrAssign(out, ack, [
		`(unmapped & ${stb})`,
		...slaves.map((s, i) => `(slot_sel[${i}] & ${wb(s.name, "o_wb_ack")})`),
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
		`// Generated by autowire plugin wishbone-bus (${kind} ${def.name}). Do not edit.`,
		"//",
		"//------------------------------------------------------------------------------",
		`//  Module: ${mod}`,
		`//  Desc:   ${def.desc}`,
		`//  Masters: ${nm} (${kind === "decoder" ? "decoder-only; no arbiter" : "priority arbiter"})`,
		`//  Slaves:  ${def.slaves.length} (named {slave}_i_wb_* / {slave}_o_wb_*)`,
	);
	if (tw > 0) {
		lines.push(`//  Tag:     TGA ${tw} bit (forwarded, not interpreted)`);
	}
	lines.push(
		"//------------------------------------------------------------------------------",
		"//  Address map:",
	);
	for (const s of def.slaves) {
		lines.push(
			`//    0x${hex(s.base)}  mask=0x${hex(s.mask)}  ${s.name} — ${s.desc}`,
		);
	}
	lines.push(
		"//------------------------------------------------------------------------------",
		"",
	);
	lines.push(`module ${mod} (`);
	lines.push("\tinput  logic        clk,");
	lines.push("\tinput  logic        rst_n,");

	const portBlocks: string[][] = [];
	if (kind === "decoder") {
		const tr = packedRange(tw);
		const block = [
			"\t// Single master (flat; decoder mode)",
			`\tinput  logic ${packedRange(aw) ? `${packedRange(aw)} ` : ""}m_adr_i`,
			"\tinput  logic [31:0] m_dat_i",
			"\tinput  logic [3:0]  m_sel_i",
		];
		if (tw > 0) {
			block.push(`\tinput  logic ${tr ? `${tr} ` : ""}m_tga_i`);
		}
		block.push(
			"\tinput  logic        m_cyc_i",
			"\tinput  logic        m_stb_i",
			"\tinput  logic        m_we_i",
			"\toutput logic [31:0] m_dat_o",
			"\toutput logic        m_ack_o",
		);
		portBlocks.push(block);
	} else {
		const block = [
			`\t// Masters (flat vectors, NM=${nm})`,
			`\tinput  logic [${nm * aw - 1}:0] m_adr_i`,
			`\tinput  logic [${nm * 32 - 1}:0] m_dat_i`,
			`\tinput  logic [${nm * 4 - 1}:0]  m_sel_i`,
		];
		if (tw > 0) {
			block.push(`\tinput  logic [${nm * tw - 1}:0] m_tga_i`);
		}
		block.push(
			`\tinput  logic [${nm - 1}:0]    m_cyc_i`,
			`\tinput  logic [${nm - 1}:0]    m_stb_i`,
			`\tinput  logic [${nm - 1}:0]    m_we_i`,
			`\toutput logic [${nm * 32 - 1}:0] m_dat_o`,
			`\toutput logic [${nm - 1}:0]    m_ack_o`,
		);
		portBlocks.push(block);
	}
	for (const s of def.slaves) {
		portBlocks.push(slavePortBlock(s, aw));
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
