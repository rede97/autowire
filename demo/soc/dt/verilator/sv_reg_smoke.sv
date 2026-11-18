// Smoke test for the generated sv_reg packages (plugin wishbone `sv_reg=`).
// Non-UVM, no bus RTL: it drives a register word purely through the field
// bit/mask localparams and checks the bus address-map localparams. This is the
// whole point of the package+localparam export — quick checks in a plain
// simulator env. Build with --binary and +incdir+<dv/sv_reg>; run the binary.
`include "soc_pkg.sv"

module sv_reg_smoke;
	import sha256_pkg::*;
	import smoke_pkg::*;

	logic [31:0] cfg;
	logic [31:0] expect_mask;

	initial begin
		// 1. Field geometry: MASK == (width ones) << LSB.
		expect_mask = ((32'd1 << CFG_MODE_WIDTH) - 32'd1) << CFG_MODE_LSB;
		if (CFG_MODE_MASK !== expect_mask)
			$fatal(1, "CFG_MODE mask/width/lsb inconsistent: %08h", CFG_MODE_MASK);

		// 2. Read-modify-write two fields using only the package constants.
		cfg = '0;
		cfg = (cfg & ~CFG_MODE_MASK)   | ((32'd5 << CFG_MODE_LSB)   & CFG_MODE_MASK);
		cfg = (cfg & ~CFG_ENABLE_MASK) | ((32'd1 << CFG_ENABLE_LSB) & CFG_ENABLE_MASK);
		if (((cfg & CFG_MODE_MASK) >> CFG_MODE_LSB) !== 32'd5)
			$fatal(1, "CFG_MODE readback wrong: %08h", cfg);
		if (((cfg & CFG_ENABLE_MASK) >> CFG_ENABLE_LSB) !== 32'd1)
			$fatal(1, "CFG_ENABLE readback wrong: %08h", cfg);

		// 3. Reset constants (shadow dict collapses to copy 0).
		if (CFG_MODE_RESET !== 32'h0000_0001) $fatal(1, "CFG_MODE reset");
		if (ID_MAGIC_RESET !== 32'h0000_a55a) $fatal(1, "ID_MAGIC reset");
		if (BANK_CFG_RESET !== 32'h0000_0010) $fatal(1, "BANK_CFG reset (copy 0)");

		// 4. sha256 CTRL fields must not overlap.
		if ((CTRL_SOFT_RESET_MASK & CTRL_DONE_MASK) !== 32'h0)
			$fatal(1, "sha256 CTRL fields overlap");

		// 5. Address map: absolute = BASE + OFFSET, including a TagFromAddr bank alias.
		if (soc_wb_map_pkg::CH0_BANK1_SHA256_HASH3 !== 32'h0700_0050)
			$fatal(1, "CH0_BANK1_SHA256_HASH3 abs addr: %08h",
				soc_wb_map_pkg::CH0_BANK1_SHA256_HASH3);
		if (soc_wb_map_pkg::SMOKE_BANK0_CFG !==
				(soc_wb_map_pkg::SMOKE_BANK0_BASE + soc_wb_map_pkg::SMOKE_CFG_OFFSET))
			$fatal(1, "SMOKE_BANK0_CFG abs addr");
		if (sd_sha_map_pkg::SHA256_HASH3 !== 32'h0000_0050)
			$fatal(1, "sd_sha SHA256_HASH3 relative addr");

		$display("[sv_reg_smoke] cfg=%08h ctrl_soft_reset_mask=%08h ch0_bank1_hash3=%08h",
			cfg, CTRL_SOFT_RESET_MASK, soc_wb_map_pkg::CH0_BANK1_SHA256_HASH3);
		$display("SV_REG SMOKE PASS");
		$finish;
	end
endmodule
