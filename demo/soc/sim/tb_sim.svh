// SPDX-License-Identifier: MIT
// Body-post include for tb_soc: flash model + smoke checker (was tb_soc_smoke.v).

spiflash flash (
	.csb(flash_csb),
	.clk(flash_clk),
	.io0(flash_io0),
	.io1(flash_io1),
	.io2(flash_io2),
	.io3(flash_io3)
);

integer test_count = 0;
always @(posedge clk) begin
	if (rst_ni && test_valid) begin
		$display("testout: %08x", test_data);
		if (test_count == 0 && test_data !== 32'h00000001) begin
			$display("FAIL: alive marker %08x", test_data);
			$finish;
		end
		if (test_data === 32'hdead0001) begin
			$display("FAIL: sha256 digest mismatch");
			$display("actual: %08x %08x %08x %08x %08x %08x %08x %08x",
				u_dut.u_sha_9.u_regs.i_hash0, u_dut.u_sha_9.u_regs.i_hash1,
				u_dut.u_sha_9.u_regs.i_hash2, u_dut.u_sha_9.u_regs.i_hash3,
				u_dut.u_sha_9.u_regs.i_hash4, u_dut.u_sha_9.u_regs.i_hash5,
				u_dut.u_sha_9.u_regs.i_hash6, u_dut.u_sha_9.u_regs.i_hash7);
			$display("sram: %08x %08x %08x %08x %08x %08x %08x %08x",
				u_dut.u_ram_0.mem[64], u_dut.u_ram_0.mem[65],
				u_dut.u_ram_0.mem[66], u_dut.u_ram_0.mem[67],
				u_dut.u_ram_0.mem[68], u_dut.u_ram_0.mem[69],
				u_dut.u_ram_0.mem[70], u_dut.u_ram_0.mem[71]);
			$finish;
		end
		if (test_data === 32'h600d600d) begin
			$display("SMOKE PASS: cpu boot + sram copy + dma -> axis -> sha256 digest ok");
			$finish;
		end
		test_count = test_count + 1;
	end
	if (rst_ni && trap) begin
		$display("FAIL: cpu trap");
		$finish;
	end
end

initial begin
	#100000000;
	$display("FAIL: timeout (test_count=%0d)", test_count);
	$finish;
end
