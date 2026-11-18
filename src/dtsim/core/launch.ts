// Launchers decide HOW a command runs (local / bsub / srun), never when.
// The scheduler owns slots. DTSIM_TASK_TYPE overrides only the launcher id;
// slot limits always come from the workspace config.
import type { TaskSpec } from "../dsl/index.ts";

export type ResolvedTask = TaskSpec & { queue: string };

export function resolveTask(task: TaskSpec): ResolvedTask {
	return {
		...task,
		type:
			process.env.DTSIM_TASK_TYPE ?? process.env.DSIM_TASK_TYPE ?? task.type,
		queue:
			process.env.DTSIM_TASK_QUEUE ??
			process.env.DSIM_TASK_QUEUE ??
			task.queue ??
			"",
	};
}

export function wrapCommand(
	argv: string[],
	task: ResolvedTask,
	jobName: string,
): string[] {
	if (task.type === "lsf") {
		return [
			"bsub",
			"-I",
			"-J",
			jobName,
			...(task.queue ? ["-q", task.queue] : []),
			...argv,
		];
	}
	if (task.type === "slurm") {
		return [
			"srun",
			"--pty",
			...(task.queue ? ["--qos", task.queue] : []),
			"--job-name",
			jobName,
			...argv,
		];
	}
	if (task.type !== "local") {
		throw new Error(`dtsim: unknown task type "${task.type}"`);
	}
	return argv;
}
