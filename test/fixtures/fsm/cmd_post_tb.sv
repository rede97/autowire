// Behavior check for the generated cmd_post (docs/state/async-fsm.md §2.8): the
// enum-typed channel field and the Mealy enum pulse carry the cmd_pkg members.
module tb;
  import cmd_pkg::*;
  logic clk = 1'b0, rst_n = 1'b0, go = 1'b0, we = 1'b0, cmd_rdy = 1'b0;
  logic cmd_vld;
  logic [7:0] cmd_addr;
  cmd_e cmd_op, last, sent;

  cmd_post dut (.*);

  always #5 clk = ~clk;

  task automatic step();
    @(posedge clk);
    #1;
  endtask

  initial begin
    step();
    rst_n = 1'b1;
    step();
    if (sent !== CMD_NOP || cmd_vld !== 1'b0) $fatal(1, "outputs not idle after reset");
    go = 1'b1;
    we = 1'b1;
    step();
    {go, we} = '0;
    if (cmd_vld !== 1'b1 || cmd_op !== CMD_WRITE || last !== CMD_WRITE)
      $fatal(1, "SEND: vld %0b op %0d last %0d", cmd_vld, cmd_op, last);
    cmd_rdy = 1'b1;
    #1 if (sent !== CMD_WRITE) $fatal(1, "sent %0d on the SEND handshake", sent);
    step();
    if (cmd_vld !== 1'b1 || cmd_op !== CMD_FLUSH) $fatal(1, "FLUSH not sent after WRITE");
    #1 if (sent !== CMD_FLUSH) $fatal(1, "sent %0d on the FLUSH handshake", sent);
    step();
    cmd_rdy = 1'b0;
    #1 if (cmd_vld !== 1'b0 || sent !== CMD_NOP) $fatal(1, "not back in IDLE");
    go = 1'b1;
    step();
    go = 1'b0;
    if (cmd_op !== CMD_READ) $fatal(1, "READ expected without we, got %0d", cmd_op);
    cmd_rdy = 1'b1;
    step();
    cmd_rdy = 1'b0;
    if (cmd_vld !== 1'b0) $fatal(1, "READ is followed by a FLUSH");
    $display("PASS");
    $finish;
  end
endmodule
