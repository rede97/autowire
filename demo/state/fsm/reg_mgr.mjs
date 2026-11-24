import { Caller, Dff, Fsm, FsmGroup, Input, Output } from "../.autowire/dsl/fsm/dsl.mjs";

@FsmGroup
export class RegMgr {
  /** Reads the status register, then writes it back to the control register. */
  @Fsm
  async reg_mgr({
    // control
    go = Input(1),
    done = Output(1),
    status = Dff(32),
    // register bus
    bus_req = Output(1),
    bus_we = Output(1),
    bus_addr = Output(8),
    bus_wdata = Output(32),
    bus_ack = Input(1),
    bus_rdata = Input(32),
  }) {
    const reg = Caller(this.reg_access, {
      bus_req,
      bus_we,
      bus_addr,
      bus_wdata,
      bus_ack,
      bus_rdata,
    });
    let v;
    while (true) {
      IDLE: await go.wait(1);
      Rd: v = await reg.call({ addr: 0x10, wdata: 0, we: 0 });
      status.set(v);
      Wr: await reg.call({ addr: 0x14, wdata: status.val, we: 1 });
      done.pulse();
    }
  }

  /** One register access: a request pulse, then ack with the read data. */
  async reg_access({
    // access
    addr = Input(8),
    wdata = Input(32),
    we = Input(1),
    // register bus
    bus_req = Output(1),
    bus_we = Output(1),
    bus_addr = Output(8),
    bus_wdata = Output(32),
    bus_ack = Input(1),
    bus_rdata = Input(32),
  }) {
    bus_req.pulse();
    bus_we.pulse(we);
    bus_addr.pulse(addr);
    bus_wdata.pulse(wdata);
    Wait: await bus_ack.wait(1);
    return bus_rdata;
  }
}
