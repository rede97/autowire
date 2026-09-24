// SPDX-License-Identifier: MIT
// Body-post include for tb_soc, listed before tb_sim.svh (opaque path;
// +incdir = sim/). Board clock / reset + QSPI IO pads. Signals
// clk / rst_ni / flash_* come from the dump and are declared above.
// Timescale lives in sim/tb_timescale.sv (compile unit; cannot be inside module).
// No inout Z on the flash model (simulator tristate limits): pads resolve
// DUT OE first, then flash OE, else pull-up (same as sim/verilator/tb_soc_vl.sv).

initial clk = 1;
always #5 clk = ~clk;

initial begin
	rst_ni = 0;
	repeat (100) @(posedge clk);
	rst_ni = 1;
end

wire fl_io0_oe, fl_io1_oe, fl_io2_oe, fl_io3_oe;
wire fl_io0_do, fl_io1_do, fl_io2_do, fl_io3_do;

assign flash_io0 = flash_io0_oe ? flash_io0_do : (fl_io0_oe ? fl_io0_do : 1'b1);
assign flash_io1 = flash_io1_oe ? flash_io1_do : (fl_io1_oe ? fl_io1_do : 1'b1);
assign flash_io2 = flash_io2_oe ? flash_io2_do : (fl_io2_oe ? fl_io2_do : 1'b1);
assign flash_io3 = flash_io3_oe ? flash_io3_do : (fl_io3_oe ? fl_io3_do : 1'b1);
