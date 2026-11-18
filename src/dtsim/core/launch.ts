// Launch wiring. The workspace's launcher (task.launcher) decides HOW a
// command runs; the scheduler owns slots. DTSIM_TASK_TYPE swaps in a built-in
// launcher by name (local / lsf / slurm) unless it names the configured one;
// DTSIM_TASK_QUEUE reaches the launcher as ctx.queue.
import {
	type LaunchContext,
	type Launcher,
	LocalLauncher,
	LsfLauncher,
	SlurmLauncher,
} from "../dsl/index.ts";

const BUILTIN: Record<string, () => Launcher> = {
	local: () => LocalLauncher(),
	lsf: () => LsfLauncher(),
	slurm: () => SlurmLauncher(),
};

/** The configured launcher after the DTSIM_TASK_TYPE override. */
export function resolveLauncher(configured: Launcher): Launcher {
	const name = process.env.DTSIM_TASK_TYPE ?? process.env.DSIM_TASK_TYPE;
	if (!name || name === configured.name) return configured;
	const make = BUILTIN[name];
	if (!make) {
		throw new Error(
			`dtsim: unknown task type "${name}" (built-in: ${Object.keys(BUILTIN).join(", ")}; configured: ${configured.name})`,
		);
	}
	return make();
}

/** argv as `launcher` runs it. */
export function wrapCommand(
	argv: readonly string[],
	launcher: Launcher,
	ctx: Omit<LaunchContext, "queue">,
): string[] {
	const queue =
		process.env.DTSIM_TASK_QUEUE ?? process.env.DSIM_TASK_QUEUE ?? "";
	return launcher.wrap(argv, { ...ctx, queue });
}
