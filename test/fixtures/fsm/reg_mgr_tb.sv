// Behavior check for the generated reg_mgr + its Caller server (docs/state/async-fsm.md §5.4):
// go reads 8'h10 through the server into status, then writes status to 8'h14.
module tb;
  logic        clk = 1'b0, rst_n = 1'b0, go = 1'b0;
  logic        bus_ack = 1'b0;
  logic [31:0] bus_rdata = '0;
  logic        done, bus_req, bus_we;
  logic [7:0]  bus_addr;
  logic [31:0] bus_wdata, status;
  logic [7:0]  addrs [2];
  logic        wes [2];
  logic [31:0] wdata1 = '0;
  int          reqs = 0, dones = 0;

  reg_mgr dut (.*);

  always #5 clk = ~clk;

  // Register bus: ack and read data one cycle after the request.
  always @(posedge clk) begin
    bus_ack   <= bus_req;
    bus_rdata <= {24'hc0ffee, bus_addr};
    if (bus_req) begin
      if (reqs < 2) begin
        addrs[reqs] <= bus_addr;
        wes[reqs]   <= bus_we;
      end
      if (reqs == 1) wdata1 <= bus_wdata;
      reqs <= reqs + 1;
    end
    if (done) dones <= dones + 1;
  end

  task automatic run_once(input int n);
    @(posedge clk);
    #1 go = 1'b1;
    @(posedge clk);
    #1 go = 1'b0;
    wait (dones == n);
    #1;
  endtask

  initial begin
    @(posedge clk);
    #1 rst_n = 1'b1;
    run_once(1);
    if (reqs != 2) $fatal(1, "%0d bus requests", reqs);
    if (addrs[0] != 8'h10 || wes[0] != 1'b0) $fatal(1, "first access %h we=%b", addrs[0], wes[0]);
    if (addrs[1] != 8'h14 || wes[1] != 1'b1) $fatal(1, "second access %h we=%b", addrs[1], wes[1]);
    if (status != 32'hc0ffee10) $fatal(1, "status=%h", status);
    if (wdata1 != 32'hc0ffee10) $fatal(1, "written %h", wdata1);
    reqs = 0;
    run_once(2);
    if (reqs != 2) $fatal(1, "second run: %0d bus requests", reqs);
    repeat (4) @(posedge clk);
    if (dones != 2) $fatal(1, "activity after done");
    $display("PASS");
    $finish;
  end

  initial begin
    #10000;
    $fatal(1, "timeout");
  end
endmodule
