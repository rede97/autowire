import { Dff, Fsm, FsmGroup, FsmPort, Input, Output } from "../.autowire/dsl/fsm/dsl.mjs";

/** Register read port: a request pulse with the address, then data with ack. */
@FsmPort
export class RdPort {
  constructor(aw, dw) {
    this.req = Output(1);
    this.addr = Output(aw);
    this.ack = Input(1);
    this.data = Input(dw);
  }

  /** Start one read: actions on the move, no state. */
  issue(a) {
    this.req.pulse();
    this.addr.pulse(a);
  }

  /** Read one word: one state waiting for ack; the data is the result. */
  async read(a) {
    this.issue(a);
    Wait: await this.ack.wait(1);
    return this.data;
  }
}

@FsmGroup
export class CfgLoad {
  /** Loads two config registers after go. */
  @Fsm
  async cfg_load({
    // control
    go = Input(1),
    done = Output(1),
    // config register read port
    rd = new RdPort(8, 16),
    // loaded values
    lo = Dff(16),
    hi = Dff(16),
  }) {
    let a;
    let b;
    while (true) {
      IDLE: await go.wait(1);
      Lo: a = await rd.read(0x10);
      lo.set(a);
      Hi: b = await rd.read(0x14);
      hi.set(b);
      done.pulse();
    }
  }
}
