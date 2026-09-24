// SPDX-License-Identifier: MIT
//
// wb_cdc — Wishbone Classic clock-domain crossing (single outstanding).
//
// Source face (s_*) is a WB slave in s_clk; target face (m_*) is a WB master
// in the fabric clk. Four-phase req/ack handshake: only req / ack / alive cross
// through wb_sync_cell; the request and response bundles are held stable while
// the handshake is open and are captured by the synchronized control bit.
//
// Never hangs the source:
//   - fabric in reset (alive=0)            -> s_err at once
//   - no ack within TIMEOUT s_clk cycles   -> s_err (TIMEOUT=0 disables)
//   - after an abort, new requests get s_err until ack returns low
// Writes are non-posted: s_ack means the leaf acknowledged.
// TGA ports are always present; TW=0 keeps a 1-bit dummy.

module wb_cdc #(
	parameter int unsigned AW      = 32,
	parameter int unsigned TW      = 0,
	parameter int unsigned TIMEOUT = 0
) (
	input  logic                  s_clk,
	input  logic                  s_rst_n,
	input  logic                  s_cyc,
	input  logic                  s_stb,
	input  logic                  s_we,
	input  logic [AW-1:0]         s_adr,
	input  logic [31:0]           s_dat,
	input  logic [3:0]            s_sel,
	input  logic [(TW?TW:1)-1:0]  s_tga,
	output logic                  s_ack,
	output logic                  s_err,
	output logic [31:0]           s_rdat,

	input  logic                  clk,
	input  logic                  rst_n,
	output logic                  m_cyc,
	output logic                  m_stb,
	output logic                  m_we,
	output logic [AW-1:0]         m_adr,
	output logic [31:0]           m_dat,
	output logic [3:0]            m_sel,
	output logic [(TW?TW:1)-1:0]  m_tga,
	input  logic                  m_ack,
	input  logic [31:0]           m_rdat
);

	localparam int unsigned TMW = (TIMEOUT > 1) ? $clog2(TIMEOUT + 1) : 1;

	//--------------------------------------------------------------------------
	//  Source domain (s_clk)
	//--------------------------------------------------------------------------
	localparam logic [1:0] S_IDLE  = 2'd0;
	localparam logic [1:0] S_REQ   = 2'd1;
	localparam logic [1:0] S_WAIT  = 2'd2;
	localparam logic [1:0] S_DRAIN = 2'd3;

	logic [1:0]             s_state;
	logic                   req_q;
	logic                   ack_s;
	logic                   alive_s;
	logic                   req_bundle_we;
	logic [AW-1:0]          req_bundle_adr;
	logic [31:0]            req_bundle_dat;
	logic [3:0]             req_bundle_sel;
	logic [(TW?TW:1)-1:0]   req_bundle_tga;
	logic [31:0]            rsp_bundle_dat;
	logic [TMW-1:0]         tmo_cnt;
	logic                   s_req_new;
	logic                   tmo_hit;

	logic                   ack_q;
	logic                   alive_q;

	wb_sync_cell u_ack_sync (
		.clk(s_clk), .rst_n(s_rst_n), .d(ack_q), .q(ack_s)
	);
	wb_sync_cell u_alive_sync (
		.clk(s_clk), .rst_n(s_rst_n), .d(alive_q), .q(alive_s)
	);

	assign s_req_new = s_cyc && s_stb && !s_ack && !s_err;
	assign tmo_hit   = (TIMEOUT != 0) && (tmo_cnt == TMW'(TIMEOUT));

	always_ff @(posedge s_clk or negedge s_rst_n) begin
		if (!s_rst_n) begin
			s_state        <= S_IDLE;
			req_q          <= 1'b0;
			s_ack          <= 1'b0;
			s_err          <= 1'b0;
			s_rdat         <= 32'd0;
			tmo_cnt        <= '0;
			req_bundle_we  <= 1'b0;
			req_bundle_adr <= '0;
			req_bundle_dat <= 32'd0;
			req_bundle_sel <= 4'd0;
			req_bundle_tga <= '0;
		end else begin
			s_ack <= 1'b0;
			s_err <= 1'b0;
			case (s_state)
				S_IDLE: begin
					if (s_req_new) begin
						if (!alive_s || ack_s) begin
							s_err <= 1'b1;
						end else begin
							req_bundle_we  <= s_we;
							req_bundle_adr <= s_adr;
							req_bundle_dat <= s_dat;
							req_bundle_sel <= s_sel;
							req_bundle_tga <= s_tga;
							req_q          <= 1'b1;
							tmo_cnt        <= '0;
							s_state        <= S_REQ;
						end
					end
				end
				S_REQ: begin
					if (ack_s) begin
						s_ack   <= 1'b1;
						s_rdat  <= rsp_bundle_dat;
						req_q   <= 1'b0;
						tmo_cnt <= '0;
						s_state <= S_WAIT;
					end else if (!alive_s || tmo_hit) begin
						s_err   <= 1'b1;
						req_q   <= 1'b0;
						s_state <= S_DRAIN;
					end else if (TIMEOUT != 0) begin
						tmo_cnt <= tmo_cnt + 1'b1;
					end
				end
				S_WAIT: begin
					if (!ack_s) begin
						s_state <= S_IDLE;
					end else if (!alive_s || tmo_hit) begin
						s_state <= S_DRAIN;
					end else if (TIMEOUT != 0) begin
						tmo_cnt <= tmo_cnt + 1'b1;
					end
				end
				default: begin
					// Aborted: refuse new work until the target handshake closes.
					if (s_req_new) s_err <= 1'b1;
					if (!ack_s && alive_s) s_state <= S_IDLE;
				end
			endcase
		end
	end

	//--------------------------------------------------------------------------
	//  Target domain (clk)
	//--------------------------------------------------------------------------
	localparam logic [1:0] T_IDLE = 2'd0;
	localparam logic [1:0] T_BUS  = 2'd1;
	localparam logic [1:0] T_ACK  = 2'd2;

	logic [1:0] t_state;
	logic       req_t;

	wb_sync_cell u_req_sync (
		.clk(clk), .rst_n(rst_n), .d(req_q), .q(req_t)
	);

	always_ff @(posedge clk or negedge rst_n) begin
		if (!rst_n) begin
			t_state        <= T_IDLE;
			alive_q        <= 1'b0;
			ack_q          <= 1'b0;
			m_cyc          <= 1'b0;
			m_stb          <= 1'b0;
			m_we           <= 1'b0;
			m_adr          <= '0;
			m_dat          <= 32'd0;
			m_sel          <= 4'd0;
			m_tga          <= '0;
			rsp_bundle_dat <= 32'd0;
		end else begin
			alive_q <= 1'b1;
			case (t_state)
				T_IDLE: begin
					if (req_t) begin
						m_we    <= req_bundle_we;
						m_adr   <= req_bundle_adr;
						m_dat   <= req_bundle_dat;
						m_sel   <= req_bundle_sel;
						m_tga   <= req_bundle_tga;
						m_cyc   <= 1'b1;
						m_stb   <= 1'b1;
						t_state <= T_BUS;
					end
				end
				T_BUS: begin
					if (m_ack) begin
						rsp_bundle_dat <= m_rdat;
						m_cyc          <= 1'b0;
						m_stb          <= 1'b0;
						ack_q          <= 1'b1;
						t_state        <= T_ACK;
					end
				end
				default: begin
					if (!req_t) begin
						ack_q   <= 1'b0;
						t_state <= T_IDLE;
					end
				end
			endcase
		end
	end

endmodule
