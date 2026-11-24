// Behavior check for the generated dump_check + dump_scan (docs/state/async-fsm.md §5.2):
// the sub-FSM reads cfg_num words from cfg_base, cfg_step apart, counts the
// words equal to cfg_pattern, and the caller latches the count into hit_cnt.
module tb;
  logic        clk = 1'b0, rst_n = 1'b0, check = 1'b0;
  logic [31:0] cfg_base = 32'h0000_1000, cfg_step = 32'h4, cfg_pattern = 32'hdead_beef;
  logic [6:0]  cfg_num = 7'd1;
  logic        rd_ack = 1'b0;
  logic [31:0] rd_data = '0;
  logic        rd_req, check_done;
  logic [31:0] rd_addr;
  logic [6:0]  hit_cnt;
  logic [31:0] mem [64];
  int          reqs = 0, dones = 0;

  dump_check dut (.*);

  always #5 clk = ~clk;

  // Bus: data and ack one cycle after the request.
  always @(posedge clk) begin
    rd_ack <= rd_req;
    if (rd_req) begin
      if (rd_addr !== cfg_base + reqs * cfg_step) $fatal(1, "read %0d at %h", reqs, rd_addr);
      rd_data <= mem[(rd_addr - cfg_base) / cfg_step];
      reqs <= reqs + 1;
    end
    if (check_done) dones <= dones + 1;
  end

  task automatic scan(input int num, input int expect_hits);
    cfg_num = 7'(num);
    reqs = 0;
    dones = 0;
    @(posedge clk);
    #1 check = 1'b1;
    @(posedge clk);
    #1 check = 1'b0;
    wait (dones == 1);
    #1;
    if (reqs != num) $fatal(1, "num=%0d: %0d reads", num, reqs);
    if (hit_cnt != 7'(expect_hits)) $fatal(1, "num=%0d: hit_cnt=%0d, expected %0d", num, hit_cnt, expect_hits);
    repeat (3) @(posedge clk);
    if (dones != 1 || reqs != num) $fatal(1, "num=%0d: activity after done", num);
  endtask

  initial begin
    for (int i = 0; i < 64; i++) mem[i] = (i % 3 == 0) ? cfg_pattern : 32'(i);
    @(posedge clk);
    #1 rst_n = 1'b1;
    scan(10, 4);    // words 0, 3, 6, 9
    scan(1, 1);
    scan(64, 22);   // every third word of 64
    $display("PASS");
    $finish;
  end

  initial begin
    #200000;
    $fatal(1, "timeout");
  end
endmodule
