// Behavior check for exportState / stateValues (docs/state/async-fsm.md §6.5):
// state_val_o carries the listed member values, state_set_o and state_next_o
// announce each move on its own cycle.
module tb;
  import phy_mon_pkg::*;
  logic clk = 1'b0, rst_n = 1'b0, start = 1'b0, cal_done = 1'b0;
  logic cal_req, state_set_o;
  state_t state_next_o, state_val_o;

  phy_mon dut (.*);

  always #5 clk = ~clk;

  task automatic step();
    @(posedge clk);
    #1;
  endtask

  task automatic expect_state(input logic [1:0] v, input logic set, input logic [1:0] nxt);
    if (state_val_o !== state_t'(v) || state_set_o !== set || state_next_o !== state_t'(nxt))
      $fatal(1, "state %0d set %0b next %0d, want %0d %0b %0d",
             state_val_o, state_set_o, state_next_o, v, set, nxt);
  endtask

  initial begin
    step();
    rst_n = 1'b1;
    step();
    expect_state(2'd0, 1'b0, 2'd0);
    start = 1'b1;
    #1 expect_state(2'd0, 1'b1, 2'd2);
    step();
    #1 expect_state(2'd2, 1'b0, 2'd2);
    cal_done = 1'b1;
    #1 expect_state(2'd2, 1'b1, 2'd3);
    step();
    cal_done = 1'b0;
    #1 expect_state(2'd3, 1'b0, 2'd3);
    start = 1'b0;
    #1 expect_state(2'd3, 1'b1, 2'd0);
    step();
    #1 expect_state(2'd0, 1'b0, 2'd0);
    $display("PASS");
    $finish;
  end
endmodule
