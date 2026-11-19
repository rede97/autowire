// dtsim demo workspace: VCS backend, LSF slots, environment isolation.
// The tools are fakes from ../bin (run.sh puts them first on PATH; the LSF
// launcher goes through the fake bsub). Repo demos import the DSL source;
// `docs unpack` rewrites the import to the .dtsim/dsl copy dtsim writes.
import {
	LsfLauncher,
	VcsTool,
	Workspace,
} from "../../../../src/dtsim/dsl/index.ts";
import { grader } from "./grader.ts";
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
	tools: [VcsTool()],
	filelists: ["file.lst"],
	bareDefaults: {
		compileArgs: ["+nospecify", "+notimingcheck"],
	},
	env: {
		passthrough: ["PROJ_CFG", "DTSIM_MOCK_*", "DTSIM_DEMO_*"],
		deny: ["LD_PRELOAD"],
	},
	// LsfLauncher wraps every compile / sim in `bsub -I -J <job> -q normal
	// <args> <cmd>`; DTSIM_TASK_TYPE=slurm|local switches to a built-in.
	task: {
		launcher: LsfLauncher({ queue: "normal", args: ["-R", "rusage[mem=4000]"] }),
		maxSlots: 8,
		maxCompiles: 4,
	},
	grader,
	// One TypeScript function (or a list) per stage; see hooks.ts.
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
