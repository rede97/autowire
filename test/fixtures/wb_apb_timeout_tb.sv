// wb_apb2wb TIMEOUT in front of wb_cdc: PSLVERR on a stuck target, late
// responses drained, backpressured writes never enqueued after timeout.
`timescale 1ns/1ps
module tb #(parameter int HALF = 3, parameter int TIMEOUT = 64);
	logic pclk = 0, clk = 0, t_run = 1;
	logic presetn = 0, rst_n = 0;
	always #5 pclk = ~pclk;
	always #HALF if (t_run) clk = ~clk;

	logic psel = 0, penable = 0, pwrite = 0;
	logic [7:0] paddr = 0;
	logic [31:0] pwdata = 0, prdata;
	logic pready, pslverr;
	logic cyc, stb, we, ack, err;
	logic [7:0] adr;
	logic [31:0] wdat, rdat;
	logic [3:0] sel;
	logic mc, ms, mw, ma;
	logic [7:0] maddr;
	logic [31:0] md, response;
	logic [3:0] msel;
	logic mtag;

	wb_apb2wb #(.AW(8), .TIMEOUT(TIMEOUT)) bridge (
		.pclk(pclk), .presetn(presetn), .paddr(paddr), .psel(psel),
		.penable(penable), .pwrite(pwrite), .pwdata(pwdata), .pstrb(4'hf),
		.pprot(3'b000), .prdata(prdata), .pready(pready), .pslverr(pslverr),
		.wb_cyc(cyc), .wb_stb(stb), .wb_we(we), .wb_adr(adr), .wb_dat(wdat),
		.wb_sel(sel), .wb_ack(ack), .wb_err(err), .wb_rdat(rdat));
	wb_cdc #(.AW(8), .TW(1)) cdc (
		.s_clk(pclk), .s_rst_n(presetn), .s_cyc(cyc), .s_stb(stb), .s_we(we),
		.s_adr(adr), .s_dat(wdat), .s_sel(sel), .s_tga(1'b0),
		.s_ack(ack), .s_err(err), .s_rdat(rdat), .clk(clk), .rst_n(rst_n),
		.m_cyc(mc), .m_stb(ms), .m_we(mw), .m_adr(maddr), .m_dat(md),
		.m_sel(msel), .m_tga(mtag), .m_ack(ma), .m_rdat(response));

	logic [31:0] memory [0:255];
	int delay = 0, wait_cnt = 0;
	always @(posedge clk or negedge rst_n) begin
		if (!rst_n) begin ma <= 1'b0; wait_cnt <= 0; end
		else begin
			ma <= 1'b0;
			if (mc && ms && !ma) begin
				if (wait_cnt < delay) wait_cnt <= wait_cnt + 1;
				else begin
					wait_cnt <= 0;
					ma <= 1'b1;
					response <= memory[maddr];
					if (mw) memory[maddr] <= md;
				end
			end
		end
	end

	// One APB transfer; returns PSLVERR and the PCLK cycles spent in ACCESS.
	task automatic apb(input logic w, input logic [7:0] a, input logic [31:0] d,
		output logic [31:0] r, output logic e, output int cycles);
		@(negedge pclk); psel = 1; penable = 0; pwrite = w; paddr = a; pwdata = d;
		@(negedge pclk); penable = 1; cycles = 0;
		do begin @(negedge pclk); cycles++; end while (!pready);
		r = prdata; e = pslverr;
		psel = 0; penable = 0;
	endtask

	task automatic ok_write(input logic [7:0] a, input logic [31:0] d);
		logic [31:0] r; logic e; int n;
		apb(1, a, d, r, e, n);
		if (e) $fatal(1, "write %h got PSLVERR", a);
	endtask

	task automatic ok_read(input logic [7:0] a, input logic [31:0] v, input string what);
		logic [31:0] r; logic e; int n;
		apb(0, a, 0, r, e, n);
		if (e || r !== v) $fatal(1, "%s: read %h -> %h err=%0d (expect %h)", what, a, r, e, v);
	endtask

	task automatic timeout_xfer(input logic w, input logic [7:0] a, input string what);
		logic [31:0] r; logic e; int n;
		apb(w, a, 32'hDEAD_0000 | a, r, e, n);
		if (!e) $fatal(1, "%s: no PSLVERR", what);
		if (n < TIMEOUT || n > TIMEOUT + 4)
			$fatal(1, "%s: timed out after %0d cycles (TIMEOUT=%0d)", what, n, TIMEOUT);
		if (r !== 32'd0) $fatal(1, "%s: PRDATA not zero on timeout", what);
	endtask

	initial begin
		for (int i = 0; i < 256; i++) memory[i] = 32'hC0DE_0000 | i;
		repeat (4) @(negedge pclk);
		presetn = 1; rst_n = 1;

		// Slow but live target inside the budget: no error.
		delay = 2;
		ok_write(8'h10, 32'h1010_1010);
		ok_read(8'h10, 32'h1010_1010, "slow target");
		delay = 0;

		// Stuck target: read times out; a second read times out behind it.
		@(negedge clk); t_run = 0;
		timeout_xfer(0, 8'h20, "stuck read");
		timeout_xfer(0, 8'h21, "read behind stuck read");
		t_run = 1;
		// The late 0x20 response is drained; the fresh read gets its own data.
		ok_read(8'h22, 32'hC0DE_0022, "after drained read");

		// Full command FIFO: eight writes post, the ninth times out unqueued.
		@(negedge clk); t_run = 0;
		for (int i = 0; i < 8; i++) ok_write(8'h40 + 8'(i), 32'h4000_0000 + i);
		timeout_xfer(1, 8'h48, "write into full FIFO");
		t_run = 1;
		// A read waits behind the whole queue, which can exceed TIMEOUT: drain first.
		repeat (100) @(negedge clk);
		ok_read(8'h47, 32'h4000_0007, "posted writes after timeout");
		ok_read(8'h48, 32'hC0DE_0048, "timed-out write must not land");

		$display("PASS"); $finish;
	end

	initial begin #200000; $fatal(1, "APB timeout watchdog expired"); end
endmodule
