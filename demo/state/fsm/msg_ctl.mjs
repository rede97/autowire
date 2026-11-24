import { Fsm, FsmGroup, Input, Output } from "../.autowire/dsl/fsm/dsl.mjs";

@FsmGroup
export class MsgCtl {
  @Fsm
  async msg_fwd({
    // control
    go = Input(1),
    // receive side
    rx_vld = Input(1),
    rx_err = Input(1),
    rx_msg = Input(8),
    // FIFO write port
    full = Input(1),
    wr_en = Output(1),
    wr_data = Output(8),
  }) {
    while (true) {
      IDLE: await (go & !full).wait(1);
      wr_en.pulse();
      wr_data.pulse(0xa5);                     // fixed header message
      Fwd:  await (rx_vld & !full).wait(1);
      wr_en.pulse();
      wr_data.pulse(rx_err ? 0xee : rx_msg);   // forward, or an error code
    }
  }
}
