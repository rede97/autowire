// Launch wiring. Launchers (src/dtsim/launchers/, or Workspace.launchers)
// decide HOW a command runs; the scheduler owns slots. DTSIM_TASK_TYPE /
// DTSIM_TASK_QUEUE override only the launcher id and queue; slot limits and
// options always come from the workspace config.
import type { LaunchContext, TaskSpec } from "../dsl/index.ts";
import { getLauncher } from "./registry.ts";

export type ResolvedTask = TaskSpec & {
	queue: string;
	options: Record<string, unknown>;
};

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
		options: { ...task.options },
	};
}

/** argv as the selected launcher runs it. */
export function wrapCommand(
	argv: readonly string[],
	task: ResolvedTask,
	ctx: Omit<LaunchContext, "queue" | "options">,
): string[] {
	return getLauncher(task.type).wrap(argv, {
		...ctx,
		queue: task.queue,
		options: task.options,
	});
}
