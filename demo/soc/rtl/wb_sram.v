// SPDX-License-Identifier: MIT
//
// wb_sram.v
//
// Classic Wishbone B4 on-chip SRAM for the autowire SoC demo. One
// transaction per cycle at most (registered ack), byte writes via sel.
// The interconnect hands in the window offset address.

`timescale 1ns / 1ps
`default_nettype none

module wb_sram #(
	parameter integer WORDS = 16384,  // 64 KiB
	parameter integer AW    = 14      // clog2(WORDS)
) (
	input wire clk,
	input wire rst_n,

	input  wire        i_wb_cyc,
	input  wire        i_wb_stb,
	input  wire        i_wb_we,
	input  wire [31:0] i_wb_adr,
	input  wire [31:0] i_wb_dat,
	input  wire [3:0]  i_wb_sel,
	output reg         o_wb_ack,
	output reg  [31:0] o_wb_dat
);

	reg [31:0] mem [0:WORDS-1];

	wire valid = i_wb_cyc & i_wb_stb;
	wire [AW-1:0] waddr = i_wb_adr[AW+1:2];

	always @(posedge clk) begin
		if (!rst_n)
			o_wb_ack <= 1'b0;
		else
			o_wb_ack <= valid & ~o_wb_ack;

		if (valid & i_wb_we) begin
			if (i_wb_sel[0]) mem[waddr][7:0]   <= i_wb_dat[7:0];
			if (i_wb_sel[1]) mem[waddr][15:8]  <= i_wb_dat[15:8];
			if (i_wb_sel[2]) mem[waddr][23:16] <= i_wb_dat[23:16];
			if (i_wb_sel[3]) mem[waddr][31:24] <= i_wb_dat[31:24];
		end

		o_wb_dat <= mem[waddr];
	end

endmodule

`default_nettype wire
