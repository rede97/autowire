// SPDX-License-Identifier: MIT
// Body-pre include for tb_soc (opaque path; +incdir = sim/).
// Clock / reset + QSPI IO pads. Signals clk/rst_ni/flash_* come from dump.
// Timescale lives in sim/tb_timescale.sv (compile unit; cannot be inside module).

initial clk = 1;
always #5 clk = ~clk;

initial begin
	rst_ni = 0;
	repeat (100) @(posedge clk);
	rst_ni = 1;
end

assign flash_io0 = flash_io0_oe ? flash_io0_do : 1'bz;
assign flash_io1 = flash_io1_oe ? flash_io1_do : 1'bz;
assign flash_io2 = flash_io2_oe ? flash_io2_do : 1'bz;
assign flash_io3 = flash_io3_oe ? flash_io3_do : 1'bz;
