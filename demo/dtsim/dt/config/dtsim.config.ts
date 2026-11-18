// dtsim demo workspace: VCS backend, LSF slots, environment isolation.
// The tools are fakes from ../bin (run.sh puts them first on PATH; the LSF
// launcher goes through the fake bsub). The DSL copy under .dtsim/ is
// materialized by dtsim on every run.
import { WaiveRule, Workspace } from "./.dtsim/dsl/index.ts";
import { base, cosim, regrPlanA } from "./groups.ts";

export default Workspace({
	tool: "vcs",
	filelist: "file.lst",
	bareDefaults: {
		compileArgs: ["+nospecify", "+notimingcheck"],
	},
	env: {
		passthrough: ["PROJ_CFG", "DTSIM_MOCK_*"],
		deny: ["LD_PRELOAD"],
	},
	task: {
		type: "lsf",
		queue: "normal",
		maxSlots: 8,
		maxCompiles: 4,
	},
	waive: [
		WaiveRule("timing_rl_rdwin", "re:tRL_I \\+ tRDWIN_I .*timing violation"),
		WaiveRule("boot_timeout", "Error: timeout in boot phase"),
	],
	patches: [
		{
			// biome-ignore lint/suspicious/noTemplateCurlyInString: dtsim placeholder, expanded at run time
			from: "${verify}/cosim/spice/input.sp",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: dtsim placeholder, expanded at run time
			to: "${output_dir}/input.sp",
		},
	],
	hooks: {},
	groups: [base, regrPlanA, cosim],
	cases: ["./cases/hello.ts", "./cases/chip.ts"],
});
