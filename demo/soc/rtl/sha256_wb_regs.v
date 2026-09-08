// SPDX-License-Identifier: MIT
//
// sha256_wb_regs.v
//
// Wishbone register block + AXI4-Stream front-end for the zynq_sha256
// streaming core. This leaf replaces the original AXI4-Lite / AXI4-Stream
// wrappers; the autowire connect layer re-wraps it together with the sha256
// core as module "sha256wb" (connect/sha256wb.html).
//
// Wishbone register map (word offset, 32-byte window):
//   0x00 CTRL/STATUS  bit0: soft_reset (RW), bit1: done_clear (W1C)
//                     bit8: busy (RO), bit9: done (RO, sticky)
//   0x04..0x20        hash0..hash7 (RO), same order as the original
//                     sha256_stream_v1_0 AXI register file
//
// Stream front-end: tready = core not busy and not in soft reset; a beat is
// forwarded to the core (o_dat_valid) when tvalid & tready. tlast is not
// needed by the core and is accepted but ignored.
//
// o_core_rst_n = rst_ni & ~soft_reset (drives sha256.rst_n).
// o_irq is the sticky done flag (cleared via CTRL.done_clear).

`timescale 1ns / 1ps
`default_nettype none

module sha256_wb_regs (
	input wire clk,
	input wire rst_ni,

	// Wishbone slave
	input  wire        i_wb_cyc,
	input  wire        i_wb_stb,
	input  wire        i_wb_we,
	input  wire [31:0] i_wb_addr,
	input  wire [31:0] i_wb_data,
	input  wire [3:0]  i_wb_sel,
	output reg         o_wb_ack,
	output reg  [31:0] o_wb_data,

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

	output wire o_irq
);

	reg soft_reset;
	reg done;

	assign o_irq        = done;
	assign o_core_rst_n = rst_ni & ~soft_reset;

	// Stream front-end (was sha256_stream_v1_0_S00_AXIS)
	assign s_axis_tready = ~i_hash_busy & ~soft_reset & rst_ni;
	assign o_dat_valid   = s_axis_tvalid & s_axis_tready;
	assign o_dat_lsb     = s_axis_tdata;

	wire slv_sel = i_wb_cyc & i_wb_stb;
	wire wr_en = slv_sel & i_wb_we & ~o_wb_ack;

	always @(posedge clk) begin
		if (!rst_ni) begin
			soft_reset <= 1'b0;
			done       <= 1'b0;
			o_wb_ack   <= 1'b0;
			o_wb_data  <= 32'h0;
		end else begin
			o_wb_ack <= slv_sel & ~o_wb_ack;

			if (i_irq_finish)
				done <= 1'b1;
			if (wr_en && i_wb_addr[5:2] == 4'd0) begin
				if (i_wb_sel[0]) soft_reset <= i_wb_data[0];
				if (i_wb_data[1]) done <= 1'b0;
			end

			if (slv_sel && !i_wb_we) begin
				case (i_wb_addr[5:2])
				4'd0: o_wb_data <= {22'h0, done, i_hash_busy, 7'h0, soft_reset};
					4'd1: o_wb_data <= i_hash0;
					4'd2: o_wb_data <= i_hash1;
					4'd3: o_wb_data <= i_hash2;
					4'd4: o_wb_data <= i_hash3;
					4'd5: o_wb_data <= i_hash4;
					4'd6: o_wb_data <= i_hash5;
					4'd7: o_wb_data <= i_hash6;
					4'd8: o_wb_data <= i_hash7;
					default: o_wb_data <= 32'h0;
				endcase
			end
		end
	end

	// s_axis_tlast is intentionally unused: the sha256 core frames by count
	wire unused = s_axis_tlast;

endmodule

`default_nettype wire
