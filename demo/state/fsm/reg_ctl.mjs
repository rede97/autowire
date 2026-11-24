import { Dff, Fsm, FsmGroup, Input } from "../.autowire/dsl/fsm/dsl.mjs";

@FsmGroup
export class RegCtl {
  @Fsm
  async reg_demo({
    // control
    go = Input(1),
    // regfile field
    mode = Dff(8, { external: true }),
  }) {
    while (true) {
      IDLE:  await go.wait(1);
      mode.set(0x5a);
      Check: await (mode.val === 0x5a).wait(1);
    }
  }
}
