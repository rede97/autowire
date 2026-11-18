// Remaining example cases. SIM_TRACE demonstrates a sim-only env variable:
// it reaches the simulator but never splits a compile group.
import { Case, Subcase } from "../../../../../src/dtsim/dsl/index.ts";

export const bar = Case("test_bar_basic", {
	owner: "bob",
	defines: ["NUM=1"],
	simArgs: ["+BAR_MODE=1"],
	env: {
		BAR_CFG: "basic",
		SIM_TRACE: { value: "1", scope: "sim" },
	},
	uvm: {
		test: "top_test",
		verbosity: "UVM_MEDIUM",
		timeout: "2000ps",
		seq: "test_bar_seq",
	},
});

export const barCosim = Subcase(bar, "cosim", {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: dtsim placeholder, expanded at run time
	compileArgs: ["-ad=${verify}/abc", "-debug_access+all"],
	simArgs: ["+fsdb+glitch=0"],
	env: { INPUT: "input.spf" },
});

export const fullChip = Case("test_full_chip", {
	owner: "charlie",
	defines: ["NUM=1", "FULL_CHIP=1"],
	compileArgs: ["+fsdb+all"],
	uvm: {
		test: "full_chip_test",
		verbosity: "UVM_LOW",
		timeout: "10ms",
		seq: "test_full_chip_seq",
	},
});

export const fullChipCosim = Subcase(fullChip, "cosim", {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: dtsim placeholder, expanded at run time
	compileArgs: ["-ad=${verify}/abc", "-debug_access+all"],
	simArgs: ["+fsdb+glitch=0"],
	env: { INPUT: "input.spf" },
});

export const smoke = Case("test_quick_smoke", {
	owner: "dave",
	uvm: { test: "quick_test", timeout: "100ps" },
});
