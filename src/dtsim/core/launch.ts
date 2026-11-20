// Launch wiring. The workspace's launcher (task.launcher) decides HOW a
// command runs; the scheduler owns slots. A single launcher is used as-is; a
// list is probed (concurrently) and the first whose probe executables are all
// on PATH wins. DTSIM_TASK_TYPE forces a built-in or list entry by name and
// skips the probe; DTSIM_TASK_QUEUE reaches the launcher as ctx.queue.
import {
	type LaunchContext,
	type Launcher,
	LocalLauncher,
	LsfLauncher,
	SlurmLauncher,
} from "../dsl/index.ts";
import { onPath } from "./run.ts";

const BUILTIN: Record<string, () => Launcher> = {
	local: () => LocalLauncher(),
	lsf: () => LsfLauncher(),
	slurm: () => SlurmLauncher(),
};

/** Choose the launcher. A single value is an explicit choice, used without a
 *  probe. A list is probed concurrently and the first entry whose `probe`
 *  executables are all on PATH wins (local, no probe, always matches).
 *  DTSIM_TASK_TYPE forces a built-in or a list entry by name. */
export async function resolveLauncher(
	configured: Launcher | readonly Launcher[],
): Promise<Launcher> {
	const list: readonly Launcher[] = Array.isArray(configured)
		? configured
		: [configured as Launcher];
	const single = !Array.isArray(configured);
	const forced = process.env.DTSIM_TASK_TYPE ?? process.env.DSIM_TASK_TYPE;
	if (forced) {
		const inList = list.find((l) => l.name === forced);
		if (inList) return inList;
		const make = BUILTIN[forced];
		if (!make) {
			throw new Error(
				`dtsim: unknown task type "${forced}" (built-in: ${Object.keys(BUILTIN).join(", ")}; configured: ${list.map((l) => l.name).join(", ")})`,
			);
		}
		return make();
	}
	if (single) return list[0] as Launcher;
	const available = await Promise.all(
		list.map(async (l) => {
			const probe = l.probe ?? [];
			if (probe.length === 0) return true;
			const found = await Promise.all(probe.map((e) => onPath(e)));
			return found.every(Boolean);
		}),
	);
	const chosen = list.find((_, i) => available[i]);
	if (!chosen) {
		throw new Error(
			`dtsim: no configured launcher is available (probed ${list.map((l) => l.name).join(", ")}); add LocalLauncher() as a fallback`,
		);
	}
	return chosen;
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
