// wb_cdc one-sided reset, stopped-clock reset and abandoned-read regression.
`timescale 1ns/1ps
module tb #(parameter int HALF = 3);
	logic s_clk = 0, clk = 0, s_run = 1, t_run = 1;
	logic s_rst_n = 0, rst_n = 0;
	always #5 if (s_run) s_clk = ~s_clk;
	always #HALF if (t_run) clk = ~clk;

	logic cyc = 0, we = 0;
	logic [7:0] adr = 0;
	logic [31:0] dat = 0;
	logic ack, err;
	logic [31:0] rdat;
	logic mc, ms, mw, ma;
	logic [7:0] maddr;
	logic [31:0] md, response;
	logic [3:0] msel;
	logic mtag;

	wb_cdc #(.AW(8), .TW(1)) dut (
		.s_clk(s_clk), .s_rst_n(s_rst_n), .s_cyc(cyc), .s_stb(cyc), .s_we(we),
		.s_adr(adr), .s_dat(dat), .s_sel(4'hf), .s_tga(1'b0),
		.s_ack(ack), .s_err(err), .s_rdat(rdat), .clk(clk), .rst_n(rst_n),
		.m_cyc(mc), .m_stb(ms), .m_we(mw), .m_adr(maddr), .m_dat(md),
		.m_sel(msel), .m_tga(mtag), .m_ack(ma), .m_rdat(response));

	// Target: one-cycle ACK unless stalled; memory survives target reset.
	logic [31:0] memory [0:255];
	logic stall = 0, no_beat = 0;
	int beats = 0;
	logic [7:0] last_addr = 0;
	always @(posedge clk or negedge rst_n) begin
		if (!rst_n) ma <= 1'b0;
		else begin
			ma <= 1'b0;
			if (mc && ms && !ma && !stall) begin
				if ($isunknown({mw, maddr, md})) $fatal(1, "X command reached target");
				if (no_beat) $fatal(1, "stale command replayed: we=%0d adr=%h", mw, maddr);
				ma <= 1'b1;
				beats++;
				last_addr <= maddr;
				response <= memory[maddr];
				if (mw) memory[maddr] <= md;
			end
		end
	end

	always @(posedge s_clk) if (ack && err) $fatal(1, "ACK and ERR overlap");

	task automatic wb_write(input logic [7:0] a, input logic [31:0] d);
		@(negedge s_clk); cyc = 1; we = 1; adr = a; dat = d;
		do @(negedge s_clk); while (!(ack || err));
		if (err) $fatal(1, "write %h got ERR", a);
		cyc = 0;
	endtask

	task automatic wb_read(input logic [7:0] a, output logic [31:0] d, output logic e);
		@(negedge s_clk); cyc = 1; we = 0; adr = a;
		do @(negedge s_clk); while (!(ack || err));
		d = rdat; e = err; cyc = 0;
	endtask

	task automatic expect_read(input logic [7:0] a, input logic [31:0] v, input string what);
		logic [31:0] d; logic e;
		wb_read(a, d, e);
		if (e || d !== v) $fatal(1, "%s: read %h -> %h err=%0d (expect %h)", what, a, d, e, v);
	endtask

	// No target beat and no source completion for n target edges.
	task automatic quiet(input int n, input string what);
		if (s_run) @(negedge s_clk); // let a just-sampled ACK pulse retire
		no_beat = 1;
		repeat (n) begin
			@(negedge clk);
			if (ack || err) $fatal(1, "%s: unexpected source completion", what);
		end
		no_beat = 0;
	endtask

	task automatic pulse_target;
		@(negedge clk); rst_n = 0; repeat (3) @(negedge clk); rst_n = 1;
	endtask

	task automatic pulse_source;
		@(negedge s_clk); s_rst_n = 0; cyc = 0; repeat (3) @(negedge s_clk); s_rst_n = 1;
	endtask

	task automatic traffic(input logic [7:0] base);
		for (int i = 0; i < 4; i++) wb_write(base + 8'(i), 32'hA000_0000 | {24'd0, base} + i);
		expect_read(base + 8'd3, 32'hA000_0003 | {24'd0, base}, "traffic");
	endtask

	initial begin
		logic [31:0] d; logic e; int b;
		for (int i = 0; i < 256; i++) memory[i] = 32'hC0DE_0000 | i;
		repeat (4) @(negedge s_clk);
		s_rst_n = 1; rst_n = 1;

		// Idle target-only reset after traffic: no replay, fresh traffic works.
		traffic(8'h10);
		pulse_target(); quiet(60, "target-only reset");
		traffic(8'h20);

		// Idle source-only reset (JTAG TRST): no replay, no X, no stale read data.
		pulse_source(); quiet(60, "source-only reset");
		traffic(8'h30);
		expect_read(8'h31, 32'hA000_0031, "after source reset");

		// Target reset while the source clock is stopped (idle TCK), then resume.
		@(negedge s_clk); s_run = 0;
		pulse_target(); quiet(30, "target reset, source stopped");
		s_run = 1; quiet(60, "source resumed");
		traffic(8'h40);

		// Source reset while the target clock is stopped, then resume.
		@(negedge clk); t_run = 0;
		#3 s_rst_n = 0; #40 s_rst_n = 1; #40;
		t_run = 1; quiet(60, "target resumed");
		traffic(8'h50);

		// Read in flight when the target resets: exactly one ERR, then recovery.
		stall = 1;
		fork wb_read(8'h60, d, e); begin wait(mc); pulse_target(); stall = 0; end join
		if (!e) $fatal(1, "read lost to target reset did not return ERR");
		quiet(40, "after read ERR");
		expect_read(8'h61, 32'hC0DE_0061, "after read ERR");

		// Captured target beat survives a source-only reset; its data is dropped.
		stall = 1;
		@(negedge s_clk); cyc = 1; we = 0; adr = 8'h70;
		wait(mc && maddr == 8'h70);
		pulse_source();
		repeat (20) @(negedge s_clk);
		if (!mc) $fatal(1, "source reset withdrew the target beat");
		b = beats; stall = 0;
		expect_read(8'h71, 32'hC0DE_0071, "after orphaned beat");
		if (beats != b + 2) $fatal(1, "orphaned beat count %0d", beats - b);

		// Abandoned read: the late response must not complete the next request.
		stall = 1;
		@(negedge s_clk); cyc = 1; we = 0; adr = 8'h80;
		wait(mc && maddr == 8'h80);
		@(negedge s_clk); cyc = 0;
		repeat (4) @(negedge s_clk);
		fork expect_read(8'h81, 32'hC0DE_0081, "after abandoned read");
			begin repeat (10) @(negedge clk); stall = 0; end join

		// Requests wait (no ACK/ERR) while the target is held in reset.
		@(negedge clk); rst_n = 0;
		@(negedge s_clk); cyc = 1; we = 1; adr = 8'h90; dat = 32'h9090_9090;
		repeat (40) begin
			@(negedge s_clk);
			if (ack || err) $fatal(1, "request completed during target reset");
		end
		rst_n = 1;
		do @(negedge s_clk); while (!(ack || err));
		if (err) $fatal(1, "write after reset release got ERR");
		cyc = 0;
		expect_read(8'h90, 32'h9090_9090, "after held reset");

		quiet(40, "final");
		$display("PASS"); $finish;
	end

	initial begin #400000; $fatal(1, "CDC reset watchdog expired"); end
endmodule
