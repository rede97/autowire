// Behavior check for the generated act_demo (docs/state/async-fsm.md §6.1):
// cnt_clr pulses on the go cycle (Mealy), active is high exactly while in Run.
module tb;
  logic clk = 1'b0, rst_n = 1'b0, go = 1'b0, stop = 1'b0;
  logic cnt_clr, active;

  act_demo dut (.*);

  always #5 clk = ~clk;

  task automatic step();
    @(posedge clk);
    #1;
  endtask

  initial begin
    step();
    rst_n = 1'b1;
    step();
    if (active !== 1'b0 || cnt_clr !== 1'b0) $fatal(1, "outputs not idle after reset");
    go = 1'b1;
    #1 if (cnt_clr !== 1'b1) $fatal(1, "cnt_clr missing on the go cycle");
    step();
    go = 1'b0;
    #1 if (active !== 1'b1 || cnt_clr !== 1'b0) $fatal(1, "active not set after go");
    step();
    step();
    if (active !== 1'b1) $fatal(1, "active dropped while waiting in Run");
    stop = 1'b1;
    #1 if (active !== 1'b1) $fatal(1, "active cleared before the stop move");
    step();
    stop = 1'b0;
    #1 if (active !== 1'b0) $fatal(1, "active not cleared after stop");
    go = 1'b1;
    #1 if (cnt_clr !== 1'b1) $fatal(1, "no second round after returning to IDLE");
    $display("PASS");
    $finish;
  end
endmodule
