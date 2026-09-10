// SPDX-License-Identifier: MIT
//
// wb_uart.v
//
// Wishbone front-end for the picosoc simpleuart. Register layout keeps the
// picosoc offsets within the 8-byte window:
//   offset 0 (SoC 0x0200_0004): reg_div (RW)
//   offset 4 (SoC 0x0200_0008): reg_dat (RW)
// The ack mirrors picosoc's mem_ready: reg_dat accesses wait while the
// uart reports busy (combinational wait-state).

`timescale 1ns / 1ps
`default_nettype none

module wb_uart (
	input wire clk,
	input wire rst_n,

	input  wire        i_wb_cyc,
	input  wire        i_wb_stb,
	input  wire        i_wb_we,
	input  wire [31:0] i_wb_adr,
	input  wire [31:0] i_wb_dat,
	input  wire [3:0]  i_wb_sel,
	output wire        o_wb_ack,
	output wire [31:0] o_wb_dat,

	output wire ser_tx,
	input  wire ser_rx
);

	wire div_sel = i_wb_cyc & i_wb_stb & ~i_wb_adr[2];
	wire dat_sel = i_wb_cyc & i_wb_stb &  i_wb_adr[2];

	wire        reg_dat_wait;
	wire [31:0] reg_div_do;
	wire [31:0] reg_dat_do;

	assign o_wb_ack  = div_sel | (dat_sel & ~reg_dat_wait);
	assign o_wb_dat = div_sel ? reg_div_do : reg_dat_do;

	simpleuart simpleuart_i (
		.clk    (clk),
		.resetn (rst_n),

		.ser_tx (ser_tx),
		.ser_rx (ser_rx),

		.reg_div_we  (div_sel & o_wb_ack & i_wb_we ? i_wb_sel : 4'b0000),
		.reg_div_di  (i_wb_dat),
		.reg_div_do  (reg_div_do),

		.reg_dat_we  (dat_sel & o_wb_ack & i_wb_we),
		.reg_dat_re  (dat_sel & o_wb_ack & ~i_wb_we),
		.reg_dat_di  (i_wb_dat),
		.reg_dat_do  (reg_dat_do),
		.reg_dat_wait(reg_dat_wait)
	);

endmodule

`default_nettype wire
