// Hello-world cases and their subcases, ported from dsim testcase.toml.
import { Case, Subcase } from "../../../../../src/dtsim/dsl/index.ts";

const cosim = {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: dtsim placeholder, expanded at run time
	compileArgs: ["-ad=${verify}/abc", "-debug_access+all"],
	simArgs: ["+fsdb+glitch=0"],
};

export const hello = Case("test_hello_world", {
	owner: "andy",
	random: false,
	defines: ["NUM=1"],
	simArgs: ["+TEST_OPT=1"],
	grade: {
		pass: ["TEST PASSED"],
		error: ["Error:"],
		expect: ["Keyword"],
	},
	uvm: {
		test: "top_test",
		verbosity: "UVM_HIGH",
		maxQuit: 9999,
		timeout: "1000ps",
		drainTime: 1000,
		seq: "test_hello_world_seq",
	},
});

export const helloCosim = Subcase(hello, "cosim", {
	...cosim,
	env: { INPUT: "input.spf" },
});

export const helloCosimSs = Subcase(hello, "cosim_ss", {
	...cosim,
	env: { INPUT: "input_ss.spf" },
});

export const helloCosimFf = Subcase(hello, "cosim_ff", {
	...cosim,
	env: { INPUT: "input_ff.spf" },
});

// grade.error appends: the base "Error:" keyword is still active here.
export const helloTiming = Subcase(hello, "timing", {
	grade: { error: ["re:ERROR:.*timing violation"] },
});
