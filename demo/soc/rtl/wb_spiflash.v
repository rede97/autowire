// SPDX-License-Identifier: MIT
//
// wb_spiflash.v
//
// Wishbone front-end for the picosoc spimemio QSPI flash controller.
// Two slave groups share one spimemio instance:
//   - i_wb_*  : XIP memory window (read-only; writes ack + drop)
//   - i_cfg_* : spimemio cfgreg (single word)
// Mirrors the picosoc handshake: XIP read holds spimemio.valid until
// spimemio.ready, then acks with rdata.

`timescale 1ns / 1ps
`default_nettype none

module wb_spiflash (
	input wire clk,
	input wire rst_n,

	// XIP window
	input  wire        i_wb_cyc,
	input  wire        i_wb_stb,
	input  wire        i_wb_we,
	input  wire [31:0] i_wb_adr,
	input  wire [31:0] i_wb_dat,
	input  wire [3:0]  i_wb_sel,
	output reg         o_wb_ack,
	output reg  [31:0] o_wb_dat,

	// cfgreg window
	input  wire        i_cfg_cyc,
	input  wire        i_cfg_stb,
	input  wire        i_cfg_we,
	input  wire [31:0] i_cfg_adr,
	input  wire [31:0] i_cfg_dat,
	input  wire [3:0]  i_cfg_sel,
	output reg         o_cfg_ack,
	output wire [31:0] o_cfg_dat,

	// QSPI flash pins
	output wire flash_csb,
	output wire flash_clk,
	output wire flash_io0_oe,
	output wire flash_io1_oe,
	output wire flash_io2_oe,
	output wire flash_io3_oe,
	output wire flash_io0_do,
	output wire flash_io1_do,
	output wire flash_io2_do,
	output wire flash_io3_do,
	input  wire flash_io0_di,
	input  wire flash_io1_di,
	input  wire flash_io2_di,
	input  wire flash_io3_di
);

	reg         xip_valid;
	wire        xip_ready;
	wire [31:0] xip_rdata;

	// XIP: issue spimemio access on strobe, ack when the flash read completes
	always @(posedge clk) begin
		if (!rst_n) begin
			xip_valid <= 1'b0;
			o_wb_ack  <= 1'b0;
			o_wb_dat <= 32'h0;
		end else begin
			o_wb_ack <= 1'b0;
			if (xip_valid && xip_ready) begin
				xip_valid <= 1'b0;
				o_wb_ack  <= 1'b1;
				o_wb_dat <= xip_rdata;
			end else if (i_wb_cyc && i_wb_stb && !xip_valid && !o_wb_ack) begin
				if (i_wb_we) begin
					// Read-only window: drop the write, ack immediately
					o_wb_ack <= 1'b1;
				end else begin
					xip_valid <= 1'b1;
				end
			end
		end
	end

	// cfgreg: single-cycle write / combinational read data
	always @(posedge clk) begin
		if (!rst_n)
			o_cfg_ack <= 1'b0;
		else
			o_cfg_ack <= i_cfg_cyc & i_cfg_stb & ~o_cfg_ack;
	end

	spimemio spimemio_i (
		.clk    (clk),
		.resetn (rst_n),
		.valid  (xip_valid),
		.ready  (xip_ready),
		.addr   (i_wb_adr[23:0]),
		.rdata  (xip_rdata),

		.flash_csb    (flash_csb),
		.flash_clk    (flash_clk),
		.flash_io0_oe (flash_io0_oe),
		.flash_io1_oe (flash_io1_oe),
		.flash_io2_oe (flash_io2_oe),
		.flash_io3_oe (flash_io3_oe),
		.flash_io0_do (flash_io0_do),
		.flash_io1_do (flash_io1_do),
		.flash_io2_do (flash_io2_do),
		.flash_io3_do (flash_io3_do),
		.flash_io0_di (flash_io0_di),
		.flash_io1_di (flash_io1_di),
		.flash_io2_di (flash_io2_di),
		.flash_io3_di (flash_io3_di),

		.cfgreg_we (o_cfg_ack & i_cfg_we ? i_cfg_sel : 4'b0000),
		.cfgreg_di (i_cfg_dat),
		.cfgreg_do (o_cfg_dat)
	);

endmodule

`default_nettype wire
