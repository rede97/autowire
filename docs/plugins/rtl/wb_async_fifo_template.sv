// SPDX-License-Identifier: MIT
//
// wb_async_fifo — fixed FIFO ABI with an optional technology cell.
// Without AUTOWIRE_ASYNC_FIFO_CELL, use the built-in Gray-pointer FIFO.
// Define AUTOWIRE_ASYNC_FIFO_CELL to a module name to select an external
// CELL_ASYNC_FIFO-compatible cell/adapter (WIDTH, DEPTH, wr_*/rd_* ports).
// A selected but missing cell is a compilation error, never a fallback.
//
// Registered read: accepted rd_en updates rd_data after that edge; the
// consumer captures it on the following edge. Both endpoints must be reset
// together. External adapters must mask I/O until reset release completes.
// The built-in implementation waits two local edges on each endpoint.

module wb_async_fifo #(
    parameter int unsigned WIDTH = 32,
    parameter int unsigned DEPTH = 8
) (
    input  logic             wr_clk,
    input  logic             wr_rst_n,
    input  logic             rd_clk,
    input  logic             rd_rst_n,
    input  logic             wr_en,
    input  logic             rd_en,
    input  logic [WIDTH-1:0] wr_data,
    output logic             wr_full,
    output logic             rd_empty,
    output logic [WIDTH-1:0] rd_data
);

`ifdef AUTOWIRE_ASYNC_FIFO_CELL
    wire unused_afull, unused_aempty;
    `AUTOWIRE_ASYNC_FIFO_CELL #(.WIDTH(WIDTH), .DEPTH(DEPTH)) u_cell (
        .wr_clk(wr_clk), .wr_rst_n(wr_rst_n),
        .rd_clk(rd_clk), .rd_rst_n(rd_rst_n),
        .wr_en(wr_en), .rd_en(rd_en), .wr_data(wr_data),
        .wr_full(wr_full), .wr_afull(unused_afull),
        .rd_empty(rd_empty), .rd_aempty(unused_aempty), .rd_data(rd_data)
    );
`else
    wb_async_fifo_gray #(.WIDTH(WIDTH), .DEPTH(DEPTH)) u_gray (
        .wr_clk(wr_clk), .wr_rst_n(wr_rst_n),
        .rd_clk(rd_clk), .rd_rst_n(rd_rst_n),
        .wr_en(wr_en), .rd_en(rd_en), .wr_data(wr_data),
        .wr_full(wr_full), .rd_empty(rd_empty), .rd_data(rd_data)
    );
`endif

    initial begin
        if (WIDTH < 1)
            $fatal(1, "wb_async_fifo WIDTH must be at least 1");
        if (DEPTH < 2)
            $fatal(1, "wb_async_fifo DEPTH must be at least 2");
        if ((DEPTH & (DEPTH - 1)) != 0)
            $fatal(1, "wb_async_fifo DEPTH must be a power of two");
    end
endmodule

