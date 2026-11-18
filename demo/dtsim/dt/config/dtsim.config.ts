// dtsim demo workspace: VCS backend, LSF slots, environment isolation.
// The tools are fakes from ../bin (run.sh puts them first on PATH; the LSF
// launcher goes through the fake bsub). Repo demos import the DSL source;
// `docs unpack` rewrites the import to the .dtsim/dsl copy dtsim writes.
import { WaiveRule, Workspace } from "../../../../src/dtsim/dsl/index.ts";
import { base, cosim, regrPlanA } from "./groups.ts";
import {
	metrics,
	recordResult,
	spiceDeck,
	stampHeader,
	stimulus,
	warningBudget,
} from "./hooks.ts";

export default Workspace({
	tool: "vcs",
	filelist: "file.lst",
	bareDefaults: {
		compileArgs: ["+nospecify", "+notimingcheck"],
	},
	env: {
		passthrough: ["PROJ_CFG", "DTSIM_MOCK_*", "DTSIM_DEMO_*"],
		deny: ["LD_PRELOAD"],
	},
	// Launcher "lsf" wraps every compile / sim in `bsub -I -J <job> -q normal
	// <options.args> <cmd>`; DTSIM_TASK_TYPE=slurm|local switches launcher.
	task: {
		type: "lsf",
		queue: "normal",
		maxSlots: 8,
		maxCompiles: 4,
		options: { args: ["-R", "rusage[mem=4000]"] },
	},
	waive: [
		WaiveRule("timing_rl_rdwin", "re:tRL_I \\+ tRDWIN_I .*timing violation"),
		WaiveRule("boot_timeout", "Error: timeout in boot phase"),
	],
	// One TypeScript function (or a list) per stage; see hooks.ts. A custom
	// grader (the result verdict) is shown in demo/hbm.
	hooks: {
		preCompile: [spiceDeck, stampHeader],
		postCompile: warningBudget,
		preSim: stimulus,
		postSim: metrics,
		onResult: recordResult,
	},
	groups: [base, regrPlanA, cosim],
	cases: ["./cases/hello.ts", "./cases/chip.ts"],
});
