import { expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verilatorSim, verilatorTest } from "./fixtures/verilator.ts";

const root = join(import.meta.dir, "..");
const fifo = join(root, "docs/plugins/rtl/wb_async_fifo_template.sv");
const sync = join(root, "docs/plugins/rtl/wb_sync_cell_template.sv");

for (const [depth, wrHalf, rdHalf] of [
	[2, 5, 7],
	[2, 7, 5],
	[8, 5, 7],
	[8, 7, 5],
] as const) {
	verilatorTest(
		`wb_async_fifo depth ${depth}, write half ${wrHalf}ns, read half ${rdHalf}ns`,
		() => {
			const dir = mkdtempSync(join(tmpdir(), "aw-async-fifo-"));
			const tb = join(dir, "tb.sv");
			writeFileSync(
				tb,
				`module tb #(parameter int DEPTH=${depth}, parameter int WR_HALF=${wrHalf}, parameter int RD_HALF=${rdHalf});
				logic wr_clk = 0, rd_clk = 0, wr_running = 1, rd_running = 1;
				logic wr_rst_n = 0, rd_rst_n = 0, wr_en = 0, rd_en = 0;
				logic [31:0] wr_data = 0, rd_data;
				logic wr_full, rd_empty;
				always #WR_HALF if (wr_running) wr_clk = ~wr_clk;
				always #RD_HALF if (rd_running) rd_clk = ~rd_clk;
				wb_async_fifo #(.WIDTH(32), .DEPTH(DEPTH)) dut (
					.wr_clk, .wr_rst_n, .rd_clk, .rd_rst_n, .wr_en, .rd_en,
					.wr_data, .wr_full, .rd_empty, .rd_data
				);

				task automatic write_one(input logic [31:0] value);
					repeat (100) begin
						@(negedge wr_clk);
						if (!wr_full) begin
							wr_data = value; wr_en = 1;
							@(posedge wr_clk); #1; wr_en = 0; return;
						end
					end
					$fatal(1, "write timed out while FIFO full");
				endtask
				task automatic read_one(input logic [31:0] expected);
					if (rd_empty) $fatal(1, "read attempted while empty");
					@(negedge rd_clk); rd_en = 1;
					@(posedge rd_clk); #1;
					if (rd_data !== expected)
						$fatal(1, "ordering error: expected %08x got %08x", expected, rd_data);
					rd_en = 0;
				endtask
				task automatic wait_not_empty;
					repeat (80) begin
						@(posedge rd_clk); #1;
						if (!rd_empty) return;
					end
					$fatal(1, "FIFO did not become non-empty");
				endtask

				initial begin
					#1; wr_rst_n = 0; rd_rst_n = 0;
					#29; wr_rst_n = 1; rd_rst_n = 1;
					// Two local rising edges are required before each side permits I/O.
					repeat (4) @(posedge wr_clk);
					repeat (4) @(posedge rd_clk);
					if (!rd_empty || wr_full) $fatal(1, "bad reset state");
					$display("FIFO reset release latency: 2 local clock edges");

					// Fill exactly to capacity and prove overflow is prevented.
					for (int i = 0; i < DEPTH; i++) write_one(32'h1000 + i);
					if (!wr_full) $fatal(1, "FIFO did not assert full at depth");
					wr_data = 32'hdead_beef;
					wr_en = 1;
					repeat (3) begin @(posedge wr_clk); #1; if (!wr_full) $fatal(1, "overflow accepted"); end
					wr_en = 0;

					// Backpressure leaves full asserted while the reader is stopped.
					rd_running = 0;
					repeat (3) @(posedge wr_clk);
					if (!wr_full) $fatal(1, "full lost under halted reader");
					rd_running = 1;
					wait_not_empty();
					for (int i = 0; i < DEPTH; i++) begin
						wait_not_empty(); read_one(32'h1000 + i);
					end
					if (!rd_empty) begin @(posedge rd_clk); #1; end
					if (!rd_empty) $fatal(1, "FIFO did not become empty");
					// Underflow is prevented and the registered data remains stable.
					if (rd_data !== 32'h1000 + DEPTH - 1) $fatal(1, "bad final read data");
					rd_en = 1; @(posedge rd_clk); #1; rd_en = 0;
					if (!rd_empty || rd_data !== 32'h1000 + DEPTH - 1) $fatal(1, "underflow changed data");

					// Concurrent producer/consumer streaming exercises both clock ratios.
					fork
						begin
							for (int i = 0; i < 24; i++) write_one(32'h1800 + i);
						end
						begin
							for (int i = 0; i < 24; i++) begin
								wait_not_empty(); read_one(32'h1800 + i);
							end
						end
					join

					// Wraparound ordering after a complete drain.
					for (int i = 0; i < DEPTH; i++) write_one(32'h2000 + i);
					for (int i = 0; i < 3; i++) begin
						wait_not_empty(); read_one(32'h2000 + i);
						write_one(32'h2000 + DEPTH + i);
					end
					for (int i = 3; i < DEPTH + 3; i++) begin
						wait_not_empty(); read_one(32'h2000 + i);
					end

					// Coordinated reset flushes queued storage, including with rd_clk halted.
					write_one(32'h3000); write_one(32'h3001);
					rd_running = 0;
					#2; wr_rst_n = 0; rd_rst_n = 0;
					repeat (4) @(posedge wr_clk);
					if (!wr_full || !rd_empty) $fatal(1, "reset flags not conservative");
					wr_rst_n = 1; rd_rst_n = 1;
					repeat (4) @(posedge wr_clk);
					if (wr_full) $fatal(1, "writer remained full after flush");
					rd_running = 1;
					repeat (6) @(posedge rd_clk);
					if (!rd_empty) $fatal(1, "reset did not flush halted reader");
					write_one(32'h4000);
					wait_not_empty();
					read_one(32'h4000);
					$display("PASS");
					$finish;
				end
				initial begin #200000; $fatal(1, "watchdog"); end
			endmodule
			`,
			);
			try {
				const r = verilatorSim({
					dir: join(dir, "obj"),
					top: "tb",
					sources: [tb, fifo, sync],
				});
				expect(r.buildOk, r.buildLog).toBe(true);
				expect(r.exitCode, r.stdout + r.stderr).toBe(0);
				expect(r.stdout).toContain("PASS");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		180_000,
	);
}
