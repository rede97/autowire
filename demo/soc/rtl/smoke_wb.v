// SPDX-License-Identifier: MIT
//
// smoke_wb.v — sideband glue for smoke_regfile (no Wishbone).
// CSR leaf lives on soc_top next to the interconnect; this module only
// drives RO/RWW/RWE sidebands (counter + 4-deep FIFO loopback).

`timescale 1ns / 1ps
`default_nettype none

module smoke_wb (
	input  wire        clk,
	input  wire        rst_n,

	// RO status
	output wire        ro_busy,
	output wire [7:0]  ro_code,

	// RWW HW write pulse
	output wire        rg_capture_strb,
	output wire [15:0] rg_capture_hwdata,

	// RWE FIFO loopback
	input  wire [31:0] ext_data_wdata,
	input  wire        ext_data_wren,
	input  wire        ext_data_rden,
	input  wire        ext_data_rst,
	output wire [31:0] ext_data,
	output wire        ext_data_ready
);

	// --- RO status counter ---
	reg [15:0] ro_cnt;
	always @(posedge clk or negedge rst_n) begin
		if (!rst_n)
			ro_cnt <= 16'h0;
		else
			ro_cnt <= ro_cnt + 16'h1;
	end
	assign ro_busy = ro_cnt[8];
	assign ro_code = ro_cnt[7:0];

	// --- RWW HW counter (pulse strb every 16 cycles) ---
	reg [15:0] rww_cnt;
	reg [3:0]  rww_div;
	reg        rww_strb;
	always @(posedge clk or negedge rst_n) begin
		if (!rst_n) begin
			rww_cnt  <= 16'h0;
			rww_div  <= 4'h0;
			rww_strb <= 1'b0;
		end else begin
			rww_div  <= rww_div + 4'h1;
			rww_strb <= (rww_div == 4'hf);
			if (rww_div == 4'hf)
				rww_cnt <= rww_cnt + 16'h1;
		end
	end
	assign rg_capture_strb   = rww_strb;
	assign rg_capture_hwdata = rww_cnt;

	// --- RWE 4-deep loopback FIFO ---
	reg [31:0] fifo_mem [0:3];
	reg [1:0]  fifo_wptr;
	reg [1:0]  fifo_rptr;
	reg [2:0]  fifo_count;

	wire fifo_full  = (fifo_count == 3'd4);
	wire fifo_empty = (fifo_count == 3'd0);

	assign ext_data_ready = ext_data_wren ? ~fifo_full
		: (ext_data_rden ? ~fifo_empty : 1'b1);

	wire fifo_push = ext_data_wren & ext_data_ready;
	wire fifo_pop  = ext_data_rden & ext_data_ready;

	assign ext_data = fifo_mem[fifo_rptr];

	always @(posedge clk or negedge rst_n) begin
		if (!rst_n || ext_data_rst) begin
			fifo_wptr  <= 2'd0;
			fifo_rptr  <= 2'd0;
			fifo_count <= 3'd0;
		end else begin
			case ({fifo_push, fifo_pop})
				2'b10: begin
					fifo_mem[fifo_wptr] <= ext_data_wdata;
					fifo_wptr  <= fifo_wptr + 2'd1;
					fifo_count <= fifo_count + 3'd1;
				end
				2'b01: begin
					fifo_rptr  <= fifo_rptr + 2'd1;
					fifo_count <= fifo_count - 3'd1;
				end
				2'b11: begin
					fifo_mem[fifo_wptr] <= ext_data_wdata;
					fifo_wptr  <= fifo_wptr + 2'd1;
					fifo_rptr  <= fifo_rptr + 2'd1;
				end
				default: ;
			endcase
		end
	end

endmodule

`default_nettype wire
