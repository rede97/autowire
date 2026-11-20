// demo/hbm VCS + UVM-1.2 regression (agents and RAL in dt/uvm, dv/ral).
// Run from demo/hbm:
//   bun ../../index.ts dtsim regr                  (or ./dt/vcs/run.sh)
//   bun ../../index.ts dtsim run hbm_rw_test --wave
// All cases share one compile group; each test is a +UVM_TESTNAME.
// Grading is the built-in DefaultGrader: the UVM Report Summary marks a
// finished run and any UVM_ERROR / UVM_FATAL message fails it.
import {
	Case,
	VcsTool,
	Workspace,
	vcsBaseFlags,
} from "../../../../src/dtsim/dsl/index.ts";

// VCS O-2018.09 compiles its UVM DPI (uvm_dpi.cc) with the g++ on PATH.
// g++ >= 10 rejects the curly quotes in a skipped `#error` of
// uvm_hdl_vcs.c, so the build fails there with or without dtsim.
// VCS_GCC_DIR (e.g. /usr/bin with gcc-9) points VCS at an older toolchain.
const gccDir = process.env.VCS_GCC_DIR;
const toolchain = gccDir
	? ["-cc", `${gccDir}/gcc`, "-cpp", `${gccDir}/g++`, "-ld", `${gccDir}/g++`]
	: [];

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
	filelists: ["hbm.f"],
	// Flags of the original run.sh: the backend defaults target newer VCS
	// (O-2018.09 rejects -xlrm nettype_array and -lca breaks its UVM DPI).
	tools: [
		VcsTool({
			ntbOpts: "uvm-1.2",
			flags: vcsBaseFlags({
				timescale: "1ns/1ps",
				debugaccess: "all",
			}),
		}),
	],
	bareDefaults: {
		random: false,
		// --no-as-needed / --allow-shlib-undefined: VCS O-2018.09 on newer binutils.
		compileArgs: [
			"-LDFLAGS",
			"-Wl,--no-as-needed -Wl,--allow-shlib-undefined",
			...toolchain,
		],
	},
	task: { maxSlots: 4, maxCompiles: 1 },
});
