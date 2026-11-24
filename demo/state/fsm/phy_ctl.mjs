import { Dff, Fsm, FsmGroup, Input, Output } from "../.autowire/dsl/fsm/dsl.mjs";

@FsmGroup
export class PhyCtl {
  @Fsm({ statePrefix: "LPDDRPHY", stateEncoding: "onehot" })
  async phy_init({
    // control
    start = Input(1),
    ready = Dff(1),
    // calibration
    cal_done = Input(1),
    cal_req = Output(1),
  }) {
    while (true) {
      Idle:  await start.wait(1);
      cal_req.pulse();
      Calib: await cal_done.wait(1);
      ready.set(1);
      Ready: await start.wait(0);
      ready.set(0);
    }
  }
}
