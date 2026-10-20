// Test-only CELL_SYNC adapter: STAGES+1 flops so selection is observable.
// Not a vendor cell; stands in for one in the AUTOWIRE_SYNC_CELL smoke.
module tb_sync_cell_adapter #(
	parameter int unsigned STAGES    = 2,
	parameter bit          RESET_VAL = 1'b0,
	parameter int unsigned WIDTH     = 1
) (
	input  logic             clk,
	input  logic             rst_n,
	input  logic [WIDTH-1:0] d,
	output logic [WIDTH-1:0] q
);
	logic [STAGES:0][WIDTH-1:0] chain;
	always_ff @(posedge clk or negedge rst_n) begin
		if (!rst_n) chain <= {((STAGES + 1) * WIDTH){RESET_VAL}};
		else        chain <= {chain[STAGES-1:0], d};
	end
	assign q = chain[STAGES];
endmodule
