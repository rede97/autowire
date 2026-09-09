// SPDX-License-Identifier: MIT
//
// sd_rd_dma.v
//
// SD card read DMA: a small Wishbone master that repeatedly reads one fixed
// Wishbone address (an sdspi FIFO data register) and pushes the words out as
// an AXI4-Stream packet. The CPU programs SRC / LEN over the Wishbone slave
// port and starts the transfer with CTRL.start.
//
// Slave register map (word offset, 16-byte window):
//   0x0 CTRL   bit0: start (W1S), bit1: src_inc (RW; 0 = fixed FIFO
//              address, e.g. sdspi FIFO data register; 1 = address
//              increments by 4 per beat, for memory buffers)
//   0x4 STATUS bit0: busy (RO), bit1: done (RW, write 1 clears)
//   0x8 SRC    Wishbone byte address to read (first/only beat address)
//
// o_irq mirrors the sticky done flag.
// Master port names follow picorv32_wb so both share one connect template.

`timescale 1ns / 1ps
`default_nettype none

module sd_rd_dma (
	input wire clk,
	input wire rst_n,

	// Wishbone slave: control/status
	input  wire        i_wb_cyc,
	input  wire        i_wb_stb,
	input  wire        i_wb_we,
	input  wire [31:0] i_wb_addr,
	input  wire [31:0] i_wb_data,
	input  wire [3:0]  i_wb_sel,
	output reg         o_wb_ack,
	output reg  [31:0] o_wb_data,

	// Wishbone master: FIFO reads (classic cycle, one beat in flight)
	output reg         wbm_cyc_o,
	output reg         wbm_stb_o,
	output reg         wbm_we_o,
	output reg  [31:0] wbm_adr_o,
	output reg  [31:0] wbm_dat_o,
	output reg  [3:0]  wbm_sel_o,
	input  wire        wbm_ack_i,
	input  wire [31:0] wbm_dat_i,

	// AXI4-Stream master: payload to the sha256 lane
	output reg  [31:0] m_axis_tdata,
	output reg         m_axis_tvalid,
	input  wire        m_axis_tready,
	output reg         m_axis_tlast,

	output wire o_irq
);

	localparam ST_IDLE = 2'd0;
	localparam ST_READ = 2'd1;  // Wishbone read in flight
	localparam ST_PUSH = 2'd2;  // word waits for stream acceptance

	reg [1:0]  state;
	reg [31:0] src_addr;
	reg        src_inc;
	reg [31:0] length;
	reg [31:0] count;
	reg        busy;
	reg        done;

	assign o_irq = done;

	wire slv_sel = i_wb_cyc & i_wb_stb;
	wire wr_en = slv_sel & i_wb_we & ~o_wb_ack;
	wire wr_start = wr_en & (i_wb_addr[3:2] == 2'd0) & i_wb_data[0];
	wire wr_done_clr = wr_en & (i_wb_addr[3:2] == 2'd1) & i_wb_data[1];

	// ------------------------------------------------------------
	// Slave register file
	// ------------------------------------------------------------
	always @(posedge clk) begin
		if (!rst_n) begin
			o_wb_ack  <= 1'b0;
			o_wb_data <= 32'h0;
			src_addr  <= 32'h0;
			length    <= 32'h0;
			src_inc   <= 1'b0;
		end else begin
			o_wb_ack <= slv_sel & ~o_wb_ack;
			if (wr_en) begin
				case (i_wb_addr[3:2])
					2'd2: src_addr <= i_wb_data;
					2'd3: length   <= i_wb_data;
					default: ;
				endcase
			end
			case (i_wb_addr[3:2])
				2'd1: o_wb_data <= {30'h0, done, busy};
				2'd2: o_wb_data <= src_addr;
				2'd3: o_wb_data <= length;
				default: o_wb_data <= 32'h0;
			endcase

			if (wr_en && i_wb_addr[3:2] == 2'd0)
				src_inc <= i_wb_data[1];
		end
	end

	// ------------------------------------------------------------
	// Master + stream FSM (single driver for state/busy/done)
	// ------------------------------------------------------------
	always @(posedge clk) begin
		if (!rst_n) begin
			state         <= ST_IDLE;
			busy          <= 1'b0;
			count         <= 32'h0;
			done          <= 1'b0;
			wbm_cyc_o     <= 1'b0;
			wbm_stb_o     <= 1'b0;
			wbm_we_o      <= 1'b0;
			wbm_adr_o     <= 32'h0;
			wbm_dat_o     <= 32'h0;
			wbm_sel_o     <= 4'h0;
			m_axis_tdata  <= 32'h0;
			m_axis_tvalid <= 1'b0;
			m_axis_tlast  <= 1'b0;
		end else begin
			if (wr_done_clr)
				done <= 1'b0;
			case (state)
			ST_IDLE: begin
				if (wr_start && length != 0) begin
					state <= ST_READ;
					busy  <= 1'b1;
					count <= 32'h0;
					done  <= 1'b0;
				end
			end
			ST_READ: begin
				// Hold STB until ACK (classic WB through the interconnect).
				wbm_cyc_o <= 1'b1;
				wbm_stb_o <= 1'b1;
				wbm_we_o  <= 1'b0;
				wbm_adr_o <= src_addr + (src_inc ? (count << 2) : 32'h0);
				wbm_sel_o <= 4'hf;
				if (wbm_cyc_o && wbm_stb_o && wbm_ack_i) begin
					wbm_cyc_o     <= 1'b0;
					wbm_stb_o     <= 1'b0;
					m_axis_tdata  <= wbm_dat_i;
					m_axis_tvalid <= 1'b1;
					m_axis_tlast  <= (count == length - 1);
					state         <= ST_PUSH;
				end
			end
			ST_PUSH: begin
				if (m_axis_tvalid && m_axis_tready) begin
					m_axis_tvalid <= 1'b0;
					m_axis_tlast  <= 1'b0;
					count <= count + 1;
					if (count == length - 1) begin
						state <= ST_IDLE;
						busy  <= 1'b0;
						done  <= 1'b1;
					end else begin
						state <= ST_READ;
					end
				end
			end
			default: state <= ST_IDLE;
			endcase
		end
	end

endmodule

`default_nettype wire
