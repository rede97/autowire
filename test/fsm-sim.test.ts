// fsm generated SV under Verilator: -Wall lint for every example and cycle
// behavior for the key ones (skipped when verilator / make are missing).
import { describe, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AW_DFF_SV } from "../src/plugins/fsm/generate.ts";
import { compileBody, compileDemo, demo } from "./fixtures/fsm/compile.ts";
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
];
const USER_PKGS = [join(demo, "rtl/dump_pkg.sv")];

/** Paths the doc examples do not reach: trap, private Dff with reset, and-or next, const wire, bits. */
const EDGES = `@Fsm
async edges({
  // inputs
  go = Input(1),
  cmd = Input(8),
  // outputs
  mode = Dff(4),
  halt = Output(1),
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
      FATAL: await ALWAYS_0.wait(1);
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
			const units: [string, string][] = [["edges", await compileBody(EDGES)]];
			for (const f of DEMOS) {
				const sv = (await compileDemo(`fsm/${f}.mjs`)).sv;
				for (const m of sv.matchAll(/^module (\w+)/gm))
					units.push([m[1] ?? "", sv]);
			}
			withDir("aw-fsm-lint-", (dir) => {
				const dff = join(dir, "aw_dff.sv");
				writeFileSync(dff, AW_DFF_SV);
				for (const [top, sv] of units) {
					const file = join(dir, `${top}.sv`);
					writeFileSync(file, sv);
					const r = verilatorLint({ top, sources: [dff, ...USER_PKGS, file] });
					expect(r.exitCode, `${top}\n${r.log}`).toBe(0);
				}
			});
		},
		120_000,
	);

	for (const [top, file] of [
		["act_demo", "counter_ctl"],
		["scan_ctl", "loop_ctl"],
		["msg_fwd", "msg_ctl"],
		["dump_check", "dump_check"],
	] as const)
		verilatorTest(
			`${top}: cycle behavior`,
			async () => {
				const sv = (await compileDemo(`fsm/${file}.mjs`)).sv;
				withDir("aw-fsm-sim-", (dir) => {
					const dff = join(dir, "aw_dff.sv");
					const dut = join(dir, "dut.sv");
					writeFileSync(dff, AW_DFF_SV);
					writeFileSync(dut, sv);
					const tb = join(import.meta.dir, `fixtures/fsm/${top}_tb.sv`);
					const r = verilatorSim({
						dir: join(dir, "obj"),
						top: "tb",
						sources: [dff, ...USER_PKGS, dut, tb],
					});
					expect(r.buildOk, r.buildLog).toBe(true);
					expect(r.exitCode, r.stdout + r.stderr).toBe(0);
					expect(r.stdout).toContain("PASS");
				});
			},
			180_000,
		);
});
