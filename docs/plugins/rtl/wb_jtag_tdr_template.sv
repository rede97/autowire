// SPDX-License-Identifier: MIT
//
// wb_jtag_tdr — IEEE 1149.1 user-DR / IEEE 1687 TDR client to Wishbone master.
//
// No TAP controller here: the chip TAP (owned by the DFT flow) or a SIB drives
// sel / capture_dr / shift_dr / update_dr. Everything runs on TCK; pair with
// wb_cdc into the fabric clk.
//
// DR (W = 2 + AW + 32, shifted LSB first, tdo = dr[0]):
//   shift in : { op[1:0], adr[AW-1:0], dat[31:0] }
//   capture  : { st[1:0], adr[AW-1:0], rdat[31:0] }   (adr = last issued)
//   op : 0 nop  1 read  2 write  3 reserved (nop)
//   st : 0 ok   1 busy  2 err (sticky; a nop Update-DR clears it when idle)
// Update-DR launches the WB access; the result needs TCK edges to return
// (Run-Test/Idle between scans). An op issued while busy is dropped and sets
// err. en=0 (lifecycle / DFT test mode) turns every op into err.

module wb_jtag_tdr #(
	parameter int unsigned AW = 32
) (
	input  logic          tck,
	input  logic          trst_n,
	input  logic          sel,
	input  logic          capture_dr,
	input  logic          shift_dr,
	input  logic          update_dr,
	input  logic          tdi,
	output logic          tdo,
	input  logic          en,

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

	localparam int unsigned W = 2 + AW + 32;

	localparam logic [1:0] OP_NOP   = 2'd0;
	localparam logic [1:0] OP_READ  = 2'd1;
	localparam logic [1:0] OP_WRITE = 2'd2;

	logic [W-1:0]  dr;
	logic [1:0]    dr_op;
	logic [AW-1:0] dr_adr;
	logic [31:0]   dr_dat;
	logic          busy;
	logic          err;
	logic [31:0]   rdat;
	logic [1:0]    st;
	logic          en_t;

	assign dr_op  = dr[W-1 -: 2];
	assign dr_adr = dr[32 +: AW];
	assign dr_dat = dr[31:0];
	assign st     = busy ? 2'd1 : (err ? 2'd2 : 2'd0);
	assign tdo    = dr[0];

	wb_sync_cell u_en_sync (
		.clk(tck), .rst_n(trst_n), .d(en), .q(en_t)
	);

	always_ff @(posedge tck or negedge trst_n) begin
		if (!trst_n) begin
			dr <= '0;
		end else if (sel && capture_dr) begin
			dr <= {st, wb_adr, rdat};
		end else if (sel && shift_dr) begin
			dr <= {tdi, dr[W-1:1]};
		end
	end

	always_ff @(posedge tck or negedge trst_n) begin
		if (!trst_n) begin
			busy   <= 1'b0;
			err    <= 1'b0;
			rdat   <= 32'd0;
			wb_cyc <= 1'b0;
			wb_stb <= 1'b0;
			wb_we  <= 1'b0;
			wb_adr <= '0;
			wb_dat <= 32'd0;
			wb_sel <= 4'd0;
		end else begin
			if (busy && (wb_ack || wb_err)) begin
				busy   <= 1'b0;
				wb_cyc <= 1'b0;
				wb_stb <= 1'b0;
				if (wb_err) err <= 1'b1;
				if (!wb_we) rdat <= wb_rdat;
			end
			if (sel && update_dr) begin
				if (dr_op == OP_READ || dr_op == OP_WRITE) begin
					if (busy || !en_t) begin
						err <= 1'b1;
					end else begin
						busy   <= 1'b1;
						wb_cyc <= 1'b1;
						wb_stb <= 1'b1;
						wb_we  <= dr_op == OP_WRITE;
						wb_adr <= dr_adr;
						wb_dat <= dr_dat;
						wb_sel <= 4'hf;
					end
				end else if (!busy) begin
					err <= 1'b0;
				end
			end
		end
	end

endmodule
