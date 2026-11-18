// demo/hbm VCS + UVM-1.2 regression (agents and RAL in dt/uvm, dv/ral).
// Run from demo/hbm:
//   bun ../../index.ts dtsim regr --no-wave        (or ./dt/vcs/run.sh)
//   bun ../../index.ts dtsim run hbm_rw_test --no-wave
// All cases share one compile group; each test is a +UVM_TESTNAME.
import { readFile } from "node:fs/promises";
import {
	Case,
	type HookContext,
	type HookStatus,
	Workspace,
} from "../../../../src/dtsim/dsl/index.ts";

// onGrade: the UVM report summary decides (zero UVM_ERROR and UVM_FATAL)
// instead of pass/error keywords. `results --recheck` calls it again.
async function uvmSummary(ctx: HookContext): Promise<HookStatus> {
	const log = await readFile(ctx.log, "utf8").catch(() => undefined);
	if (log === undefined) return "NO SIM LOG";
	const clean = /UVM_ERROR :\s+0\b/.test(log) && /UVM_FATAL :\s+0\b/.test(log);
	return clean ? "PASS" : "FAIL";
}

const uvmTest = (name: string) =>
	Case(name, {
		owner: "hbm",
		uvm: { test: name, verbosity: "UVM_MEDIUM", timeout: "100ms" },
	});

export const reset = uvmTest("hbm_reset_test");
export const ro = uvmTest("hbm_ro_test");
export const rw = uvmTest("hbm_rw_test");
export const bcastWrite = uvmTest("hbm_bcast_write_test");
export const bcastRead = uvmTest("hbm_bcast_read_test");
export const concurrent = uvmTest("hbm_concurrent_test");

export default Workspace({
	tool: "vcs",
	filelist: "hbm.f",
	// Flags of the original run.sh: the backend defaults target newer VCS
	// (O-2018.09 rejects -xlrm nettype_array and -lca breaks its UVM DPI).
	toolOptions: {
		ntbOpts: "uvm-1.2",
		flags: ["-sverilog", "-full64", "-timescale=1ns/1ps", "-debug_access+all"],
	},
	bareDefaults: {
		random: false,
		// --no-as-needed / --allow-shlib-undefined: VCS O-2018.09 on newer binutils.
		compileArgs: [
			"-LDFLAGS",
			"-Wl,--no-as-needed -Wl,--allow-shlib-undefined",
		],
	},
	task: { type: "local", maxSlots: 4, maxCompiles: 1 },
	hooks: { onGrade: uvmSummary },
});
