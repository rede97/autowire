// dtsim demo workspace and a complete config reference:
//   Workspace(regEnv, (mode) => opts)
// - regEnv (arg 1): the environment knobs this config understands. `dtsim env`
//   lists them; an entry with `flags` is also a CLI option of run / regr /
//   plan / list / groups / env that sets the variable before the factory runs.
// - the factory (arg 2) computes the options from the mode (`run` / `regr`):
//   read env, pick seeds, waves and slots. dtsim then auto-fallbacks the tool
//   (probe) and probes the launcher.
// `top`, `wave` / `waveDepth` / `waveScope` and `cov` / `covMetrics` are
// workspace defaults every case inherits; a case overrides them
// (cases/chip.ts has its own top). With --cov a run ends with a Coverage
// table: each build's simv.vdb and its run_cov_merge script (dtsim merges
// nothing).
// The tools are fakes from ../bin (run.sh puts them first on PATH; the LSF
// launcher goes through the fake bsub). Repo demos import the DSL source;
// `docs unpack` rewrites the import to the .dtsim/dsl copy dtsim writes.
import {
	LocalLauncher,
	LsfLauncher,
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

function seedsFromEnv(): string[] {
	if (process.env.SEEDS) {
		return process.env.SEEDS.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	}
	if (process.env.RANDOM === undefined) return ["0"];
	const n = Number(process.env.RANDOM);
	if (!Number.isInteger(n) || n <= 0) {
		throw new Error("dtsim demo: --random must be a positive integer");
	}
	return Array.from({ length: n }, () =>
		String(Math.floor(Math.random() * 2 ** 31)),
	);
}

export default Workspace(
	[
		{
			name: "WAVE",
			values: "0|1",
			default: "run=1 regr=0",
			flags: "--wave",
			desc: "dump waveforms",
		},
		{ name: "COV", values: "0|1", default: "0", flags: "--cov", desc: "collect code coverage" },
		{ name: "SEEDS", flags: "--seeds <list>", desc: "comma-separated seeds" },
		{ name: "RANDOM", flags: "--random <n>", desc: "N random seeds" },
		{
			name: "DTSIM_SLOTS",
			default: "8",
			desc: "max concurrent sims on a farm (local runs one)",
		},
	],
	(mode) => ({
		tools: [VcsTool({ flags: vcsBaseFlags({ timescale: "1ns/1ps" }) })],
		// Simple benches need nothing here: every case's top is tb_top.
		top: "tb_top",
		wave:
			process.env.WAVE === undefined
				? mode === "run"
				: ["1", "true", "on", "yes"].includes(process.env.WAVE.toLowerCase()),
		cov: process.env.COV === "1",
		seeds: seedsFromEnv(),
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
		// DTSIM_TASK_TYPE=slurm|local forces one. Slots are sized from the
		// launcher that was picked.
		task: {
			launcher: [
				LsfLauncher({ queue: "normal", args: ["-R", "rusage[mem=4000]"] }),
				LocalLauncher(),
			],
			maxSlots: ({ launcher }) =>
				launcher === "local" ? 1 : Number(process.env.DTSIM_SLOTS ?? 8),
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
	}),
);
