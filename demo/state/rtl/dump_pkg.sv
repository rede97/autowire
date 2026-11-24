// User package for fsm/dump_check.mjs (hand-written, not generated): the DSL
// has no arithmetic, so the address step and the counters live here.
package dump_pkg;
  function automatic logic [31:0] add32(input logic [31:0] a, input logic [31:0] b);
    return a + b;
  endfunction
  function automatic logic [6:0] inc7(input logic [6:0] x);
    return x + 7'd1;
  endfunction
endpackage
