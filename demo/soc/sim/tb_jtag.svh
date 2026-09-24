// SPDX-License-Identifier: MIT
// External JTAG host for tb_soc (included from tb_sim.svh; Verilator
// --timing runs the # delays). Pure-SV twin of sim/verilator/jtag_host.h. Drives the
// soc_top jtag_* pins at 10 MHz while the CPU firmware runs, so both masters
// share the soc_wb arbiter. Sequence: IDCODE after TLR, BYPASS 1-bit delay,
// USER DR reads smoke ID, writes + reads back an SRAM word the firmware
// does not use. Sets jtag_done on success; any mismatch prints FAIL.
//
// USER DR (66 bit, LSB first): shift {op[1:0], adr[31:0], dat[31:0]},
// capture {st[1:0], adr, rdat}; op 1 read / 2 write; st 0 ok / 1 busy / 2 err.

localparam integer  JTAG_HALF      = 50;
localparam [3:0]    JTAG_IR_USER   = 4'b1000;
localparam [3:0]    JTAG_IR_BYPASS = 4'b1111;
localparam [31:0]   JTAG_IDCODE    = 32'h1a57_0001;
localparam integer  JTAG_DRW       = 66;
localparam [31:0]   JTAG_SMOKE_ID  = 32'h0001_a55a;
localparam [31:0]   JTAG_SRAM_ADR  = 32'h0000_8000;
localparam [31:0]   JTAG_SRAM_DAT  = 32'hc0de_7a90;

reg jtag_done = 1'b0;

initial begin
	jtag_tck    = 1'b0;
	jtag_tms    = 1'b1;
	jtag_tdi    = 1'b0;
	jtag_trst_n = 1'b0;
end

// One TCK: TMS/TDI set on the low phase, TDO sampled just before the rise.
task jtag_clk(input tms, input tdi, output tdo);
	begin
		jtag_tms = tms;
		jtag_tdi = tdi;
		#JTAG_HALF;
		tdo = jtag_tdo;
		jtag_tck = 1'b1;
		#JTAG_HALF;
		jtag_tck = 1'b0;
	end
endtask

task jtag_idle(input integer n);
	integer i;
	reg b;
	begin
		for (i = 0; i < n; i = i + 1) jtag_clk(1'b0, 1'b0, b);
	end
endtask

// Run-Test/Idle → Shift-xR → n bits → Update-xR → Run-Test/Idle.
task jtag_shift(input ir_path, input [127:0] din, input integer n, output [127:0] dout);
	integer i;
	reg b;
	begin
		dout = 128'd0;
		jtag_clk(1'b1, 1'b0, b);                  // Select-DR
		if (ir_path) jtag_clk(1'b1, 1'b0, b);     // Select-IR
		jtag_clk(1'b0, 1'b0, b);                  // Capture
		jtag_clk(1'b0, 1'b0, b);                  // Shift
		for (i = 0; i < n; i = i + 1) begin
			jtag_clk(i == n - 1, din[i], b);      // last bit exits to Exit1
			dout[i] = b;
		end
		jtag_clk(1'b1, 1'b0, b);                  // Update
		jtag_clk(1'b0, 1'b0, b);                  // Run-Test/Idle
	end
endtask

task jtag_fail(input [8*48-1:0] what, input [31:0] got, input [31:0] exp);
	begin
		$fatal(1, "FAIL: jtag %0s got %08x expected %08x", what, got, exp);
	end
endtask

// Launch one WB access on the USER TDR, then poll status with nop scans.
task jtag_wb(input [1:0] op, input [31:0] adr, input [31:0] dat,
             output [1:0] st, output [31:0] rdat);
	integer tries;
	reg [127:0] o;
	begin
		jtag_shift(1'b0, {62'd0, op, adr, dat}, JTAG_DRW, o);
		st = 2'd1;
		for (tries = 0; tries < 64 && st == 2'd1; tries = tries + 1) begin
			jtag_idle(16);
			jtag_shift(1'b0, 128'd0, JTAG_DRW, o);
			st   = o[65:64];
			rdat = o[31:0];
		end
	end
endtask

initial begin : jtag_smoke
	reg [127:0] o;
	reg [1:0]   st;
	reg [31:0]  rd;
	reg         b;
	@(posedge rst_ni);
	repeat (20) @(posedge clk);
	jtag_trst_n = 1'b1;
	repeat (5) jtag_clk(1'b1, 1'b0, b);           // Test-Logic-Reset
	jtag_clk(1'b0, 1'b0, b);                      // Run-Test/Idle

	jtag_shift(1'b0, 128'd0, 32, o);
	if (o[31:0] !== JTAG_IDCODE) jtag_fail("IDCODE", o[31:0], JTAG_IDCODE);

	jtag_shift(1'b1, {124'd0, JTAG_IR_BYPASS}, 4, o);
	if (o[1:0] !== 2'b01) jtag_fail("IR capture", {28'd0, o[3:0]}, 32'h1);
	jtag_shift(1'b0, {120'd0, 8'hb5}, 9, o);
	if (o[8:0] !== {8'hb5, 1'b0}) jtag_fail("BYPASS", {23'd0, o[8:0]}, {23'd0, 8'hb5, 1'b0});

	jtag_shift(1'b1, {124'd0, JTAG_IR_USER}, 4, o);

	jtag_wb(2'd1, 32'h0300_6000, 32'd0, st, rd);
	if (st !== 2'd0) jtag_fail("smoke ID status", {30'd0, st}, 32'd0);
	if (rd !== JTAG_SMOKE_ID) jtag_fail("smoke ID", rd, JTAG_SMOKE_ID);

	jtag_wb(2'd2, JTAG_SRAM_ADR, JTAG_SRAM_DAT, st, rd);
	if (st !== 2'd0) jtag_fail("SRAM write status", {30'd0, st}, 32'd0);
	jtag_wb(2'd1, JTAG_SRAM_ADR, 32'd0, st, rd);
	if (st !== 2'd0) jtag_fail("SRAM read status", {30'd0, st}, 32'd0);
	if (rd !== JTAG_SRAM_DAT) jtag_fail("SRAM readback", rd, JTAG_SRAM_DAT);

	$display("JTAG SMOKE PASS: IDCODE %08x, BYPASS, smoke ID %08x, SRAM[%08x] = %08x",
		JTAG_IDCODE, JTAG_SMOKE_ID, JTAG_SRAM_ADR, rd);
	jtag_done = 1'b1;
end
