// SPDX-License-Identifier: MIT
//
// wb_testout.v
//
// Built-in test output interface (tohost-style). A word written here is
// presented on o_test_data with a one-cycle o_test_valid strobe; a read
// returns the last written value.

`timescale 1ns / 1ps
`default_nettype none

module wb_testout (
	input wire clk,
	input wire rst_n,

	input  wire        i_wb_cyc,
	input  wire        i_wb_stb,
	input  wire        i_wb_we,
	input  wire [31:0] i_wb_adr,
	input  wire [31:0] i_wb_dat,
	input  wire [3:0]  i_wb_sel,
	output reg         o_wb_ack,
	output reg  [31:0] o_wb_dat,

	output reg         o_test_valid,
	output reg  [31:0] o_test_data
);

	always @(posedge clk) begin
		if (!rst_n) begin
			o_wb_ack     <= 1'b0;
			o_wb_dat    <= 32'h0;
			o_test_valid <= 1'b0;
			o_test_data  <= 32'h0;
		end else begin
			o_wb_ack     <= i_wb_cyc & i_wb_stb & ~o_wb_ack;
			o_test_valid <= 1'b0;
			if (i_wb_cyc && i_wb_stb && i_wb_we && !o_wb_ack) begin
				o_test_valid <= 1'b1;
				o_test_data  <= i_wb_dat;
				o_wb_dat    <= i_wb_dat;
			end
		end
	end

endmodule

`default_nettype wire
