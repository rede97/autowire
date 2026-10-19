// SPDX-License-Identifier: MIT
//
// wb_cdc — posted command FIFO / blocking read FIFO bridge.
// Reference: Gitee autowire master 435180e, cfgbus/cfg_apb.py.
// Preserve its depth-8 command FIFO, depth-2 read FIFO, registered pop
// timing and held target command. WB ACK replaces cfg command-ready /
// read-data-valid; TGA is carried with the command.
//
// Source write ACK means FIFO acceptance, NOT target completion. A read
// waits behind earlier commands and returns only the target read response.
// There is no timeout, reset-error response or automatic recovery handshake.
// Both domains must be reset together, with traffic quiesced; independently
// resetting a live FIFO endpoint is unsupported. Pausing clocks is allowed.
// Select CELL_ASYNC_FIFO through the wb_async_fifo wrapper when available;
// its registered read and coordinated-reset ABI must remain unchanged.

module wb_cdc #(
	parameter int unsigned AW = 32,
	parameter int unsigned TW = 1
) (
	input  logic                  s_clk,
	input  logic                  s_rst_n,
	input  logic                  s_cyc,
	input  logic                  s_stb,
	input  logic                  s_we,
	input  logic [AW-1:0]         s_adr,
	input  logic [31:0]           s_dat,
	input  logic [3:0]            s_sel,
	input  logic [TW-1:0]         s_tga,
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
	output logic [TW-1:0]         m_tga,
	input  logic                  m_ack,
	input  logic [31:0]           m_rdat
);
	localparam int unsigned CW = 32 + 4 + 1 + AW + TW;
	logic cmd_full, cmd_empty, cmd_push, cmd_pop;
	logic read_full, read_empty, read_push, read_pop;
	logic [CW-1:0] cmd_data;
	logic [31:0] read_data;
	logic read_pending, read_pop_p1;
	logic cmd_valid, cmd_pop_p1;

	// Like apb2cfg: write acceptance is independent of target execution.
	assign cmd_push = s_cyc && s_stb && !s_ack && !read_pending && !cmd_full;
	assign read_pop = read_pending && !read_pop_p1 && !read_empty;
	assign s_err = 1'b0;

	wb_async_fifo #(.WIDTH(CW), .DEPTH(8)) u_cmd_fifo (
		.wr_clk(s_clk), .wr_rst_n(s_rst_n), .rd_clk(clk), .rd_rst_n(rst_n),
		.wr_en(cmd_push), .wr_data({s_dat, s_sel, s_we, s_adr, s_tga}),
		.wr_full(cmd_full), .rd_en(cmd_pop), .rd_data(cmd_data), .rd_empty(cmd_empty)
	);
	wb_async_fifo #(.WIDTH(32), .DEPTH(2)) u_read_fifo (
		.wr_clk(clk), .wr_rst_n(rst_n), .rd_clk(s_clk), .rd_rst_n(s_rst_n),
		.wr_en(read_push), .wr_data(m_rdat), .wr_full(read_full),
		.rd_en(read_pop), .rd_data(read_data), .rd_empty(read_empty)
	);

	always_ff @(posedge s_clk or negedge s_rst_n) begin
		if (!s_rst_n) begin
			read_pending <= 1'b0;
			read_pop_p1 <= 1'b0;
			s_ack <= 1'b0;
			s_rdat <= '0;
		end else begin
			read_pop_p1 <= read_pop;
			s_ack <= 1'b0;
			if (cmd_push) begin
				if (s_we) s_ack <= 1'b1;
				else read_pending <= 1'b1;
			end
			if (read_pop_p1) begin
				s_rdat <= read_data;
				s_ack <= 1'b1;
				read_pending <= 1'b0;
			end
		end
	end

	// Reference cfg_cmd_vld / fifo_pop_p1 sequencing. A registered FIFO
	// read is captured one edge after pop and held until the WB ACK.
	// Reserve read-response space before taking another command.
	assign cmd_pop = !cmd_empty && !cmd_valid && !read_full;
	assign read_push = m_cyc && m_ack && !m_we;
	always_ff @(posedge clk or negedge rst_n) begin
		if (!rst_n) begin
			cmd_valid <= 1'b0;
			cmd_pop_p1 <= 1'b0;
			m_cyc <= 1'b0;
			m_stb <= 1'b0;
			m_we <= 1'b0;
			m_adr <= '0;
			m_dat <= '0;
			m_sel <= '0;
			m_tga <= '0;
		end else begin
			cmd_pop_p1 <= cmd_pop;
			if (cmd_pop) cmd_valid <= 1'b1;
			if (cmd_pop_p1) begin
				{m_dat, m_sel, m_we, m_adr, m_tga} <= cmd_data;
				m_cyc <= 1'b1;
				m_stb <= 1'b1;
			end
			if (m_cyc && m_ack) begin
				cmd_valid <= 1'b0;
				m_cyc <= 1'b0;
				m_stb <= 1'b0;
			end
		end
	end
endmodule
