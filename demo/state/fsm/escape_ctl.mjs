import { ALWAYS_0, Dff, Escape, Fsm, FsmGroup, Input, Output } from "../.autowire/dsl/fsm/dsl.mjs";

@FsmGroup
export class EscapeCtl {
  @Fsm
  async work_ctl({
    // control
    go = Input(1),
    more = Input(1),
    // work steps
    a_done = Input(1),
    b_done = Input(1),
    // error handling
    err = Input(1),
    fatal = Input(1),
    rec_done = Input(1),
    clr = Output(1),
    halt = Dff(1),
  }) {
    while (true) {
      IDLE: await go.wait(1);                 // the first await is the reset state
      try {
        Escape(fatal);                        // outer: fatal error
        try {
          Escape(err);                        // inner: recoverable error
          while (more) {
            Work0: await a_done.wait(1);
            Work1: await b_done.wait(1);
          }
        } catch {
          clr.pulse();
          Recovery: await rec_done.wait(1);   // recovered → loop body end → IDLE
        }
      } catch {
        halt.set(1);
        FATAL: await ALWAYS_0.wait(1);        // trap state: never leaves
      }
    }
  }

  @Fsm
  async soft_rst_ctl({
    // control
    go = Input(1),
    stop = Input(1),
    active = Dff(1),
    // soft reset
    force_reset = Input(1),
    clean_start = Output(1),
    clean_done = Input(1),
  }) {
    while (true) {
      try {
        Escape(force_reset);              // covers every working state, entry IDLE included
        IDLE: await go.wait(1);
        active.set(1);
        Run:  await stop.wait(1);
        active.set(0);
      } catch {
        active.set(0);                    // cleanup: the author decides what to clear
        clean_start.pulse();
        RESET: await clean_done.wait(1);  // cleanup done → loop body end → IDLE
      }
    }
  }

  @Fsm
  async err_ctl({
    // control
    go = Input(1),
    more = Input(1),
    // work steps
    a_done = Input(1),
    b_done = Input(1),
    // error levels
    e0 = Input(1),
    e1 = Input(1),
    e2 = Input(1),
    // cleanup steps
    c0_done = Input(1),
    c1_done = Input(1),
    c2_done = Input(1),
    c0_start = Output(1),
    c1_start = Output(1),
    c2_start = Output(1),
  }) {
    while (true) {
      IDLE: await go.wait(1);
      try {
        Escape(e0 | e1 | e2);                  // any level leaves WORK
        while (more) {
          Work0: await a_done.wait(1);
          Work1: await b_done.wait(1);
        }
      } catch {
        if (e1 | e2) {                         // sampled in the escape cycle
          if (e2) {
            c2_start.pulse();
            Clean2: await c2_done.wait(1);
          }
          c1_start.pulse();                    // level 2 done: fall through to level 1
          Clean1: await c1_done.wait(1);
        }
        c0_start.pulse();                      // every path ends at level 0
        Clean0: await c0_done.wait(1);         // loop body end → IDLE
      }
    }
  }
}
