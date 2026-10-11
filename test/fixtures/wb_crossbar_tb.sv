// Testbench for xb_crossbar (test/wishbone-crossbar.test.ts).
//
//   master groups: cpu = {cpu_i, cpu_d}      dma = {dma}
//   slave groups:  ctrl = {gpio, uart}       mem = {mem (pipe=1)}
//
// Checks: plain traffic from every master to every slave, unmapped ACK,
// parallel progress across groups while another pair is stalled, mutual
// exclusion inside a master group and inside a slave group, and a mixed
// concurrent burst under fixed and round-robin grant. Prints PASS or FAIL.

`timescale 1ns/1ps

// Simple WB memory leaf; `stall` holds ACK low.
module tb_mem #(parameter int AW = 16) (
	input  logic          clk,
	input  logic          rst_n,
	input  logic          stall,
	input  logic [AW-1:0] i_wb_adr,
	input  logic [31:0]   i_wb_dat,
	input  logic [3:0]    i_wb_sel,
	input  logic          i_wb_cyc,
	input  logic          i_wb_stb,
	input  logic          i_wb_we,
	output logic [31:0]   o_wb_dat,
	output logic          o_wb_ack
);
	logic [31:0] mem [0:63];
	logic [31:0] bmask;
	assign bmask = {{8{i_wb_sel[3]}}, {8{i_wb_sel[2]}}, {8{i_wb_sel[1]}}, {8{i_wb_sel[0]}}};
	initial for (int i = 0; i < 64; i++) mem[i] = 32'd0;
	always @(posedge clk or negedge rst_n) begin
		if (!rst_n) begin
			o_wb_ack <= 1'b0;
			o_wb_dat <= 32'd0;
		end else begin
			o_wb_ack <= 1'b0;
			if (i_wb_cyc && i_wb_stb && !o_wb_ack && !stall) begin
				o_wb_ack <= 1'b1;
				o_wb_dat <= mem[i_wb_adr[7:2]];
				if (i_wb_we)
					mem[i_wb_adr[7:2]] <= (mem[i_wb_adr[7:2]] & ~bmask) | (i_wb_dat & bmask);
			end
		end
	end
endmodule

module tb;
	logic clk = 0, rst_n = 0, rb_grant_en = 0;
	always #5 clk = ~clk;

	// Masters
	logic [15:0] cpu_i_o_wb_adr = 0, cpu_d_o_wb_adr = 0, dma_o_wb_adr = 0;
	logic [31:0] cpu_i_o_wb_dat = 0, cpu_d_o_wb_dat = 0, dma_o_wb_dat = 0;
	logic [3:0]  cpu_i_o_wb_sel = 0, cpu_d_o_wb_sel = 0, dma_o_wb_sel = 0;
	logic        cpu_i_o_wb_cyc = 0, cpu_i_o_wb_stb = 0, cpu_i_o_wb_we = 0;
	logic        cpu_d_o_wb_cyc = 0, cpu_d_o_wb_stb = 0, cpu_d_o_wb_we = 0;
	logic        dma_o_wb_cyc = 0,   dma_o_wb_stb = 0,   dma_o_wb_we = 0;
	logic [31:0] cpu_i_i_wb_dat, cpu_d_i_wb_dat, dma_i_wb_dat;
	logic        cpu_i_i_wb_ack, cpu_d_i_wb_ack, dma_i_wb_ack;

	// Slaves
	logic [15:0] gpio_i_wb_adr, uart_i_wb_adr, mem_i_wb_adr;
	logic [31:0] gpio_i_wb_dat, uart_i_wb_dat, mem_i_wb_dat;
	logic [3:0]  gpio_i_wb_sel, uart_i_wb_sel, mem_i_wb_sel;
	logic        gpio_i_wb_cyc, gpio_i_wb_stb, gpio_i_wb_we;
	logic        uart_i_wb_cyc, uart_i_wb_stb, uart_i_wb_we;
	logic        mem_i_wb_cyc,  mem_i_wb_stb,  mem_i_wb_we;
	logic [31:0] gpio_o_wb_dat, uart_o_wb_dat, mem_o_wb_dat;
	logic        gpio_o_wb_ack, uart_o_wb_ack, mem_o_wb_ack;

	logic gpio_stall = 0, uart_stall = 0, mem_stall = 0;

	xb_crossbar u_dut (.*);

	tb_mem u_gpio (.clk, .rst_n, .stall(gpio_stall),
		.i_wb_adr(gpio_i_wb_adr), .i_wb_dat(gpio_i_wb_dat), .i_wb_sel(gpio_i_wb_sel),
		.i_wb_cyc(gpio_i_wb_cyc), .i_wb_stb(gpio_i_wb_stb), .i_wb_we(gpio_i_wb_we),
		.o_wb_dat(gpio_o_wb_dat), .o_wb_ack(gpio_o_wb_ack));
	tb_mem u_uart (.clk, .rst_n, .stall(uart_stall),
		.i_wb_adr(uart_i_wb_adr), .i_wb_dat(uart_i_wb_dat), .i_wb_sel(uart_i_wb_sel),
		.i_wb_cyc(uart_i_wb_cyc), .i_wb_stb(uart_i_wb_stb), .i_wb_we(uart_i_wb_we),
		.o_wb_dat(uart_o_wb_dat), .o_wb_ack(uart_o_wb_ack));
	tb_mem u_mem (.clk, .rst_n, .stall(mem_stall),
		.i_wb_adr(mem_i_wb_adr), .i_wb_dat(mem_i_wb_dat), .i_wb_sel(mem_i_wb_sel),
		.i_wb_cyc(mem_i_wb_cyc), .i_wb_stb(mem_i_wb_stb), .i_wb_we(mem_i_wb_we),
		.o_wb_dat(mem_o_wb_dat), .o_wb_ack(mem_o_wb_ack));

	int errors = 0;
	task automatic check(input string what, input logic [31:0] got, input logic [31:0] exp);
		if (got !== exp) begin
			$display("FAIL %s: got %h expected %h", what, got, exp);
			errors++;
		end
	endtask

	//--------------------------------------------------------------------------
	//  Master BFMs (one blocking beat each). ACK is sampled at the clock
	//  edge, as a synchronous master does: wb_cfg_pipe posts a write with a
	//  combinational ACK and captures the beat at that same edge.
	//--------------------------------------------------------------------------
	task automatic cpu_i_xfer(input logic wr, input logic [15:0] a, input logic [31:0] d,
	                          output logic [31:0] rd);
		@(posedge clk); #1;
		cpu_i_o_wb_cyc = 1; cpu_i_o_wb_stb = 1; cpu_i_o_wb_we = wr;
		cpu_i_o_wb_adr = a; cpu_i_o_wb_dat = d; cpu_i_o_wb_sel = 4'hf;
		do @(posedge clk); while (!cpu_i_i_wb_ack);
		rd = cpu_i_i_wb_dat;
		#1; cpu_i_o_wb_cyc = 0; cpu_i_o_wb_stb = 0;
	endtask

	task automatic cpu_d_xfer(input logic wr, input logic [15:0] a, input logic [31:0] d,
	                          output logic [31:0] rd);
		@(posedge clk); #1;
		cpu_d_o_wb_cyc = 1; cpu_d_o_wb_stb = 1; cpu_d_o_wb_we = wr;
		cpu_d_o_wb_adr = a; cpu_d_o_wb_dat = d; cpu_d_o_wb_sel = 4'hf;
		do @(posedge clk); while (!cpu_d_i_wb_ack);
		rd = cpu_d_i_wb_dat;
		#1; cpu_d_o_wb_cyc = 0; cpu_d_o_wb_stb = 0;
	endtask

	task automatic dma_xfer(input logic wr, input logic [15:0] a, input logic [31:0] d,
	                        output logic [31:0] rd);
		@(posedge clk); #1;
		dma_o_wb_cyc = 1; dma_o_wb_stb = 1; dma_o_wb_we = wr;
		dma_o_wb_adr = a; dma_o_wb_dat = d; dma_o_wb_sel = 4'hf;
		do @(posedge clk); while (!dma_i_wb_ack);
		rd = dma_i_wb_dat;
		#1; dma_o_wb_cyc = 0; dma_o_wb_stb = 0;
	endtask

	// ACK must never be seen by a master that is not driving CYC.
	always @(posedge clk) if (rst_n) begin
		if (cpu_i_i_wb_ack && !cpu_i_o_wb_cyc) begin $display("FAIL stray ack cpu_i"); errors++; end
		if (cpu_d_i_wb_ack && !cpu_d_o_wb_cyc) begin $display("FAIL stray ack cpu_d"); errors++; end
		if (dma_i_wb_ack   && !dma_o_wb_cyc)   begin $display("FAIL stray ack dma");   errors++; end
	end

	//--------------------------------------------------------------------------
	//  Sequence
	//--------------------------------------------------------------------------
	logic [31:0] rd, rd2;
	bit done_a, done_b;

	initial begin
		#100; rst_n = 1; #100;

		// 1. Every master reaches every slave; window offsets are relative.
		cpu_i_xfer(1, 16'h0010, 32'h1111_0010, rd);
		cpu_d_xfer(1, 16'h0110, 32'h2222_0110, rd);
		dma_xfer  (1, 16'h8010, 32'h3333_8010, rd);
		cpu_i_xfer(0, 16'h0010, 32'h0, rd); check("cpu_i gpio", rd, 32'h1111_0010);
		cpu_d_xfer(0, 16'h0110, 32'h0, rd); check("cpu_d uart", rd, 32'h2222_0110);
		dma_xfer  (0, 16'h8010, 32'h0, rd); check("dma mem",    rd, 32'h3333_8010);
		dma_xfer  (0, 16'h0010, 32'h0, rd); check("dma gpio",   rd, 32'h1111_0010);
		cpu_d_xfer(0, 16'h8010, 32'h0, rd); check("cpu_d mem",  rd, 32'h3333_8010);
		cpu_i_xfer(0, 16'h0110, 32'h0, rd); check("cpu_i uart", rd, 32'h2222_0110);
		check("gpio offset", u_gpio.mem[4], 32'h1111_0010);
		check("uart offset", u_uart.mem[4], 32'h2222_0110);
		check("mem offset",  u_mem.mem[4],  32'h3333_8010);

		// 2. Unmapped address: immediate ACK, zero data, no slave strobe.
		cpu_d_xfer(0, 16'h4000, 32'h0, rd); check("unmapped", rd, 32'h0);
		dma_xfer  (1, 16'h4000, 32'hdead, rd);
		check("unmapped no write gpio", u_gpio.mem[0], 32'h0);

		// 3. Parallel progress: dma stalls on mem while cpu_d talks to ctrl.
		mem_stall = 1; done_a = 0; done_b = 0;
		fork
			begin dma_xfer(0, 16'h8010, 32'h0, rd2); done_a = 1; end
			begin
				repeat (4) @(posedge clk);
				cpu_d_xfer(1, 16'h0020, 32'hCAFE_0020, rd);
				cpu_d_xfer(0, 16'h0020, 32'h0, rd);
				done_b = 1;
				check("parallel cpu_d while dma stalled: dma not done", done_a, 0);
				check("parallel cpu_d data", rd, 32'hCAFE_0020);
				mem_stall = 0;
			end
		join
		check("dma after release", rd2, 32'h3333_8010);

		// 4. Master group exclusion: cpu_i stalled on mem blocks cpu_d (same group).
		mem_stall = 1; done_a = 0; done_b = 0;
		fork
			begin cpu_i_xfer(0, 16'h8010, 32'h0, rd2); done_a = 1; end
			begin cpu_d_xfer(0, 16'h0020, 32'h0, rd); done_b = 1; end
			begin
				repeat (30) @(posedge clk);
				check("same master group: cpu_d blocked", done_b, 0);
				check("same master group: cpu_i pending", done_a, 0);
				mem_stall = 0;
			end
		join
		check("cpu_i after release", rd2, 32'h3333_8010);
		check("cpu_d after release", rd, 32'hCAFE_0020);

		// 5. Slave group exclusion: dma stalled on gpio blocks cpu_d on uart.
		gpio_stall = 1; done_a = 0; done_b = 0;
		fork
			begin dma_xfer(0, 16'h0020, 32'h0, rd2); done_a = 1; end
			begin
				repeat (4) @(posedge clk);
				cpu_d_xfer(0, 16'h0110, 32'h0, rd); done_b = 1;
			end
			begin
				repeat (30) @(posedge clk);
				check("same slave group: cpu_d blocked", done_b, 0);
				gpio_stall = 0;
			end
		join
		check("dma gpio after release", rd2, 32'hCAFE_0020);
		check("cpu_d uart after release", rd, 32'h2222_0110);

		// 5b. ...but cpu_i on mem is not blocked by the stalled ctrl group.
		gpio_stall = 1; done_a = 0; done_b = 0;
		fork
			begin dma_xfer(0, 16'h0020, 32'h0, rd2); done_a = 1; end
			begin
				repeat (4) @(posedge clk);
				cpu_i_xfer(1, 16'h8030, 32'h5555_8030, rd);
				cpu_i_xfer(0, 16'h8030, 32'h0, rd);
				done_b = 1;
				check("other slave group: cpu_i done while dma stalled", done_a, 0);
				check("other slave group: cpu_i data", rd, 32'h5555_8030);
				gpio_stall = 0;
			end
		join

		// 6. Concurrent burst, fixed priority then round-robin.
		for (int pass = 0; pass < 2; pass++) begin
			rb_grant_en = pass[0];
			fork
				begin : b_cpu_i
					logic [31:0] r;
					for (int i = 0; i < 8; i++) cpu_i_xfer(1, 16'h8040 + 16'(i * 4), 32'hA000_0000 + i + pass, r);
				end
				begin : b_cpu_d
					logic [31:0] r;
					for (int i = 0; i < 8; i++) cpu_d_xfer(1, 16'h0040 + 16'(i * 4), 32'hB000_0000 + i + pass, r);
				end
				begin : b_dma
					logic [31:0] r;
					for (int i = 0; i < 8; i++) begin
						dma_xfer(1, 16'h0140 + 16'(i * 4), 32'hC000_0000 + i + pass, r);
						dma_xfer(1, 16'h8080 + 16'(i * 4), 32'hD000_0000 + i + pass, r);
					end
				end
			join
			// Posted writes ACK at pipe acceptance; let the last beat retire.
			repeat (8) @(posedge clk);
			for (int i = 0; i < 8; i++) begin
				check("burst cpu_i mem",  u_mem.mem[16 + i],  32'hA000_0000 + i + pass);
				check("burst cpu_d gpio", u_gpio.mem[16 + i], 32'hB000_0000 + i + pass);
				check("burst dma uart",   u_uart.mem[16 + i], 32'hC000_0000 + i + pass);
				check("burst dma mem",    u_mem.mem[32 + i],  32'hD000_0000 + i + pass);
			end
			// Read back through a different master than the writer.
			dma_xfer(0, 16'h8044, 32'h0, rd);   check("burst xread mem",  rd, 32'hA000_0001 + pass);
			cpu_i_xfer(0, 16'h0144, 32'h0, rd); check("burst xread uart", rd, 32'hC000_0001 + pass);
		end

		if (errors == 0) $display("PASS");
		else $display("FAIL %0d errors", errors);
		$finish;
	end

	initial begin
		#500_000;
		$display("FAIL timeout");
		$finish;
	end
endmodule
