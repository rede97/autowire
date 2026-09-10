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
	return [
		`\t// Slave ${n} — ${s.desc}`,
		`\t//   base=0x${hex(s.base)}  mask=0x${hex(s.mask)}`,
		`\toutput logic ${adr ? `${adr} ` : ""}${wb(n, "i_wb_adr")},`,
		`\toutput logic [31:0] ${wb(n, "i_wb_dat")},`,
		`\toutput logic [3:0]  ${wb(n, "i_wb_sel")},`,
		`\toutput logic        ${wb(n, "i_wb_cyc")},`,
		`\toutput logic        ${wb(n, "i_wb_stb")},`,
		`\toutput logic        ${wb(n, "i_wb_we")},`,
		`\tinput  logic [31:0] ${wb(n, "o_wb_dat")},`,
		`\tinput  logic        ${wb(n, "o_wb_ack")}`,
	];
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

function emitDecoderBody(def: BusDef): string[] {
	const aw = def.addr_width;
	const slaves = def.slaves;
	const ns = slaves.length;
	const out: string[] = [];
	out.push(
		"\tlogic [31:0] g_adr;",
		"\tlogic [31:0] g_wdata;",
		"\tlogic [3:0]  g_sel;",
		"\tlogic        g_cyc;",
		"\tlogic        g_stb;",
		"\tlogic        g_we;",
		"",
		"\tassign g_adr   = m_adr_i;",
		"\tassign g_wdata = m_dat_i;",
		"\tassign g_sel   = m_sel_i;",
		"\tassign g_cyc   = m_cyc_i;",
		"\tassign g_stb   = m_stb_i;",
		"\tassign g_we    = m_we_i;",
		"",
	);
	out.push(...emitDecodeAndSlaves(def, "g_"));
	out.push("", "\tlogic [31:0] rsp_dat;", "\tlogic        rsp_ack;", "");
	out.push(...emitResponseMux(slaves, "rsp_dat", "rsp_ack", "g_stb"));
	out.push("\tassign m_dat_o = rsp_dat;", "\tassign m_ack_o = rsp_ack;", "");
	void ns;
	void aw;
	return out;
}

