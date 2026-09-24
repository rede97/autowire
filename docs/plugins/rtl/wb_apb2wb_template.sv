// SPDX-License-Identifier: MIT
//
// wb_apb2wb — APB3/APB4 completer to Wishbone Classic master (single clock).
//
// Runs in the APB clock. Pair with wb_cdc when PCLK is not the fabric clk.
// PREADY waits for WB ACK/ERR (non-posted); ERR maps to PSLVERR.
// PPROT filter: (pprot & PPROT_MASK) != PPROT_VAL completes at once with
// PSLVERR=1 (never hangs). PPROT_MASK=0 accepts everything.
// Reads drive SEL=4'hf; writes drive SEL=PSTRB (tie 4'hf for APB3).

module wb_apb2wb #(
	parameter int unsigned AW         = 32,
	parameter logic [2:0]  PPROT_MASK = 3'b000,
	parameter logic [2:0]  PPROT_VAL  = 3'b000
) (
	input  logic          pclk,
	input  logic          presetn,
	input  logic [AW-1:0] paddr,
	input  logic          psel,
	input  logic          penable,
	input  logic          pwrite,
	input  logic [31:0]   pwdata,
	input  logic [3:0]    pstrb,
	input  logic [2:0]    pprot,
	output logic [31:0]   prdata,
	output logic          pready,
	output logic          pslverr,

	output logic          wb_cyc,
	output logic          wb_stb,
	output logic          wb_we,
	output logic [AW-1:0] wb_adr,
	output logic [31:0]   wb_dat,
	output logic [3:0]    wb_sel,
	input  logic          wb_ack,
	input  logic          wb_err,
	input  logic [31:0]   wb_rdat
);

	logic access;
	logic prot_ok;

	assign access  = psel && penable && !pready;
	assign prot_ok = (pprot & PPROT_MASK) == PPROT_VAL;

	always_ff @(posedge pclk or negedge presetn) begin
		if (!presetn) begin
			pready  <= 1'b0;
			pslverr <= 1'b0;
			prdata  <= 32'd0;
			wb_cyc  <= 1'b0;
			wb_stb  <= 1'b0;
			wb_we   <= 1'b0;
			wb_adr  <= '0;
			wb_dat  <= 32'd0;
			wb_sel  <= 4'd0;
		end else begin
			pready  <= 1'b0;
			pslverr <= 1'b0;
			if (wb_cyc) begin
				if (wb_ack || wb_err) begin
					wb_cyc  <= 1'b0;
					wb_stb  <= 1'b0;
					pready  <= 1'b1;
					pslverr <= wb_err;
					prdata  <= wb_we ? 32'd0 : wb_rdat;
				end
			end else if (access) begin
				if (!prot_ok) begin
					pready  <= 1'b1;
					pslverr <= 1'b1;
					prdata  <= 32'd0;
				end else begin
					wb_cyc <= 1'b1;
					wb_stb <= 1'b1;
					wb_we  <= pwrite;
					wb_adr <= paddr;
					wb_dat <= pwdata;
					wb_sel <= pwrite ? pstrb : 4'hf;
				end
			end
		end
	end

endmodule
