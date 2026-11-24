import { Dff, Fsm, FsmGroup, Input, Output } from "../.autowire/dsl/fsm/dsl.mjs";

/** Counter control blocks. */
@FsmGroup
export class CounterCtl {
  /**
   * Counter control.
   * Clears the counter on go and holds active high until stop.
   */
  @Fsm
  async act_demo({
    // host control
    go = Input(1),      // start request from the host
    stop = Input(1),
    // counter
    cnt_clr = Output(1),
    active = Dff(1),
  }) {
    while (true) {
      IDLE: await go.wait(1);
      cnt_clr.pulse();
      active.set(1);
      Run:  await stop.wait(1);   // active stays high here
      active.set(0);
    }
  }
}
