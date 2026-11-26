// fsm generated SV under Verilator: -Wall lint for every example and cycle
// behavior for the key ones (skipped when verilator / make are missing).
import { describe, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	compileBody,
	compileDemo,
	compileText,
	demo,
} from "./fixtures/fsm/compile.ts";
import {
	verilatorLint,
	verilatorSim,
	verilatorTest,
} from "./fixtures/verilator.ts";

const DEMOS = [
	"counter_ctl",
	"loop_ctl",
	"reg_ctl",
	"msg_ctl",
	"phy_ctl",
	"dump_check",
	"dump_svc",
	"cfg_load",
	"reg_mgr",
	"escape_ctl",
	"cmd_ctl",
];
const USER_PKGS = [join(demo, "rtl/dump_pkg.sv")];

/** Paths the doc examples do not reach: trap, private Dff with reset, and-or next, const wire,
 *  bits, a write-only external Dff (no _val port). */
const EDGES = `@Fsm
async edges({
  // inputs
  go = Input(1),
  cmd = Input(8),
  // outputs
  mode = Dff(4),
  halt = Output(1),
  seen_wr = Dff(1, { external: true }),
}) {
  const wr = (cmd.bits(7, 4) === 0xa) & (cmd.bits(3, 0) !== 0);
  const seen = Dff(1, { reset: 1 });
  while (true) {
    IDLE: await go.wait(1);
    if (wr) {
      mode.set(cmd.bits(3, 0));
      Busy: await (mode.val === 9).wait(0);
      seen.set(0);
    } else {
      mode.set(5);
      if (seen.val) continue;
      halt.pulse();
      seen_wr.set(1);
      FATAL: await ALWAYS_0.wait(1);
    }
  }
}`;

/** @Fsm({ wrap }): enum input / output, state_t and action_t outputs become logic on the wrapper. */
const WRAP = `@SvEnum({ pkg: "op_pkg", width: 2 })
class Op { static IDLE = 0; static GO = 1; static STOP = 2; }
@FsmGroup
class G {
  @Fsm({ wrap: true, exportState: true, exportAction: true })
  async w({
    op = Input(Op),
    o = Output(Op),
    n = Output(3),
  }) {
    while (true) {
      S: await (op === Op.GO).wait(1);
      T: await (op === Op.STOP).wait(1);
      o.pulse(Op.STOP);
      n.pulse(5);
    }
  }
}
`;

/** throw Raise() (§3.7): no doc example; the raising segment and the catch entry share a move. */
const RAISE = `@Fsm
async raise_ctl({
  // control
  go = Input(1),
  bad = Input(1),
  done = Input(1),
  // outputs
  mark = Output(1),
  fix = Output(1),
}) {
  while (true) {
    IDLE: await go.wait(1);
    try {
      if (bad) {
        mark.pulse();
        throw Raise();
      }
      Work: await done.wait(1);
    } catch {
      fix.pulse();
      Fix: await done.wait(1);
    }
  }
}`;

function withDir<T>(prefix: string, f: (dir: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	try {
		return f(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("verilator", () => {
	verilatorTest(
		"generated SV is -Wall clean",
		async () => {
			const units: [string, string][] = [
				["edges", await compileBody(EDGES)],
				["raise_ctl", await compileBody(RAISE)],
				["w_wrap", await compileText(WRAP)],
			];
			for (const f of DEMOS) {
				const sv = (await compileDemo(`fsm/${f}.mjs`)).sv;
				for (const m of sv.matchAll(/^module (\w+)/gm))
					units.push([m[1] ?? "", sv]);
			}
			withDir("aw-fsm-lint-", (dir) => {
				for (const [top, sv] of units) {
					const file = join(dir, `${top}.sv`);
					writeFileSync(file, sv);
					const r = verilatorLint({ top, sources: [...USER_PKGS, file] });
					expect(r.exitCode, `${top}\n${r.log}`).toBe(0);
				}
			});
		},
		120_000,
	);

	for (const [top, file, tb, dut] of [
		["act_demo", "counter_ctl", "act_demo", ""],
		["scan_ctl", "loop_ctl", "scan_ctl", ""],
		["msg_fwd", "msg_ctl", "msg_fwd", ""],
		["dump_check", "dump_check", "dump_check", ""],
		["dump_client", "dump_svc", "dump_check", "dump_client"],
		["cfg_load", "cfg_load", "cfg_load", ""],
		["reg_mgr", "reg_mgr", "reg_mgr", ""],
		["escape_ctl", "escape_ctl", "escape_ctl", ""],
		["phy_mon", "phy_ctl", "phy_mon", ""],
		["raise_ctl", "", "raise_ctl", ""],
		["cmd_post", "cmd_ctl", "cmd_post", ""],
	] as const)
		verilatorTest(
			`${top}: cycle behavior`,
			async () => {
				const sv = file
					? (await compileDemo(`fsm/${file}.mjs`)).sv
					: await compileBody(RAISE);
				withDir("aw-fsm-sim-", (dir) => {
					const dutFile = join(dir, "dut.sv");
					writeFileSync(dutFile, sv);
					const r = verilatorSim({
						dir: join(dir, "obj"),
						top: "tb",
						sources: [
							...USER_PKGS,
							dutFile,
							join(import.meta.dir, `fixtures/fsm/${tb}_tb.sv`),
						],
						args: dut ? [`+define+DUT=${dut}`] : [],
					});
					expect(r.buildOk, r.buildLog).toBe(true);
					expect(r.exitCode, r.stdout + r.stderr).toBe(0);
					expect(r.stdout).toContain("PASS");
				});
			},
			180_000,
		);
});
