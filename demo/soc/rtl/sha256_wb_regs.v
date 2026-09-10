// SPDX-License-Identifier: MIT
//
// sha256_wb_regs.v
//
// AXIS front-end + sticky done glue for zynq_sha256 (no Wishbone).
// CSR leaf is sha256_{0,1}_regfile on soc_top (identity-match IC slaves).

`timescale 1ns / 1ps
`default_nettype none

module sha256_wb_regs (
	input wire clk,
	input wire rst_ni,

	// AXI4-Stream slave (payload from the SD read DMA)
	input  wire [31:0] s_axis_tdata,
	input  wire        s_axis_tvalid,
	output wire        s_axis_tready,
	input  wire        s_axis_tlast,

	// sha256 core handshake
	output wire        o_dat_valid,
	output wire [31:0] o_dat_lsb,
	output wire        o_core_rst_n,
	input  wire        i_hash_busy,
	input  wire        i_irq_finish,
	input  wire [31:0] i_hash0,
	input  wire [31:0] i_hash1,
	input  wire [31:0] i_hash2,
	input  wire [31:0] i_hash3,
	input  wire [31:0] i_hash4,
	input  wire [31:0] i_hash5,
	input  wire [31:0] i_hash6,
	input  wire [31:0] i_hash7,

	// CSR sidebands (from/to sha256_{0,1}_regfile on soc_top)
	input  wire        rg_soft_reset,
	input  wire        p_rg_done_clear,
	output wire        ro_busy,
	output wire        ro_done,
	output wire [31:0] ro_hash0,
	output wire [31:0] ro_hash1,
	output wire [31:0] ro_hash2,
	output wire [31:0] ro_hash3,
	output wire [31:0] ro_hash4,
	output wire [31:0] ro_hash5,
	output wire [31:0] ro_hash6,
	output wire [31:0] ro_hash7,

	output wire o_irq
);

	reg done_sticky;

	assign o_irq        = done_sticky;
	assign o_core_rst_n = rst_ni & ~rg_soft_reset;
	assign ro_busy      = i_hash_busy;
	assign ro_done      = done_sticky;
	assign ro_hash0     = i_hash0;
	assign ro_hash1     = i_hash1;
	assign ro_hash2     = i_hash2;
	assign ro_hash3     = i_hash3;
	assign ro_hash4     = i_hash4;
	assign ro_hash5     = i_hash5;
	assign ro_hash6     = i_hash6;
	assign ro_hash7     = i_hash7;

	// Stream front-end (was sha256_stream_v1_0_S00_AXIS)
	assign s_axis_tready = ~i_hash_busy & ~rg_soft_reset & rst_ni;
	assign o_dat_valid   = s_axis_tvalid & s_axis_tready;
	assign o_dat_lsb     = s_axis_tdata;

	// Sticky done: HW sets on finish; SW clears via CTRL.done_clear (W1P)
	always @(posedge clk or negedge rst_ni) begin
		if (!rst_ni)
			done_sticky <= 1'b0;
		else begin
			if (i_irq_finish)
				done_sticky <= 1'b1;
			if (p_rg_done_clear)
				done_sticky <= 1'b0;
		end
	end

	// s_axis_tlast is intentionally unused: the sha256 core frames by count
	wire unused = s_axis_tlast;

endmodule

`default_nettype wire
