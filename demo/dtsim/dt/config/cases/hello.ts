// Hello-world case and its derivation tree, ported from dsim testcase.toml.
// Only the top-level case is exported; dtsim walks .SubCase children:
//   test_hello_world
//     test_hello_world.cosim          (+ cosim compile args, typical deck)
//       test_hello_world.cosim.ss     (corner deck, computed lazily)
//       test_hello_world.cosim.ff
//     test_hello_world.timing
import { Case } from "../../../../../src/dtsim/dsl/index.ts";

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

const cosimCase = hello.SubCase("cosim", {
	...cosim,
	env: { INPUT: "input.spf" },
});

// A function runs only when that case is used, with the parent's merged
// options: here the corner deck name is derived from the cosim deck.
for (const corner of ["ss", "ff"]) {
	cosimCase.SubCase(corner, (parent) => {
		const deck = String(parent.env?.INPUT ?? "input.spf");
		return { env: { INPUT: deck.replace(".spf", `_${corner}.spf`) } };
	});
}

// grade.error appends: the base "Error:" keyword is still active here.
hello.SubCase("timing", {
	grade: { error: ["re:ERROR:.*timing violation"] },
});
