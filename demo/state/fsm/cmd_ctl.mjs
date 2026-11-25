import { Dff, Fsm, FsmGroup, Input, Output, PushPort, SvEnum } from "../.autowire/dsl/fsm/dsl.mjs";

/** Commands of the cmd channel. */
@SvEnum({ pkg: "cmd_pkg", name: "cmd_e", prefix: "CMD" })
export class Cmd {
  static NOP = 0;
  static READ = 1;
  static WRITE = 2;
  static FLUSH = 5;
}

@FsmGroup
export class CmdCtl {
  @Fsm
  async cmd_post({
    // control
    go = Input(1),
    we = Input(1),
    // command channel
    cmd = PushPort({ op: Cmd, addr: 8 }),
    // status
    last = Dff(Cmd),
    sent = Output(Cmd),
  }) {
    while (true) {
      IDLE: await go.wait(1);
      last.set(we ? Cmd.WRITE : Cmd.READ);
      Send: await cmd.push({ op: last.val, addr: 0x10 });
      sent.pulse(last.val);
      if (last.val === Cmd.WRITE) {
        Flush: await cmd.push({ op: Cmd.FLUSH, addr: 0x10 });
        sent.pulse(Cmd.FLUSH);
      }
    }
  }
}
