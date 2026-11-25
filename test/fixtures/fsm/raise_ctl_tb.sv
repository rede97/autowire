// Behavior check for throw Raise() (docs/state/async-fsm.md §3.7): the actions before
// the throw and the catch entry actions fire on the same move; the catch is not taken
// when the branch does not raise.
module tb;
  logic clk = 1'b0, rst_n = 1'b0, go = 1'b0, bad = 1'b0, done = 1'b0;
  logic mark, fix;

  raise_ctl dut (.*);

  always #5 clk = ~clk;

  task automatic step();
    @(posedge clk);
    #1;
  endtask

  initial begin
    step();
    rst_n = 1'b1;
    step();
    go = 1'b1;
    bad = 1'b1;
    #1 if (mark !== 1'b1 || fix !== 1'b1) $fatal(1, "raise move lost an action");
    step();
    {go, bad} = '0;
    #1 if (mark !== 1'b0 || fix !== 1'b0) $fatal(1, "pulses longer than the move");
    done = 1'b1;
    step();
    done = 1'b0;
    go = 1'b1;
    #1 if (mark !== 1'b0 || fix !== 1'b0) $fatal(1, "catch taken without a raise");
    step();
    go = 1'b0;
    done = 1'b1;
    #1 if (fix !== 1'b0) $fatal(1, "Work left through the catch");
    step();
    done = 1'b0;
    go = 1'b1;
    bad = 1'b1;
    #1 if (fix !== 1'b1) $fatal(1, "not back in IDLE after Work");
    $display("PASS");
    $finish;
  end
endmodule
