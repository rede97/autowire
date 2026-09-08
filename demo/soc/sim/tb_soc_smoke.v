// SPDX-License-Identifier: MIT
//
// tb_soc_smoke.v
//
// Smoke test for the autowire-generated SoC top (gen/soc_top.sv):
// boots the picorv32 from the spiflash model (sim/firmware_smoke.hex,
// regenerate with sim/gen_firmware.py) and drives the full data path:
// flash XIP boot -> SRAM copy -> DMA (Wishbone master) -> AXI4-Stream ->
// sha256 digest check -> built-in test output interface.
//
// Pass marker 0x600d600d on test_data; fail marker 0xdead0001.
// Runner: sim/run_smoke.sh

`timescale 1ns / 1ps

module tb_soc_smoke;

	reg clk = 1;
	reg rst_n = 0;

	always #5 clk = ~clk;

	initial begin
		repeat (100) @(posedge clk);
		rst_n <= 1;
	end

	// QSPI flash model wiring (picosoc testbench style)
	wire flash_csb, flash_clk;
	wire flash_io0_oe, flash_io1_oe, flash_io2_oe, flash_io3_oe;
	wire flash_io0_do, flash_io1_do, flash_io2_do, flash_io3_do;
	wire flash_io0, flash_io1, flash_io2, flash_io3;

	assign flash_io0 = flash_io0_oe ? flash_io0_do : 1'bz;
	assign flash_io1 = flash_io1_oe ? flash_io1_do : 1'bz;
	assign flash_io2 = flash_io2_oe ? flash_io2_do : 1'bz;
	assign flash_io3 = flash_io3_oe ? flash_io3_do : 1'bz;

	wire ser_tx;
	wire test_valid;
	wire [31:0] test_data;
	wire trap;

	soc_top soc (
		.clk(clk),
		.rst_ni(rst_n),
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
		.flash_io0_di(flash_io0),
		.flash_io1_di(flash_io1),
		.flash_io2_di(flash_io2),
		.flash_io3_di(flash_io3),
		.sd0_cs_n(),
		.sd0_sck(),
		.sd0_mosi(),
		.sd0_miso(1'b1),
		.sd0_cd(1'b1),
		.sd1_cs_n(),
		.sd1_sck(),
		.sd1_mosi(),
		.sd1_miso(1'b1),
		.sd1_cd(1'b1),
		.test_valid(test_valid),
		.test_data(test_data)
	);

	spiflash flash (
		.csb(flash_csb),
		.clk(flash_clk),
		.io0(flash_io0),
		.io1(flash_io1),
		.io2(flash_io2),
		.io3(flash_io3)
	);

	// Firmware: alive marker (1), then SHA256 known-answer over DMA ->
	// AXI-Stream -> sha256 lane. Pass marker 0x600d600d, fail 0xdead0001.
	integer test_count = 0;
	always @(posedge clk) begin
		if (rst_n && test_valid) begin
			$display("testout: %08x", test_data);
			if (test_count == 0 && test_data !== 32'h00000001) begin
				$display("FAIL: alive marker %08x", test_data);
				$finish;
			end
			if (test_data === 32'hdead0001) begin
				$display("FAIL: sha256 digest mismatch");
				$display("actual: %08x %08x %08x %08x %08x %08x %08x %08x",
					soc.u_sha_9.u_regs.i_hash0, soc.u_sha_9.u_regs.i_hash1,
					soc.u_sha_9.u_regs.i_hash2, soc.u_sha_9.u_regs.i_hash3,
					soc.u_sha_9.u_regs.i_hash4, soc.u_sha_9.u_regs.i_hash5,
					soc.u_sha_9.u_regs.i_hash6, soc.u_sha_9.u_regs.i_hash7);
				$display("sram: %08x %08x %08x %08x %08x %08x %08x %08x",
					soc.u_ram_0.mem[64], soc.u_ram_0.mem[65],
					soc.u_ram_0.mem[66], soc.u_ram_0.mem[67],
					soc.u_ram_0.mem[68], soc.u_ram_0.mem[69],
					soc.u_ram_0.mem[70], soc.u_ram_0.mem[71]);
				$finish;
			end
			if (test_data === 32'h600d600d) begin
				$display("SMOKE PASS: cpu boot + sram copy + dma -> axis -> sha256 digest ok");
				$finish;
			end
			test_count = test_count + 1;
		end
		if (rst_n && trap) begin
			$display("FAIL: cpu trap");
			$finish;
		end
	end


	initial begin
		#100000000;
		$display("FAIL: timeout (test_count=%0d)", test_count);
		$finish;
	end

endmodule
