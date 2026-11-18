// demo/hbm VCS + UVM-1.2 regression (agents and RAL in dt/uvm, dv/ral).
// Run from demo/hbm:
//   bun ../../index.ts dtsim regr --no-wave        (or ./dt/vcs/run.sh)
//   bun ../../index.ts dtsim run hbm_rw_test --no-wave
// All cases share one compile group; each test is a +UVM_TESTNAME.
import { readFile } from "node:fs/promises";
import {
	Case,
	defineGrader,
	Workspace,
} from "../../../../src/dtsim/dsl/index.ts";

// The UVM report summary decides (zero UVM_ERROR and UVM_FATAL) instead of
// pass/error keywords. `results --recheck` runs it again.
const uvmSummary = defineGrader({
	kind: "dtsim-grader",
	id: "uvm-summary",
	grade: async (ctx) => {
		const log = await readFile(ctx.log, "utf8");
		const count = (sev: string) =>
			Number(log.match(new RegExp(`${sev} :\\s+(\\d+)`))?.[1] ?? Number.NaN);
		const errors = count("UVM_ERROR");
		const fatals = count("UVM_FATAL");
		if (Number.isNaN(errors) || Number.isNaN(fatals)) {
			return { status: "FAIL", note: "no UVM report summary" };
		}
		return errors === 0 && fatals === 0
			? "PASS"
			: { status: "FAIL", note: `UVM_ERROR ${errors}, UVM_FATAL ${fatals}` };
	},
});

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
	graders: [uvmSummary],
	grader: "uvm-summary",
});
