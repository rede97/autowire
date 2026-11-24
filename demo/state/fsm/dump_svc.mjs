import { Chan, Dff, Fsm, FsmGroup, Input, Instance, Output, PopPort, PushPort } from "../.autowire/dsl/fsm/dsl.mjs";
import { DumpCheck } from "./dump_check.mjs";

/** The dump scan of dump_check.mjs as a server process: the client and the
 * server talk only over two channels. */
@FsmGroup
export class DumpSvc {
  /** One scan per request: pops the pattern, pushes the hit count. */
  @Fsm
  async dump_server({
    // software config
    cfg_base = Input(32),
    cfg_step = Input(32),
    cfg_num = Input(7),
    // requests
    req = PopPort(32),                      // pattern to match
    rsp = PushPort(7),                      // matches found
    // dump regfile read port
    rd_req = Output(1),
    rd_addr = Output(32),
    rd_ack = Input(1),
    rd_data = Input(32),
  }) {
    const pattern = Dff(32);
    const count = Dff(7);
    let p;
    let hits;
    while (true) {
      Cmd: p = await req.pop();
      pattern.set(p);
      Scan: hits = await DumpCheck.dump_scan({
        cfg_base,
        cfg_step,
        cfg_num,
        cfg_pattern: pattern.val,
        rd_req,
        rd_addr,
        rd_ack,
        rd_data,
      });
      count.set(hits);
      Rsp: await rsp.push(count.val);
    }
  }

  /** Software front end: each check sends one request to the server. */
  @Fsm
  async dump_client({
    // software control
    check = Input(1),
    hit_cnt = Dff(7),
    check_done = Output(1),
    // software config
    cfg_base = Input(32),
    cfg_step = Input(32),
    cfg_num = Input(7),
    cfg_pattern = Input(32),
    // dump regfile read port
    rd_req = Output(1),
    rd_addr = Output(32),
    rd_ack = Input(1),
    rd_data = Input(32),
  }) {
    const req = Chan(32);
    const rsp = Chan(7);
    Instance(this.dump_server, {
      cfg_base,
      cfg_step,
      cfg_num,
      req: req.rx,
      rsp: rsp.tx,
      rd_req,
      rd_addr,
      rd_ack,
      rd_data,
    });
    let hits;
    while (true) {
      IDLE: await check.wait(1);
      Req: await req.push(cfg_pattern);
      Rsp: hits = await rsp.pop();
      hit_cnt.set(hits);
      check_done.pulse();
    }
  }
}