// Built-in synthesizable implementation; not a model of a vendor cell.
module wb_async_fifo_gray #(
    parameter int unsigned WIDTH = 32,
    parameter int unsigned DEPTH = 8
) (
    input logic wr_clk, wr_rst_n, rd_clk, rd_rst_n,
    input logic wr_en, rd_en,
    input logic [WIDTH-1:0] wr_data,
    output logic wr_full, rd_empty,
    output logic [WIDTH-1:0] rd_data
);
    localparam int unsigned SAFE_DEPTH = (DEPTH < 2) ? 2 : DEPTH;
    localparam int unsigned ADDR_W = (DEPTH < 2) ? 1 : $clog2(DEPTH);
    localparam int unsigned PTR_W = ADDR_W + 1;
    localparam logic [PTR_W-1:0] FULL_MASK =
        {2'b11, {(PTR_W-2){1'b0}}};

    logic [WIDTH-1:0] mem [0:SAFE_DEPTH-1];
    logic [PTR_W-1:0] wr_bin_q, wr_gray_q;
    logic [PTR_W-1:0] rd_bin_q, rd_gray_q;
    logic [PTR_W-1:0] rd_gray_wr_sync, wr_gray_rd_sync;

    // Reset release is synchronized through the standard CDC cell so the
    // default implementation can be replaced consistently for signoff.
    wire wr_ready;
    wire rd_ready;
    wb_sync_cell #(.STAGES(2), .RESET_VAL(1'b0)) u_wr_release (
        .clk(wr_clk), .rst_n(wr_rst_n), .d(1'b1), .q(wr_ready)
    );
    wb_sync_cell #(.STAGES(2), .RESET_VAL(1'b0)) u_rd_release (
        .clk(rd_clk), .rst_n(rd_rst_n), .d(1'b1), .q(rd_ready)
    );

    genvar bitno;
    generate
        for (bitno = 0; bitno < PTR_W; bitno++) begin : g_pointer_sync
            wb_sync_cell #(.STAGES(2), .RESET_VAL(1'b0)) u_rd_to_wr (
                .clk(wr_clk), .rst_n(wr_rst_n),
                .d(rd_gray_q[bitno]), .q(rd_gray_wr_sync[bitno])
            );
            wb_sync_cell #(.STAGES(2), .RESET_VAL(1'b0)) u_wr_to_rd (
                .clk(rd_clk), .rst_n(rd_rst_n),
                .d(wr_gray_q[bitno]), .q(wr_gray_rd_sync[bitno])
            );
        end
    endgenerate

    logic [PTR_W-1:0] wr_bin_next, wr_gray_next;
    logic [PTR_W-1:0] rd_bin_next, rd_gray_next;
    logic wr_full_q, rd_empty_q;
    logic wr_full_next, rd_empty_next;
    wire wr_fire = wr_en && !wr_full;
    wire rd_fire = rd_en && !rd_empty;

    always_comb begin
        wr_bin_next = wr_bin_q;
        if (wr_fire)
            wr_bin_next = wr_bin_q + 1'b1;
        wr_gray_next = (wr_bin_next >> 1) ^ wr_bin_next;
        wr_full_next = (wr_gray_next ==
                        (rd_gray_wr_sync ^ FULL_MASK));

        rd_bin_next = rd_bin_q;
        if (rd_fire)
            rd_bin_next = rd_bin_q + 1'b1;
        rd_gray_next = (rd_bin_next >> 1) ^ rd_bin_next;
        rd_empty_next = (rd_gray_next == wr_gray_rd_sync);
    end

    // Flags remain conservative while local reset release synchronizes.
    assign wr_full = !wr_ready || wr_full_q;
    assign rd_empty = !rd_ready || rd_empty_q;

    always_ff @(posedge wr_clk or negedge wr_rst_n) begin
        if (!wr_rst_n) begin
            wr_bin_q <= '0;
            wr_gray_q <= '0;
            wr_full_q <= 1'b0;
        end else if (!wr_ready) begin
            wr_bin_q <= '0;
            wr_gray_q <= '0;
            wr_full_q <= 1'b0;
        end else begin
            wr_bin_q <= wr_bin_next;
            wr_gray_q <= wr_gray_next;
            wr_full_q <= wr_full_next;
        end
    end

    always_ff @(posedge wr_clk) begin
        if (wr_fire)
            mem[wr_bin_q[ADDR_W-1:0]] <= wr_data;
    end

    always_ff @(posedge rd_clk or negedge rd_rst_n) begin
        if (!rd_rst_n) begin
            rd_bin_q <= '0;
            rd_gray_q <= '0;
            rd_empty_q <= 1'b1;
            rd_data <= '0;
        end else if (!rd_ready) begin
            rd_bin_q <= '0;
            rd_gray_q <= '0;
            rd_empty_q <= 1'b1;
            rd_data <= '0;
        end else begin
            rd_bin_q <= rd_bin_next;
            rd_gray_q <= rd_gray_next;
            rd_empty_q <= rd_empty_next;
            if (rd_fire)
                rd_data <= mem[rd_bin_q[ADDR_W-1:0]];
        end
    end

endmodule
