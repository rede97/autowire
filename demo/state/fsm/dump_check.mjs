import { ALWAYS_1, Dff, Fsm, FsmGroup, Input, Output, SvFunction, SvPackage } from "../.autowire/dsl/fsm/dsl.mjs";

const dump_pkg = SvPackage("dump_pkg", {
  add32: SvFunction({ args: { a: 32, b: 32 }, ret: 32 }),
  inc7:  SvFunction({ args: { x: 7 }, ret: 7 }),
});

@FsmGroup
export class DumpCheck {
  @Fsm
  async dump_check({
    // software control
    check = Input(1),                       // trigger
    hit_cnt = Dff(7),                       // matches of the last scan (RO field)
    check_done = Output(1),
    // software config
    cfg_base = Input(32),
    cfg_step = Input(32),
    cfg_num = Input(7),                     // words to scan, 1..64
    cfg_pattern = Input(32),
    // dump regfile read port
    rd_req = Output(1),
    rd_addr = Output(32),
    rd_ack = Input(1),
    rd_data = Input(32),
  }) {
    let hits;
    while (true) {
      IDLE: await check.wait(1);
      Scan: hits = await this.dump_scan({
        cfg_base,
        cfg_step,
        cfg_num,
        cfg_pattern,
        rd_req,
        rd_addr,
        rd_ack,
        rd_data,
      });
      hit_cnt.set(hits);
      check_done.pulse();
    }
  }

  async dump_scan({
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
    const addr = Dff(32);
    const idx = Dff(7);
    const hits = Dff(7);
    const idx_next = dump_pkg.inc7(idx.val);
    const hits_next = (rd_data === cfg_pattern) ? dump_pkg.inc7(hits.val) : hits.val;
    addr.set(cfg_base);                     // start cycle
    idx.set(0);
    hits.set(0);
    do {
      Issue:   await ALWAYS_1.wait(1);      // addr.val holds this word's address
      rd_req.pulse();
      rd_addr.pulse(addr.val);
      WaitAck: await rd_ack.wait(1);
      addr.set(dump_pkg.add32(addr.val, cfg_step));
      idx.set(idx_next);
      hits.set(hits_next);
    } while (idx_next !== cfg_num);
    return hits_next;                       // includes the last word
  }
}
