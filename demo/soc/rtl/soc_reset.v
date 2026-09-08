// SPDX-License-Identifier: MIT
//
// soc_reset.v
//
// Reset polarity bridge for the autowire SoC demo: the SoC runs active-low
// resetn internally, while picorv32_wb (wb_rst_i) and sdspi (i_sd_reset)
// take an active-high reset. Synchronous deassertion.

`timescale 1ns / 1ps
`default_nettype none

module soc_reset (
	input  wire clk,
	input  wire i_rst_n,
	output wire o_rst
);

	reg [1:0] sync_ff = 2'b11;

	always @(posedge clk or negedge i_rst_n) begin
		if (!i_rst_n)
			sync_ff <= 2'b11;
		else
			sync_ff <= {sync_ff[0], 1'b0};
	end

	assign o_rst = sync_ff[1];

endmodule

`default_nettype wire
