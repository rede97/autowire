// SPDX-License-Identifier: MIT
// Body-post include for tb_soc: flash model + smoke checker.
// Runner: sim/verilator/run.sh --tb-mod (Verilator --binary --timing,
// firmware fw/basic_smoke). PASS needs both the firmware marker (0x600d600d)
// and the external JTAG smoke (tb_jtag.svh) running concurrently through the
// fabric arbiter.

`include "tb_jtag.svh"

spiflash_vl flash (
	.csb(flash_csb),
	.clk(flash_clk),
	.io0_di(flash_io0),
	.io1_di(flash_io1),
	.io2_di(flash_io2),
	.io3_di(flash_io3),
	.io0_do(fl_io0_do),
	.io1_do(fl_io1_do),
	.io2_do(fl_io2_do),
	.io3_do(fl_io3_do),
	.io0_oe(fl_io0_oe),
	.io1_oe(fl_io1_oe),
	.io2_oe(fl_io2_oe),
	.io3_oe(fl_io3_oe)
);

integer test_count = 0;
reg     fw_done = 1'b0;
always @(posedge clk) begin
	if (rst_ni && test_valid) begin
		$display("testout: %08x", test_data);
		if (test_count == 0 && test_data !== 32'h00000001)
			$fatal(1, "FAIL: alive marker %08x", test_data);
		if (test_data === 32'hdead0001)
			$fatal(1, "FAIL: firmware reported failure");
		if (test_data === 32'h600d600d) begin
			$display("firmware done (jtag_done=%0d)", jtag_done);
			fw_done <= 1'b1;
		end
		test_count <= test_count + 1;
	end
	if (fw_done && jtag_done) begin
		$display("SMOKE PASS: tb_soc (aw-tb-mod) cpu firmware + external JTAG");
		$finish;
	end
	if (rst_ni && trap)
		$fatal(1, "FAIL: cpu trap");
end

initial begin
	#200000000;
	$fatal(1, "FAIL: timeout (test_count=%0d fw_done=%0d jtag_done=%0d)",
		test_count, fw_done, jtag_done);
end
