// SPDX-License-Identifier: MIT
//
// wb_interconnect.v
//
// Flat-vector Wishbone (B4, classic cycle) interconnect for the autowire
// SoC demo. NM masters x NS slaves; masters and slaves are exposed as
// concatenated vectors so the connect layer wires per-master/per-slave
// slices with part-selects.
//
// - Priority arbitration: lowest master index wins; the grant is locked
//   while the granted master holds cyc.
// - Address decode: slot s matches when (adr & SLAVE_MASK[s]) == SLAVE_BASE[s];
//   lowest matching slot wins. Slaves receive the window offset address
//   (adr & ~SLAVE_MASK[s]).
// - Unmapped accesses are acknowledged immediately with zero read data so a
//   bad address cannot hang the CPU.
// - No stall wiring: classic cycles only, slaves terminate with ack.

`timescale 1ns / 1ps
`default_nettype none

module wb_interconnect #(
	parameter NM = 3,
	parameter NS = 11,
	parameter [NS*32-1:0] SLAVE_BASE = 0,
	parameter [NS*32-1:0] SLAVE_MASK = 0
) (
	input wire clk,
	input wire rst_n,

	// Master side (flat vectors, m2s = master to slave)
	input  wire [NM*32-1:0] m_adr_i,
	input  wire [NM*32-1:0] m_dat_i,
	input  wire [NM*4-1:0]  m_sel_i,
	input  wire [NM-1:0]    m_cyc_i,
	input  wire [NM-1:0]    m_stb_i,
	input  wire [NM-1:0]    m_we_i,
	output reg  [NM*32-1:0] m_dat_o,
	output reg  [NM-1:0]    m_ack_o,

	// Slave side (flat vectors)
	output reg  [NS*32-1:0] s_adr_o,
	output reg  [NS*32-1:0] s_dat_o,
	output reg  [NS*4-1:0]  s_sel_o,
	output reg  [NS-1:0]    s_cyc_o,
	output reg  [NS-1:0]    s_stb_o,
	output reg  [NS-1:0]    s_we_o,
	input  wire [NS*32-1:0] s_dat_i,
	input  wire [NS-1:0]    s_ack_i
);

	integer gi;
	integer mi;
	integer si;
	integer oi;
	integer ri;

	// ----------------------------------------------------------------
	// Arbitration: priority to the lowest master index, locked on cyc
	// ----------------------------------------------------------------
	reg [NM-1:0] grant;
	reg          busy;

	reg [NM-1:0] grant_nxt;
	always @* begin
		grant_nxt = {NM{1'b0}};
		for (gi = NM - 1; gi >= 0; gi = gi - 1)
			if (m_cyc_i[gi]) begin
				grant_nxt = {NM{1'b0}};
				grant_nxt[gi] = 1'b1;
			end
	end

	always @(posedge clk) begin
		if (!rst_n) begin
			busy  <= 1'b0;
			grant <= {NM{1'b0}};
		end else if (!busy) begin
			if (|m_cyc_i) begin
				busy  <= 1'b1;
				grant <= grant_nxt;
			end
		end else if (!(|(m_cyc_i & grant))) begin
			busy <= 1'b0;
		end
	end

	// ----------------------------------------------------------------
	// Granted master signals
	// ----------------------------------------------------------------
	reg [31:0] g_adr;
	reg [31:0] g_wdata;
	reg [3:0]  g_sel;
	reg        g_cyc;
	reg        g_stb;
	reg        g_we;

	always @* begin
		g_adr   = 32'h0;
		g_wdata = 32'h0;
		g_sel   = 4'h0;
		g_cyc   = 1'b0;
		g_stb   = 1'b0;
		g_we    = 1'b0;
		for (mi = 0; mi < NM; mi = mi + 1)
			if (busy && grant[mi]) begin
				g_adr   = m_adr_i[mi*32 +: 32];
				g_wdata = m_dat_i[mi*32 +: 32];
				g_sel   = m_sel_i[mi*4 +: 4];
				g_cyc   = m_cyc_i[mi];
				g_stb   = m_stb_i[mi];
				g_we    = m_we_i[mi];
			end
	end

	// ----------------------------------------------------------------
	// Address decode: lowest matching slot wins
	// ----------------------------------------------------------------
	reg [NS-1:0] slot_sel;
	reg          unmapped;

	always @* begin
		slot_sel = {NS{1'b0}};
		unmapped = 1'b1;
		for (si = NS - 1; si >= 0; si = si - 1)
			if ((g_adr & SLAVE_MASK[si*32 +: 32]) == SLAVE_BASE[si*32 +: 32]) begin
				slot_sel = {NS{1'b0}};
				slot_sel[si] = 1'b1;
				unmapped = 1'b0;
			end
	end

	// ----------------------------------------------------------------
	// Slave drive: offset address within the matched window
	// ----------------------------------------------------------------
	always @* begin
		s_adr_o   = {NS*32{1'b0}};
		s_dat_o   = {NS*32{1'b0}};
		s_sel_o   = {NS*4{1'b0}};
		s_cyc_o   = {NS{1'b0}};
		s_stb_o   = {NS{1'b0}};
		s_we_o    = {NS{1'b0}};
		for (oi = 0; oi < NS; oi = oi + 1)
			if (slot_sel[oi]) begin
			s_adr_o[oi*32 +: 32] = g_adr & ~SLAVE_MASK[oi*32 +: 32];
				s_dat_o[oi*32 +: 32] = g_wdata;
				s_sel_o[oi*4 +: 4]   = g_sel;
				s_cyc_o[oi]          = g_cyc;
				s_stb_o[oi]          = g_stb;
				s_we_o[oi]           = g_we;
			end
	end

	// ----------------------------------------------------------------
	// Response routing back to the granted master
	// ----------------------------------------------------------------
	reg [31:0] rsp_dat;
	reg        rsp_ack;

	always @* begin
		rsp_dat = 32'h0;
		for (ri = 0; ri < NS; ri = ri + 1)
			if (slot_sel[ri])
				rsp_dat = s_dat_i[ri*32 +: 32];
		rsp_ack = unmapped ? g_stb : |(s_ack_i & slot_sel);

		m_dat_o = {NM*32{1'b0}};
		m_ack_o = {NM{1'b0}};
		for (ri = 0; ri < NM; ri = ri + 1)
			if (busy && grant[ri]) begin
				m_dat_o[ri*32 +: 32] = rsp_dat;
				m_ack_o[ri]          = rsp_ack;
			end
	end

endmodule

`default_nettype wire
