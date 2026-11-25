// Behavior check for the generated §3.7 examples (docs/state/async-fsm.md):
// work_ctl  - the outer Escape wins over the inner one in the same cycle, the inner
//             catch is covered by the outer Escape only, catch actions are Mealy;
// soft_rst_ctl - the Escape covers the entry state, and RUN leaves on it too.
module tb;
  logic clk = 1'b0, rst_n = 1'b0;
  // work_ctl
  logic go = 1'b0, more = 1'b0, a_done = 1'b0, b_done = 1'b0;
  logic err = 1'b0, fatal = 1'b0, rec_done = 1'b0;
  logic clr, halt;
  // soft_rst_ctl
  logic s_go = 1'b0, stop = 1'b0, force_reset = 1'b0, clean_done = 1'b0;
  logic active, clean_start;

  work_ctl u_work (
    .clk, .rst_n, .go, .more, .a_done, .b_done, .err, .fatal, .rec_done, .clr, .halt
  );
  soft_rst_ctl u_soft (
    .clk, .rst_n, .go(s_go), .stop, .active, .force_reset, .clean_start, .clean_done
  );

  always #5 clk = ~clk;

  task automatic step();
    @(posedge clk);
    #1;
  endtask

  task automatic restart();
    rst_n = 1'b0;
    {go, more, a_done, b_done, err, fatal, rec_done} = '0;
    step();
    rst_n = 1'b1;
    step();
  endtask

  // IDLE -> WORK0 with go & more.
  task automatic enter_work();
    go = 1'b1;
    more = 1'b1;
    step();
    go = 1'b0;
  endtask

  initial begin
    // 1. err and fatal in the same cycle: fatal (outer) wins, no clr.
    restart();
    enter_work();
    err = 1'b1;
    fatal = 1'b1;
    #1 if (clr !== 1'b0) $fatal(1, "inner catch taken although the outer Escape holds");
    step();
    {err, fatal} = '0;
    if (halt !== 1'b1) $fatal(1, "fatal did not reach the outer catch");
    rec_done = 1'b1;
    go = 1'b1;
    step();
    step();
    if (halt !== 1'b1 || clr !== 1'b0) $fatal(1, "FATAL is not a trap");

    // 2. err: clr on the escape cycle; RECOVERY ignores err but not fatal.
    restart();
    enter_work();
    err = 1'b1;
    #1 if (clr !== 1'b1) $fatal(1, "clr missing on the err escape cycle");
    step();
    #1 if (clr !== 1'b0) $fatal(1, "RECOVERY re-entered on a held err");
    step();
    #1 if (clr !== 1'b0 || halt !== 1'b0) $fatal(1, "err escaped RECOVERY");
    fatal = 1'b1;
    step();
    if (halt !== 1'b1) $fatal(1, "the outer Escape does not cover the inner catch");

    // 3. soft reset from the entry state and from RUN.
    force_reset = 1'b1;
    #1 if (clean_start !== 1'b1) $fatal(1, "IDLE is not covered by the Escape");
    step();
    force_reset = 1'b0;
    #1 if (clean_start !== 1'b0 || active !== 1'b0) $fatal(1, "RESET entry actions repeat");
    clean_done = 1'b1;
    step();
    clean_done = 1'b0;
    s_go = 1'b1;
    step();
    s_go = 1'b0;
    if (active !== 1'b1) $fatal(1, "active not set in RUN");
    force_reset = 1'b1;
    stop = 1'b1;
    #1 if (clean_start !== 1'b1) $fatal(1, "RUN does not leave on force_reset first");
    step();
    {force_reset, stop} = '0;
    if (active !== 1'b0) $fatal(1, "the catch did not clear active");
    $display("PASS");
    $finish;
  end
endmodule
