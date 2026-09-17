// SPDX-License-Identifier: MIT
//
// wb_cfg_pipe.sv — draft cfg fabric pipe (posted write / blocking read)
//
// Intent (aligns with legacy cfgbus acceleration):
//   * Write: ACK as soon as the command is accepted into the queue (not when
//     it retires at the leaf). Multiple writes may be buffered (PIPE).
//   * Read: never early-ACK; master waits until the matching read returns
//     from downstream. Ordered FIFO ⇒ a read drains prior writes (barrier).
//
// Handshake:
//   Upstream Classic-like: hold STB until ACK (writes may ACK same cycle;
//   reads ACK only with returned DAT).
//   Downstream: present head with STB; pop on s_ack (one beat per accept).
//
// TGA is not a beat field: pack {tga, adr} into m_adr / unpack s_adr at the
// leaf (emit does this). Return ACK is already read-only at [PIPE+1]
// (s_stb & s_ack & !s_we), so registered stages copy ack without & !we.
//
// Not yet: multi-master arb, PIPE==0 combinatorial bypass, formal.
// Review focus: posted-vs-blocking split and queue ownership.

module wb_cfg_pipe #(
	parameter int unsigned PIPE = 4,
	parameter int unsigned AW    = 32
) (
	input  logic             clk,
	input  logic             rst_n,

	// Upstream (toward master)
	input  logic             m_cyc,
	input  logic             m_stb,
	input  logic             m_we,
	input  logic [AW-1:0]    m_adr,
	input  logic [31:0]      m_dat,
	input  logic [3:0]       m_sel,
	output logic             m_ack,
	output logic [31:0]      m_rdat,

	// Downstream (toward arbiter / decoder / leaf)
	output logic             s_cyc,
	output logic             s_stb,
	output logic             s_we,
	output logic [AW-1:0]    s_adr,
	output logic [31:0]      s_dat,
	output logic [3:0]       s_sel,
	input  logic             s_ack,
	input  logic [31:0]      s_rdat
);

	typedef struct packed {
		// cmd
		logic             cyc;
		logic             ack;
		logic             stb;
		// addr r/w
		logic             we;
		logic [AW-1:0]    adr;
		logic [3:0]       sel;
		// data
		logic [31:0]      wdat;
		logic [31:0]      rdat;
	} beat_slice_t;

	beat_slice_t pipe_beats [0:PIPE-1+2];


	always_comb begin
		// from master port
		pipe_beats[0].cyc  = m_cyc;
		pipe_beats[0].ack  = m_cyc & m_stb & (m_we ? !pipe_beats[1].stb : pipe_beats[1].ack);
		pipe_beats[0].stb  = m_stb;
		pipe_beats[0].we   = m_we;
		pipe_beats[0].adr  = m_adr;
		pipe_beats[0].sel  = m_sel;
		pipe_beats[0].wdat = m_dat;
		pipe_beats[0].rdat = pipe_beats[1].rdat;

		m_ack              = pipe_beats[0].ack;
		m_rdat             = pipe_beats[0].rdat;

		// to slave port
		s_cyc = pipe_beats[PIPE].cyc;
		s_stb = pipe_beats[PIPE].stb;
		s_we  = pipe_beats[PIPE].we;
		s_adr = pipe_beats[PIPE].adr;
		s_dat = pipe_beats[PIPE].wdat;
		s_sel = pipe_beats[PIPE].sel;
		pipe_beats[PIPE+1].cyc  = pipe_beats[PIPE].cyc;
		pipe_beats[PIPE+1].ack  = s_stb & s_ack & (!s_we);
		pipe_beats[PIPE+1].stb  = s_stb & (!s_ack);
		pipe_beats[PIPE+1].we   = pipe_beats[PIPE].we;
		pipe_beats[PIPE+1].adr  = pipe_beats[PIPE].adr;
		pipe_beats[PIPE+1].sel  = pipe_beats[PIPE].sel;
		pipe_beats[PIPE+1].wdat = pipe_beats[PIPE].wdat;
		pipe_beats[PIPE+1].rdat = s_rdat;
	end

	for (genvar i = 1; i <= PIPE; i += 1) begin
		always_ff @( posedge clk or negedge rst_n) begin
			if (!rst_n) begin
				// Generated interconnect uses whole-element NBA (q[i] <= nxtq):
				// Icarus rejects pipe_beats[i].field <= … on a struct array.
				pipe_beats[i].cyc  <= 1'b0;
				pipe_beats[i].ack  <= 1'b0;
				pipe_beats[i].stb  <= 1'b0;
				pipe_beats[i].we   <= 1'b0;
				pipe_beats[i].adr  <= {AW{1'b0}};
				pipe_beats[i].sel  <= 4'h0;
				pipe_beats[i].wdat <= 32'h00000000;
				pipe_beats[i].rdat <= 32'h00000000;
			end else begin
				pipe_beats[i].ack  <= pipe_beats[i+1].ack;
				pipe_beats[i].rdat <= pipe_beats[i+1].rdat;
				if (pipe_beats[i].stb == 1'b0) begin
					pipe_beats[i].cyc  <= pipe_beats[i-1].cyc;
					// Do not reload a completing read (Classic STB-on-ACK)
					// or refill a just-vacated stage from an upstream copy.
					if (pipe_beats[i-1].stb && (pipe_beats[i-1].we || !pipe_beats[i-1].ack)
						&& !pipe_beats[i].ack) begin
						pipe_beats[i].stb  <= pipe_beats[i-1].stb;
						pipe_beats[i].we   <= pipe_beats[i-1].we;
						pipe_beats[i].adr  <= pipe_beats[i-1].adr;
						pipe_beats[i].sel  <= pipe_beats[i-1].sel;
						pipe_beats[i].wdat <= pipe_beats[i-1].wdat;
					end
				end else begin if (pipe_beats[i].we & !pipe_beats[i+1].stb) begin
						pipe_beats[i].cyc  <= pipe_beats[i-1].cyc;
						pipe_beats[i].stb  <= 1'b0;
						pipe_beats[i].we   <= 1'b0;
						pipe_beats[i].adr  <= {AW{1'b0}};
						pipe_beats[i].sel  <= 4'h0;
						pipe_beats[i].wdat <= 32'h00000000;
					end else if (pipe_beats[i+1].ack) begin
						pipe_beats[i].cyc  <= 1'b0;
						pipe_beats[i].stb  <= 1'b0;
						pipe_beats[i].we   <= 1'b0;
						pipe_beats[i].adr  <= {AW{1'b0}};
						pipe_beats[i].sel  <= 4'h0;
						pipe_beats[i].wdat <= 32'h00000000;
					end
				end
			end
		end
	end
	
endmodule

