// Built-in LSF launcher: bsub -I (interactive batch: dtsim waits for the job
// and sees its exit code). task.queue -> -q; task.options.args (string[]) is
// inserted before the command, e.g. ["-R", "rusage[mem=8000]", "-n", "4"].
import type { Launcher } from "../dsl/index.ts";
import { launcherArgs } from "./args.ts";

export const lsfLauncher: Launcher = {
	kind: "dtsim-launcher",
	id: "lsf",
	passthrough: ["LSF_*", "LSB_*"],
	wrap(argv, ctx) {
		return [
			"bsub",
			"-I",
			"-J",
			ctx.jobName,
			...(ctx.queue ? ["-q", ctx.queue] : []),
			...launcherArgs("lsf", ctx.options),
			...argv,
		];
	},
};
