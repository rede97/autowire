// dtsim demo workspace and a complete config reference for the new model:
//   Workspace(regEnv, (mode) => opts)
// - regEnv (arg 1): the environment knobs this config documents; `dtsim env`
//   lists them.
// - the factory (arg 2) computes the options from the mode (`run` / `regr`):
//   read env, default DTSIM_WAVE, choose tools, set slots. dtsim then
//   auto-fallbacks the tool (probe) and probes the launcher.
// The tools are fakes from ../bin (run.sh puts them first on PATH; the LSF
// launcher goes through the fake bsub). Repo demos import the DSL source;
// `docs unpack` rewrites the import to the .dtsim/dsl copy dtsim writes.
import {
	LsfLauncher,
	LocalLauncher,
	VcsTool,
	Workspace,
	vcsBaseFlags,
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

export default Workspace(
	// Environment knobs documented for users, shown by `dtsim env`.
	[
		{ name: "WAVE", values: "0|1", default: "run=1 regr=0", desc: "dump waveforms" },
		{
			name: "SEEDS",
			flags: "--seeds <list>",
			desc: "comma-separated explicit seeds",
		},
		{
			name: "RANDOM",
			flags: "--random <n>",
			desc: "generate N random seeds",
		},
		{ name: "DTSIM_SLOTS", default: "8", desc: "max concurrent sims" },
	],
	(mode) => {
		// Default wave from the mode (dump a single run, not a regression),
		// unless WAVE / DTSIM_WAVE already set it. Backends read DTSIM_WAVE
		// at compile/sim time.
		if (process.env.WAVE === undefined && process.env.DTSIM_WAVE === undefined)
			process.env.DTSIM_WAVE = mode === "run" ? "1" : "0";
		const seeds = process.env.SEEDS
			? process.env.SEEDS.split(",").map((s) => s.trim()).filter(Boolean)
			: process.env.RANDOM
				? Array.from({ length: Number(process.env.RANDOM) }, () =>
						String(Math.floor(Math.random() * 2 ** 31)),
					)
				: ["0"];
		return {
			tools: [VcsTool({ flags: vcsBaseFlags({ timescale: "1ns/1ps" }) })],
			seeds,
			filelists: ["file.lst"],
			bareDefaults: {
				compileArgs: ["+nospecify", "+notimingcheck"],
			},
			env: {
				passthrough: ["PROJ_CFG", "DTSIM_MOCK_*", "DTSIM_DEMO_*"],
				deny: ["LD_PRELOAD"],
			},
			// Launcher probe: LSF where bsub exists, local otherwise. LsfLauncher
			// wraps each compile/sim in `bsub -I -J <job> -q normal <args> <cmd>`;
			// DTSIM_TASK_TYPE=slurm|local forces one.
			task: {
				launcher: [
					LsfLauncher({ queue: "normal", args: ["-R", "rusage[mem=4000]"] }),
					LocalLauncher(),
				],
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
		};
	},
);
