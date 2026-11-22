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
import { probeOk } from "./run.ts";

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
	const forced = process.env.DTSIM_TASK_TYPE ?? process.env.DSIM_TASK_TYPE;
	// A single launcher (an array has no `wrap`): used as-is, no probe.
	if ("wrap" in configured)
		return forced ? pickForced(forced, [configured]) : configured;
	if (forced) return pickForced(forced, configured);
	const available = await Promise.all(configured.map((l) => probeOk(l.probe)));
	const chosen = configured.find((_, i) => available[i]);
	if (!chosen) {
		throw new Error(
			`dtsim: no configured launcher is available (probed ${configured.map((l) => l.name).join(", ")}); add LocalLauncher() as a fallback`,
		);
	}
	return chosen;
}

/** DTSIM_TASK_TYPE: a configured entry by name, else a built-in. */
function pickForced(forced: string, list: readonly Launcher[]): Launcher {
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
