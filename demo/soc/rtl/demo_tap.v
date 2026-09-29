// SPDX-License-Identifier: MIT
//
// demo_tap — minimal IEEE 1149.1 TAP controller for the demo SoC.
//
// DFT PLACEHOLDER: in a real flow the chip TAP (IR, BYPASS, IDCODE, BSR) is
// inserted by the DFT tool and drives the soc_wb dbg TDR through a user
// instruction or SIB (docs/plugins/wishbone-master.md §5). This module only
// exists so the demo can be smoke-tested from external JTAG pins.
//
// IR (4 bit, capture 4'b0001): IDCODE 4'b0001 (reset), USER 4'b1000 selects the
// dbg TDR, everything else is BYPASS. TDO changes on the falling edge of TCK.

module demo_tap #(
	parameter [31:0] IDCODE = 32'h1a57_0001
) (
	// External JTAG pins
	input  wire jtag_tck,
	input  wire jtag_tms,
	input  wire jtag_tdi,
	input  wire jtag_trst_n,
	output reg  jtag_tdo,

	// TDR client (soc_wb_bus_cfg dbg_*)
	output wire dbg_tck,
	output wire dbg_trst_n,
	output wire dbg_sel,
	output wire dbg_capture_dr,
	output wire dbg_shift_dr,
	output wire dbg_update_dr,
	output wire dbg_tdi,
	input  wire dbg_tdo
);

	localparam [3:0] TLR   = 4'hf, RTI   = 4'hc, SELDR = 4'h7, CAPDR = 4'h6,
	                 SHDR  = 4'h2, EX1DR = 4'h1, PADR  = 4'h3, EX2DR = 4'h0,
	                 UPDR  = 4'h5, SELIR = 4'h4, CAPIR = 4'he, SHIR  = 4'ha,
	                 EX1IR = 4'h9, PAIR  = 4'hb, EX2IR = 4'h8, UPIR  = 4'hd;

	localparam [3:0] IR_IDCODE = 4'b0001;
	localparam [3:0] IR_USER   = 4'b1000;

	reg [3:0]  state;
	reg [3:0]  state_nxt;
	reg [3:0]  ir;
	reg [3:0]  ir_sr;
	reg [31:0] id_sr;
	reg        bypass_sr;

	always @(*) begin
		case (state)
			TLR:     state_nxt = jtag_tms ? TLR   : RTI;
			RTI:     state_nxt = jtag_tms ? SELDR : RTI;
			SELDR:   state_nxt = jtag_tms ? SELIR : CAPDR;
			CAPDR:   state_nxt = jtag_tms ? EX1DR : SHDR;
			SHDR:    state_nxt = jtag_tms ? EX1DR : SHDR;
			EX1DR:   state_nxt = jtag_tms ? UPDR  : PADR;
			PADR:    state_nxt = jtag_tms ? EX2DR : PADR;
			EX2DR:   state_nxt = jtag_tms ? UPDR  : SHDR;
			UPDR:    state_nxt = jtag_tms ? SELDR : RTI;
			SELIR:   state_nxt = jtag_tms ? TLR   : CAPIR;
			CAPIR:   state_nxt = jtag_tms ? EX1IR : SHIR;
			SHIR:    state_nxt = jtag_tms ? EX1IR : SHIR;
			EX1IR:   state_nxt = jtag_tms ? UPIR  : PAIR;
			PAIR:    state_nxt = jtag_tms ? EX2IR : PAIR;
			EX2IR:   state_nxt = jtag_tms ? UPIR  : SHIR;
			default: state_nxt = jtag_tms ? SELDR : RTI;
		endcase
	end

	always @(posedge jtag_tck or negedge jtag_trst_n) begin
		if (!jtag_trst_n) state <= TLR;
		else              state <= state_nxt;
	end

	always @(posedge jtag_tck or negedge jtag_trst_n) begin
		if (!jtag_trst_n) begin
			ir        <= IR_IDCODE;
			ir_sr     <= 4'b0001;
			id_sr     <= 32'd0;
			bypass_sr <= 1'b0;
		end else begin
			case (state)
				TLR:   ir    <= IR_IDCODE;
				CAPIR: ir_sr <= 4'b0001;
				SHIR:  ir_sr <= {jtag_tdi, ir_sr[3:1]};
				UPIR:  ir    <= ir_sr;
				CAPDR: begin
					id_sr     <= IDCODE;
					bypass_sr <= 1'b0;
				end
				SHDR: begin
					id_sr     <= {jtag_tdi, id_sr[31:1]};
					bypass_sr <= jtag_tdi;
				end
				default: ;
			endcase
		end
	end

	always @(negedge jtag_tck or negedge jtag_trst_n) begin
		if (!jtag_trst_n)       jtag_tdo <= 1'b0;
		else if (state == SHIR) jtag_tdo <= ir_sr[0];
		else if (state == SHDR) jtag_tdo <= (ir == IR_IDCODE) ? id_sr[0] :
		                                    (ir == IR_USER)   ? dbg_tdo  : bypass_sr;
		else                    jtag_tdo <= 1'b0;
	end

	assign dbg_tck        = jtag_tck;
	assign dbg_trst_n     = jtag_trst_n;
	assign dbg_tdi        = jtag_tdi;
	assign dbg_sel        = (ir == IR_USER);
	assign dbg_capture_dr = (state == CAPDR);
	assign dbg_shift_dr   = (state == SHDR);
	assign dbg_update_dr  = (state == UPDR);

endmodule
