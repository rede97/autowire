// Built-in launchers. A launcher decides HOW a command runs; the scheduler
// owns WHEN (slots and compile limits never reach it). The cluster ones block
// until the job ends so dtsim sees its exit code. `queue` falls back to
// $DTSIM_TASK_QUEUE (ctx.queue) when that is set; `args` go between the
// launcher's own flags and the wrapped command.
import type { Launcher } from "./index.ts";

export type ClusterOpts = {
	/** -q (LSF) / --qos (SLURM). */
	queue?: string;
	/** Extra flags, e.g. ["-R", "rusage[mem=8000]"] or ["--partition", "eda"]. */
	args?: readonly string[];
};

function needArgs(name: string, opts: ClusterOpts): readonly string[] {
	const { args, queue } = opts;
	if (queue !== undefined && typeof queue !== "string") {
		throw new Error(`dtsim: ${name} queue must be a string`);
	}
	if (args === undefined) return [];
	if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
		throw new Error(`dtsim: ${name} args must be a string array`);
	}
	return args;
}

/** "queue normal, -R rusage[mem=4000]" for the regression header. */
function clusterSummary(opts: ClusterOpts, args: readonly string[]): string {
	return [
		...(opts.queue ? [`queue ${opts.queue}`] : []),
		...(args.length ? [args.join(" ")] : []),
	].join(", ");
}

/** Run the command directly on this host. */
export function LocalLauncher(): Launcher {
	return {
		kind: "dtsim-launcher",
		name: "local",
		passthrough: [],
		wrap: (argv) => [...argv],
	};
}

/** LSF `bsub -I` (interactive batch). */
export function LsfLauncher(opts: ClusterOpts = {}): Launcher {
	const args = needArgs("LsfLauncher", opts);
	return {
		kind: "dtsim-launcher",
		name: "lsf",
		passthrough: ["LSF_*", "LSB_*"],
		summary: clusterSummary(opts, args),
		wrap(argv, ctx) {
			const queue = ctx.queue || opts.queue;
			return [
				"bsub",
				"-I",
				"-J",
				ctx.jobName,
				...(queue ? ["-q", queue] : []),
				...args,
				...argv,
			];
		},
	};
}

/** SLURM `srun --pty`. */
export function SlurmLauncher(opts: ClusterOpts = {}): Launcher {
	const args = needArgs("SlurmLauncher", opts);
	return {
		kind: "dtsim-launcher",
		name: "slurm",
		passthrough: ["SLURM_*"],
		summary: clusterSummary(opts, args),
		wrap(argv, ctx) {
			const queue = ctx.queue || opts.queue;
			return [
				"srun",
				"--pty",
				...(queue ? ["--qos", queue] : []),
				"--job-name",
				ctx.jobName,
				...args,
				...argv,
			];
		},
	};
}
