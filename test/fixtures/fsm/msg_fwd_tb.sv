// Behavior check for the generated msg_fwd (docs/state/async-fsm.md §6.1.1):
// a multi-bit Output carries the fixed header, the forwarded message or the
// ?: error code on its move cycle, and is 0 otherwise.
module tb;
  logic       clk = 1'b0, rst_n = 1'b0, go = 1'b0, full = 1'b0, rx_vld = 1'b0, rx_err = 1'b0;
  logic [7:0] rx_msg = 8'h00;
  logic       wr_en;
  logic [7:0] wr_data;

  msg_fwd dut (.*);

  always #5 clk = ~clk;

  task automatic step();
    @(posedge clk);
    #1;
  endtask

  task automatic expect_out(input logic en, input logic [7:0] data, input string what);
    #1 if (wr_en !== en || wr_data !== data)
      $fatal(1, "%s: wr_en=%b wr_data=%h, expected %b %h", what, wr_en, wr_data, en, data);
  endtask

  initial begin
    step();
    rst_n = 1'b1;
    step();
    expect_out(1'b0, 8'h00, "idle");
    go = 1'b1;
    expect_out(1'b1, 8'ha5, "header");
    full = 1'b1;
    expect_out(1'b0, 8'h00, "header held back by full");
    full = 1'b0;
    step();
    go = 1'b0;
    expect_out(1'b0, 8'h00, "waiting in FWD");
    rx_vld = 1'b1;
    rx_msg = 8'h3c;
    expect_out(1'b1, 8'h3c, "forward");
    rx_err = 1'b1;
    expect_out(1'b1, 8'hee, "error code");
    step();
    rx_vld = 1'b0;
    rx_err = 1'b0;
    expect_out(1'b0, 8'h00, "back in IDLE");
    $display("PASS");
    $finish;
  end
endmodule
