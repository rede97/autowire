// Remaining example cases. SIM_TRACE demonstrates a sim-only env variable:
// it reaches the simulator but never splits a compile group. `chip` shows an
// abstract base (derivation only): dtsim never runs it; its `rtl` / `gate`
// leaves are the runnable cases, and `*`, `chip`, or `chip.*` all expand to
// the leaves, never the base.
import { Case } from "../../../../../src/dtsim/dsl/index.ts";

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

bar.SubCase("cosim", {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: dtsim placeholder, expanded at run time
	compileArgs: ["-ad=${verify}/abc", "-debug_access+all"],
	simArgs: ["+fsdb+glitch=0"],
	env: { INPUT: "input.spf" },
});

// Abstract base: shared full-chip config, never run on its own. The DUT view
// is a compile-time define, so each leaf is its own build.
export const chip = Case("chip", {
	abstract: true,
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

chip.SubCase("rtl", { defines: ["VIEW_RTL"] });
chip.SubCase("gate", { defines: ["VIEW_GATE"], compileArgs: ["+sdf"] });

export const smoke = Case("test_quick_smoke", {
	owner: "dave",
	uvm: { test: "quick_test", timeout: "100ps" },
});
