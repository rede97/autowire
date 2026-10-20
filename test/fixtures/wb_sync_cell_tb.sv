// wb_sync_cell: per-bit latency, reset value, WIDTH and cell selection.
// Under AUTOWIRE_SYNC_CELL the test adapter adds one flop of latency.
`timescale 1ns/1ps
module tb #(
	parameter int STAGES = 2,
	parameter int WIDTH = 4,
	parameter bit RESET_VAL = 1'b1
);
`ifdef AUTOWIRE_SYNC_CELL
	localparam int LAT = STAGES + 1;
`else
	localparam int LAT = STAGES;
`endif
	logic clk = 0, rst_n = 1;
	always #5 clk = ~clk;
	logic [WIDTH-1:0] d = '0, q;
	logic [WIDTH-1:0] hist [0:31];

	wb_sync_cell #(.STAGES(STAGES), .RESET_VAL(RESET_VAL), .WIDTH(WIDTH)) dut (
		.clk(clk), .rst_n(rst_n), .d(d), .q(q)
	);

	initial begin
		#1 rst_n = 0; // an explicit falling edge; a time-0 low level fires no negedge
		#1;
		if (q !== {WIDTH{RESET_VAL}}) $fatal(1, "reset value %b", q);
		repeat (3) @(negedge clk);
		if (q !== {WIDTH{RESET_VAL}}) $fatal(1, "reset not held: %b", q);
		rst_n = 1;
		// Drive a new pattern each cycle; q must equal d from exactly LAT edges ago.
		for (int t = 0; t < 32; t++) begin
			@(negedge clk);
			if (t >= LAT && q !== hist[t - LAT])
				$fatal(1, "t=%0d q=%b expect %b (latency %0d)", t, q, hist[t - LAT], LAT);
			d = WIDTH'(t * 37 + 5);
			hist[t] = d;
		end
		// Asynchronous reset between edges drives every bit back to RESET_VAL.
		#2 rst_n = 0; #1;
		if (q !== {WIDTH{RESET_VAL}}) $fatal(1, "async reset value %b", q);
		$display("PASS"); $finish;
	end
endmodule
