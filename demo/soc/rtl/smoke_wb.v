// SPDX-License-Identifier: MIT
//
// smoke_wb.v — SoC Wishbone wrapper around generated smoke_regfile:
//   * RO: free-running status counter → ro_code / ro_busy
//   * RWW: free-running counter periodically writes via _strb/_hwdata
//   * RWE: 4-deep sync FIFO loopback (push on wren, pop on rden) with ready
//   * Shadow TGA tied to 0 (bank 0) for deterministic MMIO smoke
// Port names match wb_slv template (clk / rst_n / i_wb_addr / …).

`timescale 1ns / 1ps
`default_nettype none

module smoke_wb (
	input  wire        clk,
	input  wire        rst_n,
	input  wire        i_wb_cyc,
	input  wire        i_wb_stb,
	input  wire        i_wb_we,
	input  wire [31:0] i_wb_addr,
	input  wire [31:0] i_wb_data,
	input  wire [3:0]  i_wb_sel,
	output wire        o_wb_ack,
	output wire [31:0] o_wb_data
);

	// --- RO status counter ---
	reg [15:0] ro_cnt;
	always @(posedge clk or negedge rst_n) begin
		if (!rst_n)
			ro_cnt <= 16'h0;
		else
			ro_cnt <= ro_cnt + 16'h1;
	end
	wire        ro_busy = ro_cnt[8];
	wire [7:0]  ro_code = ro_cnt[7:0];

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

	// --- RWE 4-deep loopback FIFO ---
	reg [31:0] fifo_mem [0:3];
	reg [1:0]  fifo_wptr;
	reg [1:0]  fifo_rptr;
	reg [2:0]  fifo_count;

	wire        ext_wren;
	wire        ext_rden;
	wire [31:0] ext_wdata;
	wire        ext_rst;
	wire [31:0] ext_rdata;
	wire        ext_ready;

	wire fifo_full  = (fifo_count == 3'd4);
	wire fifo_empty = (fifo_count == 3'd0);

	// One ready for both dirs (read_write_block): write needs !full, read !empty.
	assign ext_ready = ext_wren ? ~fifo_full : (ext_rden ? ~fifo_empty : 1'b1);

	wire fifo_push = ext_wren & ext_ready;
	wire fifo_pop  = ext_rden & ext_ready;

	assign ext_rdata = fifo_mem[fifo_rptr];

	always @(posedge clk or negedge rst_n) begin
		if (!rst_n || ext_rst) begin
			fifo_wptr  <= 2'd0;
			fifo_rptr  <= 2'd0;
			fifo_count <= 3'd0;
		end else begin
			case ({fifo_push, fifo_pop})
				2'b10: begin
					fifo_mem[fifo_wptr] <= ext_wdata;
					fifo_wptr  <= fifo_wptr + 2'd1;
					fifo_count <= fifo_count + 3'd1;
				end
				2'b01: begin
					fifo_rptr  <= fifo_rptr + 2'd1;
					fifo_count <= fifo_count - 3'd1;
				end
				2'b11: begin
					fifo_mem[fifo_wptr] <= ext_wdata;
					fifo_wptr  <= fifo_wptr + 2'd1;
					fifo_rptr  <= fifo_rptr + 2'd1;
				end
				default: ;
			endcase
		end
	end

	wire        rg_enable;
	wire [2:0]  rg_mode;
	wire [15:0] rg_capture;
	wire        p_rg_go;
	wire        c_rg_sticky;
	wire [7:0]  rg_cfg;
	wire [1:0]  o_bank_sel;
	wire [31:0] rg_key_0;
	wire [31:0] rg_key_1;
	wire [31:0] rg_key_2;

	smoke_regfile u_csr (
		.i_clk              (clk),
		.i_rst_n            (rst_n),
		.i_wb_cyc           (i_wb_cyc),
		.i_wb_stb           (i_wb_stb),
		.i_wb_we            (i_wb_we),
		.i_wb_adr           (i_wb_addr[11:0]),
		.i_wb_dat           (i_wb_data),
		.i_wb_sel           (i_wb_sel),
		.i_wb_tga           (2'b00),
		.o_wb_ack           (o_wb_ack),
		.o_wb_dat           (o_wb_data),
		.ro_busy            (ro_busy),
		.ro_code            (ro_code),
		.rg_enable          (rg_enable),
		.rg_mode            (rg_mode),
		.rg_capture         (rg_capture),
		.rg_capture_strb    (rww_strb),
		.rg_capture_hwdata  (rww_cnt),
		.ext_data           (ext_rdata),
		.ext_data_wdata     (ext_wdata),
		.ext_data_wren      (ext_wren),
		.ext_data_rden      (ext_rden),
		.ext_data_rst       (ext_rst),
		.ext_data_ready     (ext_ready),
		.p_rg_go            (p_rg_go),
		.c_rg_sticky        (c_rg_sticky),
		.o_bank_sel         (o_bank_sel),
		.rg_cfg             (rg_cfg),
		.rg_key_0           (rg_key_0),
		.rg_key_1           (rg_key_1),
		.rg_key_2           (rg_key_2)
	);

	// Keep sideband outs from being optimized away in lint (observed via CSR reads).
	wire unused = |{rg_enable, rg_mode, rg_capture, p_rg_go, c_rg_sticky,
		rg_cfg, o_bank_sel, rg_key_0, rg_key_1, rg_key_2, i_wb_addr[31:12]};

endmodule

`default_nettype wire
