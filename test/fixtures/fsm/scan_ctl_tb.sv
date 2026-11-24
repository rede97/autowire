// Behavior check for the generated scan_ctl (docs/state/async-fsm.md §3.6.1):
// the inner back edge stays in Col, break Outer reaches Report and pulses
// found once, ack returns to IDLE.
module tb;
  logic clk = 1'b0, rst_n = 1'b0, go = 1'b0, ack = 1'b0, hit = 1'b0;
  logic row_more = 1'b1, row_rdy = 1'b1, col_more = 1'b1, col_rdy = 1'b1;
  logic found;
  int cyc = 0, hits = 0, at = -1;

  scan_ctl dut (.*);

  always #5 clk = ~clk;

  // Sample mid-cycle: inputs change 1 time unit after posedge.
  always @(negedge clk)
    if (rst_n) begin
      if (found) begin
        hits++;
        at = cyc;
      end
      cyc++;
    end

  initial begin
    @(posedge clk);
    #1 rst_n = 1'b1;
    go = 1'b1;                     // cycle 0: IDLE -> Row
    @(posedge clk);
    #1 go = 1'b0;                  // cycle 1: Row -> Col
    @(posedge clk);                // cycle 2: Col, no hit -> Col (inner back edge)
    @(posedge clk);
    #1 hit = 1'b1;                 // cycle 3: Col, hit -> Report (break Outer)
    @(posedge clk);
    #1 hit = 1'b0;
    if (hits !== 1 || at !== 3) $fatal(1, "found pulsed %0d time(s), last at cycle %0d", hits, at);
    if (dut.state_val !== scan_ctl_pkg::REPORT) $fatal(1, "not in REPORT after break Outer");
    ack = 1'b1;
    @(posedge clk);
    #1 ack = 1'b0;
    if (dut.state_val !== scan_ctl_pkg::IDLE) $fatal(1, "ack did not return to IDLE");
    $display("PASS");
    $finish;
  end
endmodule
