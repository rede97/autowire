// Testbench for mb_system (test/wishbone-master.test.ts): cpu (fabric WB),
// host (APB + wb_cdc), dbg (JTAG TDR + wb_cdc), wbx (WB + wb_cdc) share one
// TB memory slave. Prints PASS on success; any mismatch prints FAIL.

`timescale 1ns/1ps

module tb;
	localparam int W = 2 + 16 + 32;

	logic        clk = 0, rst_n = 0, rb_grant_en = 1;
	logic        host_pclk = 0, host_presetn = 0;
	logic        dbg_tck = 0, dbg_trst_n = 0;
	logic        wbx_clk = 0, wbx_rst_n = 0;

	always #5  clk       = ~clk;
	always #7  host_pclk = ~host_pclk;
	always #25 dbg_tck   = ~dbg_tck;
	always #3  wbx_clk   = ~wbx_clk;

	logic [15:0] cpu_o_wb_adr = 0;
	logic [31:0] cpu_o_wb_dat = 0;
	logic [3:0]  cpu_o_wb_sel = 0;
	logic        cpu_o_wb_cyc = 0, cpu_o_wb_stb = 0, cpu_o_wb_we = 0;
	logic [31:0] cpu_i_wb_dat;
	logic        cpu_i_wb_ack;

	logic [15:0] mem_i_wb_adr;
	logic [31:0] mem_i_wb_dat;
	logic [3:0]  mem_i_wb_sel;
	logic        mem_i_wb_cyc, mem_i_wb_stb, mem_i_wb_we;
	logic [31:0] mem_o_wb_dat;
	logic        mem_o_wb_ack;

	logic [15:0] host_paddr = 0;
	logic        host_psel = 0, host_penable = 0, host_pwrite = 0;
	logic [31:0] host_pwdata = 0;
	logic [3:0]  host_pstrb = 0;
	logic [2:0]  host_pprot = 0;
	logic [31:0] host_prdata;
	logic        host_pready, host_pslverr;

	logic        dbg_sel = 0, dbg_capture_dr = 0, dbg_shift_dr = 0, dbg_update_dr = 0;
	logic        dbg_tdi = 0, dbg_en = 1;
	logic        dbg_tdo;

	logic [15:0] wbx_o_wb_adr = 0;
	logic [31:0] wbx_o_wb_dat = 0;
	logic [3:0]  wbx_o_wb_sel = 0;
	logic        wbx_o_wb_cyc = 0, wbx_o_wb_stb = 0, wbx_o_wb_we = 0;
	logic [31:0] wbx_i_wb_dat;
	logic        wbx_i_wb_ack, wbx_i_wb_err;

	mb_system u_dut (.*);

	//--------------------------------------------------------------------------
	//  TB memory slave (fabric clk); mem_stall holds ACK low
	//--------------------------------------------------------------------------
	logic [31:0] mem [0:1023];
	logic        mem_stall = 0;
	logic [31:0] bmask;
	assign bmask = {{8{mem_i_wb_sel[3]}}, {8{mem_i_wb_sel[2]}},
	                {8{mem_i_wb_sel[1]}}, {8{mem_i_wb_sel[0]}}};

	always @(posedge clk or negedge rst_n) begin
		if (!rst_n) begin
			mem_o_wb_ack <= 1'b0;
			mem_o_wb_dat <= 32'd0;
		end else begin
			mem_o_wb_ack <= 1'b0;
			if (mem_i_wb_cyc && mem_i_wb_stb && !mem_o_wb_ack && !mem_stall) begin
				mem_o_wb_ack <= 1'b1;
				mem_o_wb_dat <= mem[mem_i_wb_adr[11:2]];
				if (mem_i_wb_we)
					mem[mem_i_wb_adr[11:2]] <= (mem[mem_i_wb_adr[11:2]] & ~bmask) | (mem_i_wb_dat & bmask);
			end
		end
	end

	int errors = 0;

	task automatic check(input string what, input logic [31:0] got, input logic [31:0] exp);
		if (got !== exp) begin
			$display("FAIL %s: got %h expected %h", what, got, exp);
			errors++;
		end
	endtask

	//--------------------------------------------------------------------------
	//  Master BFMs
	//--------------------------------------------------------------------------
	task automatic cpu_xfer(input logic wr, input logic [15:0] a, input logic [31:0] d,
	                        output logic [31:0] rd);
		@(posedge clk); #1;
		cpu_o_wb_cyc = 1; cpu_o_wb_stb = 1; cpu_o_wb_we = wr;
		cpu_o_wb_adr = a; cpu_o_wb_dat = d; cpu_o_wb_sel = 4'hf;
		@(posedge clk); #1;
		while (!cpu_i_wb_ack) begin @(posedge clk); #1; end
		rd = cpu_i_wb_dat;
		cpu_o_wb_cyc = 0; cpu_o_wb_stb = 0;
	endtask

	task automatic wbx_xfer(input logic wr, input logic [15:0] a, input logic [31:0] d,
	                        output logic [31:0] rd, output logic err);
		@(posedge wbx_clk); #1;
		wbx_o_wb_cyc = 1; wbx_o_wb_stb = 1; wbx_o_wb_we = wr;
		wbx_o_wb_adr = a; wbx_o_wb_dat = d; wbx_o_wb_sel = 4'hf;
		@(posedge wbx_clk); #1;
		while (!wbx_i_wb_ack && !wbx_i_wb_err) begin @(posedge wbx_clk); #1; end
		rd = wbx_i_wb_dat; err = wbx_i_wb_err;
		wbx_o_wb_cyc = 0; wbx_o_wb_stb = 0;
	endtask

	task automatic apb_xfer(input logic wr, input logic [15:0] a, input logic [31:0] d,
	                        input logic [3:0] strb, input logic [2:0] prot,
	                        output logic [31:0] rd, output logic err);
		@(posedge host_pclk); #1;
		host_psel = 1; host_penable = 0; host_pwrite = wr; host_paddr = a;
		host_pwdata = d; host_pstrb = wr ? strb : 4'h0; host_pprot = prot;
		@(posedge host_pclk); #1;
		host_penable = 1;
		@(posedge host_pclk); #1;
		while (!host_pready) begin @(posedge host_pclk); #1; end
		rd = host_prdata; err = host_pslverr;
		host_psel = 0; host_penable = 0;
	endtask

	// One DR scan: Capture-DR, W x Shift-DR, Update-DR (TAP-client view).
	task automatic jtag_scan(input logic [W-1:0] din, output logic [W-1:0] dout);
		@(negedge dbg_tck);
		dbg_sel = 1; dbg_capture_dr = 1;
		@(negedge dbg_tck);
		dbg_capture_dr = 0; dbg_shift_dr = 1;
		for (int i = 0; i < W; i++) begin
			dbg_tdi = din[i];
			dout[i] = dbg_tdo;
			@(negedge dbg_tck);
		end
		dbg_shift_dr = 0; dbg_update_dr = 1;
		@(negedge dbg_tck);
		dbg_update_dr = 0; dbg_sel = 0;
	endtask

	task automatic jtag_idle(input int n);
		repeat (n) @(negedge dbg_tck);
	endtask

	function automatic logic [W-1:0] dr(input logic [1:0] op, input logic [15:0] a,
	                                    input logic [31:0] d);
		return {op, a, d};
	endfunction

	task automatic jtag_op(input logic [1:0] op, input logic [15:0] a, input logic [31:0] d,
	                       output logic [1:0] st, output logic [31:0] rdat);
		logic [W-1:0] o;
		jtag_scan(dr(op, a, d), o);
		jtag_idle(16);
		jtag_scan(dr(2'd0, 16'd0, 32'd0), o);
		st = o[W-1 -: 2]; rdat = o[31:0];
	endtask

	//--------------------------------------------------------------------------
	//  Sequence
	//--------------------------------------------------------------------------
	logic [31:0] rd;
	logic        err;
	logic [1:0]  st;
	logic [W-1:0] o;

	initial begin
		for (int i = 0; i < 1024; i++) mem[i] = 32'd0;
		#100;
		rst_n = 1; host_presetn = 1; dbg_trst_n = 1; wbx_rst_n = 1;
		#200;

		// Same-clock master still works.
		cpu_xfer(1, 16'h0010, 32'h1111_0010, rd);
		cpu_xfer(0, 16'h0010, 32'h0, rd);
		check("cpu read", rd, 32'h1111_0010);

		// APB through wb_cdc: write, byte-strobe write, read.
		apb_xfer(1, 16'h0020, 32'hA5A5_0020, 4'hf, 3'b000, rd, err);
		check("apb write err", err, 0);
		apb_xfer(1, 16'h0020, 32'h0000_00EE, 4'h1, 3'b000, rd, err);
		apb_xfer(0, 16'h0020, 32'h0, 4'h0, 3'b000, rd, err);
		check("apb read", rd, 32'hA5A5_00EE);
		check("apb read err", err, 0);

		// PPROT filter mismatch completes with PSLVERR (trunk hung here).
		apb_xfer(1, 16'h0020, 32'hDEAD_BEEF, 4'hf, 3'b001, rd, err);
		check("apb pprot err", err, 1);
		check("apb pprot no write", mem[8], 32'hA5A5_00EE);

		// Async WB master.
		wbx_xfer(1, 16'h0030, 32'h3030_3030, rd, err);
		wbx_xfer(0, 16'h0030, 32'h0, rd, err);
		check("wbx read", rd, 32'h3030_3030);
		check("wbx err", err, 0);

		// JTAG TDR: write then read, status ok.
		jtag_op(2'd2, 16'h0040, 32'h4040_CAFE, st, rd);
		check("jtag write st", st, 0);
		check("jtag write mem", mem[16], 32'h4040_CAFE);
		jtag_op(2'd1, 16'h0040, 32'h0, st, rd);
		check("jtag read st", st, 0);
		check("jtag read", rd, 32'h4040_CAFE);

		// JTAG busy / dropped op / sticky err / clear.
		mem_stall = 1;
		jtag_scan(dr(2'd1, 16'h0040, 32'h0), o);
		jtag_scan(dr(2'd2, 16'h0044, 32'h1234_5678), o);
		check("jtag busy st", o[W-1 -: 2], 2'd1);
		mem_stall = 0;
		jtag_idle(16);
		jtag_scan(dr(2'd0, 16'h0, 32'h0), o);
		check("jtag sticky err", o[W-1 -: 2], 2'd2);
		check("jtag dropped write", mem[17], 32'h0);
		jtag_scan(dr(2'd0, 16'h0, 32'h0), o);
		check("jtag err cleared", o[W-1 -: 2], 2'd0);

		// JTAG en=0 (lifecycle / DFT test mode): every op errors.
		dbg_en = 0;
		jtag_idle(4);
		jtag_op(2'd2, 16'h0048, 32'hBAD0_BAD0, st, rd);
		check("jtag en=0 st", st, 2'd2);
		check("jtag en=0 no write", mem[18], 32'h0);
		dbg_en = 1;
		jtag_idle(4);
		jtag_scan(dr(2'd0, 16'h0, 32'h0), o);

		// Stalled leaf: APB aborts with PSLVERR after TIMEOUT, then recovers.
		mem_stall = 1;
		apb_xfer(0, 16'h0020, 32'h0, 4'h0, 3'b000, rd, err);
		check("apb timeout err", err, 1);
		mem_stall = 0;
		repeat (20) @(posedge host_pclk);
		apb_xfer(0, 16'h0020, 32'h0, 4'h0, 3'b000, rd, err);
		check("apb after timeout", rd, 32'hA5A5_00EE);
		check("apb after timeout err", err, 0);

		// Fabric in reset: bridged masters get errors at once, never hang.
		rst_n = 0;
		repeat (5) @(posedge host_pclk);
		apb_xfer(0, 16'h0020, 32'h0, 4'h0, 3'b000, rd, err);
		check("apb fabric reset err", err, 1);
		wbx_xfer(0, 16'h0030, 32'h0, rd, err);
		check("wbx fabric reset err", err, 1);
		jtag_op(2'd1, 16'h0040, 32'h0, st, rd);
		check("jtag fabric reset st", st, 2'd2);
		jtag_scan(dr(2'd0, 16'h0, 32'h0), o);
		rst_n = 1;
		repeat (10) @(posedge host_pclk);
		apb_xfer(0, 16'h0020, 32'h0, 4'h0, 3'b000, rd, err);
		check("apb after fabric reset", rd, 32'hA5A5_00EE);

		// All four masters at once through the arbiter.
		fork
			begin : par_cpu
				logic [31:0] r;
				for (int i = 0; i < 8; i++) cpu_xfer(1, 16'h0100 + 16'(i * 4), 32'hC000_0000 + i, r);
			end
			begin : par_apb
				logic [31:0] r; logic e;
				for (int i = 0; i < 8; i++) apb_xfer(1, 16'h0200 + 16'(i * 4), 32'hA000_0000 + i, 4'hf, 3'b000, r, e);
			end
			begin : par_wbx
				logic [31:0] r; logic e;
				for (int i = 0; i < 8; i++) wbx_xfer(1, 16'h0300 + 16'(i * 4), 32'hB000_0000 + i, r, e);
			end
			begin : par_jtag
				logic [1:0] s; logic [31:0] r;
				for (int i = 0; i < 2; i++) jtag_op(2'd2, 16'h0400 + 16'(i * 4), 32'hD000_0000 + i, s, r);
			end
		join
		for (int i = 0; i < 8; i++) begin
			check("par cpu", mem[64 + i], 32'hC000_0000 + i);
			check("par apb", mem[128 + i], 32'hA000_0000 + i);
			check("par wbx", mem[192 + i], 32'hB000_0000 + i);
		end
		for (int i = 0; i < 2; i++) check("par jtag", mem[256 + i], 32'hD000_0000 + i);

		if (errors == 0) $display("PASS");
		else $display("FAIL %0d errors", errors);
		$finish;
	end

	initial begin
		#2_000_000;
		$display("FAIL timeout");
		$finish;
	end
endmodule