function emitInterconnectBody(def: BusDef): string[] {
	const nm = def.masters.length;
	const slaves = def.slaves;
	const out: string[] = [];
	out.push(
		"\tinteger gi;",
		"\tinteger mi;",
		"\tinteger si;",
		"\tinteger oi;",
		"\tinteger ri;",
		"",
		"\t//------------------------------------------------------------------------------",
		"\t//  Arbitration: lowest master index wins; locked while grant holds CYC",
		"\t//------------------------------------------------------------------------------",
		`\tlogic [${nm - 1}:0] grant;`,
		"\tlogic        busy;",
		`\tlogic [${nm - 1}:0] grant_nxt;`,
		"",
		"\talways_comb begin",
		`\t\tgrant_nxt = ${nm}'b0;`,
		`\t\tfor (gi = ${nm - 1}; gi >= 0; gi = gi - 1)`,
		"\t\t\tif (m_cyc_i[gi]) begin",
		`\t\t\t\tgrant_nxt = ${nm}'b0;`,
		"\t\t\t\tgrant_nxt[gi] = 1'b1;",
		"\t\t\tend",
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
		"\tlogic [31:0] g_adr;",
		"\tlogic [31:0] g_wdata;",
		"\tlogic [3:0]  g_sel;",
		"\tlogic        g_cyc;",
		"\tlogic        g_stb;",
		"\tlogic        g_we;",
		"",
		"\talways_comb begin",
		"\t\tg_adr   = 32'h0;",
		"\t\tg_wdata = 32'h0;",
		"\t\tg_sel   = 4'h0;",
		"\t\tg_cyc   = 1'b0;",
		"\t\tg_stb   = 1'b0;",
		"\t\tg_we    = 1'b0;",
		`\t\tfor (mi = 0; mi < ${nm}; mi = mi + 1)`,
		"\t\t\tif (busy && grant[mi]) begin",
		"\t\t\t\tg_adr   = m_adr_i[mi*32 +: 32];",
		"\t\t\t\tg_wdata = m_dat_i[mi*32 +: 32];",
		"\t\t\t\tg_sel   = m_sel_i[mi*4 +: 4];",
		"\t\t\t\tg_cyc   = m_cyc_i[mi];",
		"\t\t\t\tg_stb   = m_stb_i[mi];",
		"\t\t\t\tg_we    = m_we_i[mi];",
		"\t\t\tend",
		"\tend",
		"",
	);
	out.push(...emitDecodeAndSlaves(def, "g_"));
	out.push("", "\tlogic [31:0] rsp_dat;", "\tlogic        rsp_ack;", "");
	out.push(...emitResponseMux(slaves, "rsp_dat", "rsp_ack", "g_stb"));
	out.push(
		"",
		`\talways_comb begin`,
		`\t\tm_dat_o = {${nm}*32{1'b0}};`,
		`\t\tm_ack_o = {${nm}{1'b0}};`,
		`\t\tfor (ri = 0; ri < ${nm}; ri = ri + 1)`,
		"\t\t\tif (busy && grant[ri]) begin",
		"\t\t\t\tm_dat_o[ri*32 +: 32] = rsp_dat;",
		"\t\t\t\tm_ack_o[ri]          = rsp_ack;",
		"\t\t\tend",
		"\tend",
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
	// High→low so the last write is the lowest index (same as demo wb_interconnect).
	for (let i = ns - 1; i >= 0; i--) {
		const s = slaves[i];
		if (s === undefined) continue;
		out.push(
			`\t\tif ((${gPrefix}adr & 32'h${hex(s.mask)}) == 32'h${hex(s.base)}) begin`,
			`\t\t\tslot_sel = ${ns}'b0;`,
			`\t\t\tslot_sel[${i}] = 1'b1;`,
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
	for (let i = 0; i < ns; i++) {
		const s = slaves[i];
		if (s === undefined) continue;
		const n = s.name;
		const adrAssign =
			aw >= 32
				? `${gPrefix}adr & ~32'h${hex(s.mask)}`
				: `(${gPrefix}adr & ~32'h${hex(s.mask)})[${aw - 1}:0]`;
		out.push(
			`\tassign ${wb(n, "i_wb_adr")} = slot_sel[${i}] ? ${adrAssign} : ${aw}'d0;`,
			`\tassign ${wb(n, "i_wb_dat")} = ${gPrefix}wdata;`,
			`\tassign ${wb(n, "i_wb_sel")} = ${gPrefix}sel;`,
			`\tassign ${wb(n, "i_wb_cyc")} = slot_sel[${i}] & ${gPrefix}cyc;`,
			`\tassign ${wb(n, "i_wb_stb")} = slot_sel[${i}] & ${gPrefix}stb;`,
			`\tassign ${wb(n, "i_wb_we")}  = ${gPrefix}we;`,
		);
	}
	return out;
}

function emitResponseMux(
	slaves: readonly WbSlave[],
	dat: string,
	ack: string,
	stb: string,
): string[] {
	const ns = slaves.length;
	const out: string[] = [
		"\talways_comb begin",
		`\t\t${dat} = 32'h0;`,
		`\t\t${ack} = unmapped ? ${stb} : 1'b0;`,
	];
	for (let i = 0; i < ns; i++) {
		const s = slaves[i];
		if (s === undefined) continue;
		out.push(
			`\t\tif (slot_sel[${i}]) begin`,
			`\t\t\t${dat} = ${wb(s.name, "o_wb_dat")};`,
			`\t\t\t${ack} = ${wb(s.name, "o_wb_ack")};`,
			"\t\tend",
		);
	}
	out.push("\tend");
	return out;
}

export function emitBusSv(def: BusDef): string {
	const kind = busModuleKind(def);
	const mod = busModuleName(def);
	const aw = def.addr_width;
	const nm = def.masters.length;
	const lines: string[] = [];
	lines.push(
		`// Generated by autowire plugin wishbone-bus (${kind} ${def.name}). Do not edit.`,
		"//",
		"//------------------------------------------------------------------------------",
		`//  Module: ${mod}`,
		`//  Desc:   ${def.desc}`,
		`//  Masters: ${nm} (${kind === "decoder" ? "decoder-only; no arbiter" : "priority arbiter"})`,
		`//  Slaves:  ${def.slaves.length} (named {slave}_i_wb_* / {slave}_o_wb_*)`,
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
		portBlocks.push([
			"\t// Single master (flat; decoder mode)",
			`\tinput  logic ${packedRange(aw) ? `${packedRange(aw)} ` : ""}m_adr_i`,
			"\tinput  logic [31:0] m_dat_i",
			"\tinput  logic [3:0]  m_sel_i",
			"\tinput  logic        m_cyc_i",
			"\tinput  logic        m_stb_i",
			"\tinput  logic        m_we_i",
			"\toutput logic [31:0] m_dat_o",
			"\toutput logic        m_ack_o",
		]);
	} else {
		portBlocks.push([
			`\t// Masters (flat vectors, NM=${nm})`,
			`\tinput  logic [${nm * 32 - 1}:0] m_adr_i`,
			`\tinput  logic [${nm * 32 - 1}:0] m_dat_i`,
			`\tinput  logic [${nm * 4 - 1}:0]  m_sel_i`,
			`\tinput  logic [${nm - 1}:0]    m_cyc_i`,
			`\tinput  logic [${nm - 1}:0]    m_stb_i`,
			`\tinput  logic [${nm - 1}:0]    m_we_i`,
			`\toutput logic [${nm * 32 - 1}:0] m_dat_o`,
			`\toutput logic [${nm - 1}:0]    m_ack_o`,
		]);
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
