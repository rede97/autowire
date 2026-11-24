import { Fsm, FsmGroup, Input, Output } from "../.autowire/dsl/fsm/dsl.mjs";

@FsmGroup
export class LoopCtl {
  @Fsm
  async burst_ctl({
    // control
    go = Input(1),
    more = Input(1),
    // request
    req_rdy = Input(1),
    req = Output(1),
    // burst beats
    burst = Input(1),
    beat_vld = Input(1),
    beat_ack = Output(1),
    ack = Input(1),
  }) {
    while (true) {
      IDLE: await go.wait(1);
      while (more) {
        req.pulse();
        Fetch: await req_rdy.wait(1);
        while (burst) {
          Beat: await beat_vld.wait(1);
          beat_ack.pulse();
        }
        Ack: await ack.wait(1);
      }
    }
  }

  @Fsm
  async scan_ctl({
    // control
    go = Input(1),
    ack = Input(1),
    // rows
    row_more = Input(1),
    row_rdy = Input(1),
    // columns
    col_more = Input(1),
    col_rdy = Input(1),
    hit = Input(1),
    // result
    found = Output(1),
  }) {
    while (true) {
      IDLE: await go.wait(1);
      Outer: while (row_more) {
        Row: await row_rdy.wait(1);
        while (col_more) {
          Col: await col_rdy.wait(1);
          if (hit) break Outer;   // found: stop the whole scan
        }
      }
      found.pulse();
      Report: await ack.wait(1);
    }
  }
}
