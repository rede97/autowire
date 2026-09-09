// SPDX-License-Identifier: MIT
// Thin Verilator top: soc_top + spiflash_vl (no inout Z / # delays).
`timescale 1ns / 1ps
module tb_soc_vl (
	input  wire        clk,
	input  wire        rst_ni,
	output wire        trap,
	output wire        test_valid,
	output wire [31:0] test_data,
	output wire        sd0_cs_n,
	output wire        sd0_sck,
	output wire        sd0_mosi,
	input  wire        sd0_miso,
	input  wire        sd0_cd
);

	wire flash_csb, flash_clk;
	wire flash_io0_oe, flash_io1_oe, flash_io2_oe, flash_io3_oe;
	wire flash_io0_do, flash_io1_do, flash_io2_do, flash_io3_do;
	wire flash_io0_di, flash_io1_di, flash_io2_di, flash_io3_di;
	wire fl_io0_oe, fl_io1_oe, fl_io2_oe, fl_io3_oe;
	wire fl_io0_do, fl_io1_do, fl_io2_do, fl_io3_do;
	wire ser_tx;

	// Resolved pads: DUT OE wins, else flash OE, else pull-up.
	wire pad0 = flash_io0_oe ? flash_io0_do : (fl_io0_oe ? fl_io0_do : 1'b1);
	wire pad1 = flash_io1_oe ? flash_io1_do : (fl_io1_oe ? fl_io1_do : 1'b1);
	wire pad2 = flash_io2_oe ? flash_io2_do : (fl_io2_oe ? fl_io2_do : 1'b1);
	wire pad3 = flash_io3_oe ? flash_io3_do : (fl_io3_oe ? fl_io3_do : 1'b1);

	assign flash_io0_di = pad0;
	assign flash_io1_di = pad1;
	assign flash_io2_di = pad2;
	assign flash_io3_di = pad3;

	soc_top u_dut (
		.clk(clk),
		.rst_ni(rst_ni),
		.trap(trap),
		.ser_tx(ser_tx),
		.ser_rx(1'b1),
		.flash_csb(flash_csb),
		.flash_clk(flash_clk),
		.flash_io0_oe(flash_io0_oe),
		.flash_io1_oe(flash_io1_oe),
		.flash_io2_oe(flash_io2_oe),
		.flash_io3_oe(flash_io3_oe),
		.flash_io0_do(flash_io0_do),
		.flash_io1_do(flash_io1_do),
		.flash_io2_do(flash_io2_do),
		.flash_io3_do(flash_io3_do),
		.flash_io0_di(flash_io0_di),
		.flash_io1_di(flash_io1_di),
		.flash_io2_di(flash_io2_di),
		.flash_io3_di(flash_io3_di),
		.sd0_cs_n(sd0_cs_n),
		.sd0_sck(sd0_sck),
		.sd0_mosi(sd0_mosi),
		.sd0_miso(sd0_miso),
		.sd0_cd(sd0_cd),
		.sd1_cs_n(),
		.sd1_sck(),
		.sd1_mosi(),
		.sd1_miso(1'b1),
		.sd1_cd(1'b1),
		.test_valid(test_valid),
		.test_data(test_data)
	);

	spiflash_vl flash (
		.csb(flash_csb),
		.clk(flash_clk),
		.io0_di(pad0),
		.io1_di(pad1),
		.io2_di(pad2),
		.io3_di(pad3),
		.io0_do(fl_io0_do),
		.io1_do(fl_io1_do),
		.io2_do(fl_io2_do),
		.io3_do(fl_io3_do),
		.io0_oe(fl_io0_oe),
		.io1_oe(fl_io1_oe),
		.io2_oe(fl_io2_oe),
		.io3_oe(fl_io3_oe)
	);

endmodule
