// Public-port CDC regression for posted writes, ordering, backpressure and reset flush.
`timescale 1ns/1ps
module tb #(
	parameter int HALF = 3,
	parameter bit APB = 0
);
	logic s_clk = 0, clk = 0, source_running = 1, target_running = 1;
	logic s_rst_n = 0, rst_n = 0;
	always #5 if (source_running) s_clk = ~s_clk;
	always #HALF if (target_running) clk = ~clk;

	logic request = 0, enable = 0, write_request = 0;
	logic [7:0] address = 0;
	logic [31:0] data = 0;
	logic [3:0] strobes = 0;
	logic [2:0] tag = 0;
	logic cyc, stb, we, ack, err;
	logic [7:0] adr;
	logic [31:0] wdat, rdat;
	logic [3:0] sel;
	logic pready, pslverr;
	logic [31:0] prdata;
	logic mc, ms, mw, ma = 0;
	logic [7:0] maddr;
	logic [31:0] md, response = 0;
	logic [3:0] msel;
	logic [2:0] mtag;
	wire complete = APB ? pready : ack;
	wire failed = APB ? pslverr : err;
	wire [31:0] result = APB ? prdata : rdat;

	generate if (APB) begin : g_apb
		wb_apb2wb #(.AW(8)) bridge (
			.pclk(s_clk), .presetn(s_rst_n), .paddr(address), .psel(request),
			.penable(enable), .pwrite(write_request), .pwdata(data), .pstrb(strobes),
			.pprot(3'b000), .prdata(prdata), .pready(pready), .pslverr(pslverr),
			.wb_cyc(cyc), .wb_stb(stb), .wb_we(we), .wb_adr(adr), .wb_dat(wdat),
			.wb_sel(sel), .wb_ack(ack), .wb_err(err), .wb_rdat(rdat));
	end else begin : g_wb
		assign cyc = request; assign stb = request; assign we = write_request;
		assign adr = address; assign wdat = data; assign sel = strobes;
		assign pready = 1'b0; assign pslverr = 1'b0; assign prdata = 32'd0;
	end endgenerate

	wb_cdc #(.AW(8), .TW(3)) dut (
		.s_clk(s_clk), .s_rst_n(s_rst_n), .s_cyc(cyc), .s_stb(stb), .s_we(we),
		.s_adr(adr), .s_dat(wdat), .s_sel(sel), .s_tga(APB ? 3'b000 : tag),
		.s_ack(ack), .s_err(err), .s_rdat(rdat), .clk(clk), .rst_n(rst_n),
		.m_cyc(mc), .m_stb(ms), .m_we(mw), .m_adr(maddr), .m_dat(md),
		.m_sel(msel), .m_tga(mtag), .m_ack(ma), .m_rdat(response));

	logic read_target_seen = 0, read_target_acked = 0;
	always @(posedge s_clk) begin
		if (s_rst_n && ack && err) $fatal(1, "ACK and ERR overlap");
		if (s_rst_n && (err || failed)) $fatal(1, "unexpected CDC error");
		if (s_rst_n && ack && !we && !read_target_acked)
			$fatal(1, "read completed before target ACK");
	end

	task automatic begin_xfer(input logic wr, input logic [7:0] a,
		input logic [31:0] d, input logic [3:0] st, input logic [2:0] tg);
		@(negedge s_clk);
		write_request = wr; address = a; data = d; strobes = st; tag = tg;
		if (!wr) begin read_target_seen = 0; read_target_acked = 0; end
		request = 1; enable = 0;
		if (APB) begin @(negedge s_clk); enable = 1; end
	endtask

	task automatic end_xfer;
		@(negedge s_clk); request = 0; enable = 0;
	endtask

	task automatic source_write(input logic [7:0] a, input logic [31:0] d,
		input logic [3:0] st, input logic [2:0] tg);
		begin_xfer(1, a, d, st, tg);
		do @(posedge s_clk); while (!complete);
		if (failed) $fatal(1, "posted write failed");
		end_xfer();
	endtask

	task automatic source_read(input logic [7:0] a, output logic [31:0] d);
		begin_xfer(0, a, 0, 4'hf, 3'b011);
		do @(posedge s_clk); while (!complete);
		if (failed) $fatal(1, "read failed");
		d = result;
		end_xfer();
	endtask

	logic [31:0] memory [0:255];

	task automatic target_reply(input logic wr, input logic [7:0] a,
		input logic [31:0] d, input logic [3:0] st, input logic [2:0] tg,
		input logic [31:0] rd);
		logic [31:0] mask;
		wait(mc && ms);
		if (!wr) read_target_seen = 1;
		// Target pins retain this command after the source starts its next beat.
		repeat (wr ? 6 : 80) begin
			@(negedge clk);
			if ({mc, ms, mw, maddr, md, msel, mtag} !==
			    {2'b11, wr, a, d, st, (APB ? 3'b000 : tg)})
				$fatal(1, "target payload/order changed before ACK");
		end
		@(negedge clk); response = rd; ma = 1;
		@(posedge clk);
		if (wr) begin
			mask = {{8{st[3]}}, {8{st[2]}}, {8{st[1]}}, {8{st[0]}}};
			memory[a] = (memory[a] & ~mask) | (d & mask);
		end else read_target_acked = 1;
		@(negedge clk); ma = 0;
	endtask

	initial begin
		logic [31:0] rd;
		for (int i = 0; i < 256; i++) memory[i] = 32'h55AA_55AA;
		repeat (4) @(negedge s_clk);
		repeat (4) @(negedge clk);
		target_running = 0;
		@(negedge s_clk); s_rst_n = 1; rst_n = 1;

		// Eight writes post with no target edges after reset release. Each uses
		// distinct payload, byte selects and tags; writes must not need responses.
		for (int i = 0; i < 8; i++)
			source_write(8'h10 + 8'(i), 32'hA100_0000 + i, 4'(i + 1), 3'(i));
		begin_xfer(1, 8'h18, 32'hA100_0008, 4'h9, 3'b000);
		repeat (80) begin
			@(posedge s_clk);
			if (complete || ack) $fatal(1, "full command FIFO acknowledged ninth write");
			if (mc || ms) $fatal(1, "stopped target issued a command");
		end

		// Admit the ninth write after resume, then immediately queue a read fence.
		// The final write waits for the read to be issued, proving actual overlap.
		target_running = 1;
		fork
			begin
				for (int i = 0; i < 9; i++) begin
					if (i == 8) wait(cyc && stb && !we);
					target_reply(1, 8'h10 + 8'(i), 32'hA100_0000 + i,
						4'(i + 1), 3'(i), 32'hBAD0_0000 + i);
				end
				target_reply(0, 8'h18, 0, 4'hf, 3'b011, memory[8'h18]);
			end
			begin
				do @(posedge s_clk); while (!complete);
				if (failed) $fatal(1, "backpressured write failed");
				end_xfer();
				source_read(8'h18, rd);
				if (!read_target_acked || rd !== 32'hA1AA_5508)
					$fatal(1, "read fence returned before writes or wrong read data");
			end
		join

		// A read issued with the target clock stopped waits without ACK or ERR.
		@(negedge clk);
		if (mc || ms) $fatal(1, "target not idle before clock pause");
		target_running = 0;
		begin_xfer(0, 8'h72, 0, 4'hf, 3'b011);
		repeat (80) begin
			@(posedge s_clk);
			if (complete || ack) $fatal(1, "read completed with target stopped");
		end
		target_running = 1;
		fork
			target_reply(0, 8'h72, 0, 4'hf, 3'b011, 32'h72C0_F00D);
			begin
				do @(posedge s_clk); while (!complete);
				if (result !== 32'h72C0_F00D) $fatal(1, "resumed read data mismatch");
				end_xfer();
			end
		join

		// A response is retained while the source clock is stopped.
		read_target_seen = 0; read_target_acked = 0;
		begin_xfer(0, 8'h74, 0, 4'hf, 3'b011);
		fork
			target_reply(0, 8'h74, 0, 4'hf, 3'b011, 32'h74C0_F00D);
			begin
				wait(read_target_seen);
				@(negedge s_clk); source_running = 0;
				wait(read_target_acked);
				repeat (12) @(negedge clk);
				if (complete || ack || mc || ms)
					$fatal(1, "response not buffered while source stopped");
				source_running = 1;
			end
		join
		do @(posedge s_clk); while (!complete);
		if (result !== 32'h74C0_F00D) $fatal(1, "buffered response data mismatch");
		end_xfer();

		// Coordinated reset flushes queued work; no stale command may escape afterward.
		@(negedge clk);
		if (mc || ms) $fatal(1, "target not quiescent before reset test");
		target_running = 0;
		source_write(8'h90, 32'hDEAD_0090, 4'hf, 3'b101);
		source_write(8'h91, 32'hDEAD_0091, 4'hf, 3'b101);
		@(negedge s_clk); s_rst_n = 0; rst_n = 0; request = 0; enable = 0; ma = 0;
		// Flush may discard already-posted writes; both clocks run under reset.
		target_running = 1;
		repeat (4) @(negedge clk);
		repeat (4) @(negedge s_clk);
		s_rst_n = 1; rst_n = 1;
		repeat (20) begin
			@(negedge clk);
			if (mc || ms || ack || complete) $fatal(1, "stale command/completion after reset");
		end
		fork
			begin
				target_reply(1, 8'h7c, 32'h7CC0_F00D, 4'hf, 3'b110, 32'hBAD0_007C);
				target_reply(0, 8'h7c, 0, 4'hf, 3'b011, memory[8'h7c]);
			end
			begin
				source_write(8'h7c, 32'h7CC0_F00D, 4'hf, 3'b110);
				source_read(8'h7c, rd);
			end
		join
		if (rd !== 32'h7CC0_F00D) $fatal(1, "fresh read after reset mismatch");
		repeat (20) begin
			@(negedge clk);
			if (mc || ms || ack || complete) $fatal(1, "duplicate command/completion");
		end
		$display("PASS"); $finish;
	end

	initial begin #100000; $fatal(1, "CDC boundary watchdog expired"); end
endmodule
