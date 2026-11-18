// The demo's result grader: the built-in DefaultGrader with this project's
// waive rules (switched on by DSIM_WAIVE_ON in the log). Cases extend it with
// their own keywords; a UVM report summary is checked too.
import { DefaultGrader, WaiveRule } from "../../../../src/dtsim/dsl/index.ts";

export const grader = DefaultGrader({
	waive: [
		WaiveRule("timing_rl_rdwin", "re:tRL_I \\+ tRDWIN_I .*timing violation"),
		WaiveRule("boot_timeout", "Error: timeout in boot phase"),
	],
});
