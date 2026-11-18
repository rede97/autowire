// Built-in SLURM launcher: srun --pty (dtsim waits for the step and sees its
// exit code). task.queue -> --qos; task.options.args (string[]) is inserted
// before the command, e.g. ["--partition", "eda", "--mem", "8G"].
import type { Launcher } from "../dsl/index.ts";
import { launcherArgs } from "./args.ts";

export const slurmLauncher: Launcher = {
	kind: "dtsim-launcher",
	id: "slurm",
	passthrough: ["SLURM_*"],
	wrap(argv, ctx) {
		return [
			"srun",
			"--pty",
			...(ctx.queue ? ["--qos", ctx.queue] : []),
			"--job-name",
			ctx.jobName,
			...launcherArgs("slurm", ctx.options),
			...argv,
		];
	},
};
