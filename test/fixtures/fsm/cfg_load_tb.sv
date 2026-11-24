// Behavior check for the generated cfg_load (docs/state/async-fsm.md §2.6):
// go reads 8'h10 into lo, then 8'h14 into hi, then pulses done.
module tb;
  logic        clk = 1'b0, rst_n = 1'b0, go = 1'b0;
  logic        rd_ack = 1'b0;
  logic [15:0] rd_data = '0;
  logic        rd_req, done;
  logic [7:0]  rd_addr;
  logic [15:0] lo, hi;
  logic [7:0]  seen [2];
  int          reqs = 0, dones = 0;

  cfg_load dut (.*);

  always #5 clk = ~clk;

  // Register file: ack and data two cycles after the request.
  logic       ack_d = 1'b0;
  logic [7:0] addr_d = '0;
  always @(posedge clk) begin
    ack_d  <= rd_req;
    addr_d <= rd_addr;
    rd_ack <= ack_d;
    rd_data <= {8'hab, addr_d};
    if (rd_req) begin
      if (reqs < 2) seen[reqs] <= rd_addr;
      reqs <= reqs + 1;
    end
    if (done) dones <= dones + 1;
  end

  initial begin
    @(posedge clk);
    #1 rst_n = 1'b1;
    @(posedge clk);
    #1 go = 1'b1;
    @(posedge clk);
    #1 go = 1'b0;
    wait (dones == 1);
    #1;
    if (reqs != 2) $fatal(1, "%0d reads", reqs);
    if (seen[0] != 8'h10 || seen[1] != 8'h14) $fatal(1, "addresses %h %h", seen[0], seen[1]);
    if (lo != 16'hab10 || hi != 16'hab14) $fatal(1, "lo=%h hi=%h", lo, hi);
    repeat (4) @(posedge clk);
    if (reqs != 2 || dones != 1) $fatal(1, "activity after done");
    $display("PASS");
    $finish;
  end

  initial begin
    #10000;
    $fatal(1, "timeout");
  end
endmodule
