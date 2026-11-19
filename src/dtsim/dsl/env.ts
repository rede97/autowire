// Run switches as environment variables. The CLI turns --wave / --cov / ...
// into DTSIM_* variables before the config is imported; backends read them
// when they are constructed (VcsTool(), VerilatorTool(), defineTool), so a
// switch has one source. Compile and sim children get the same variables,
// and run_compile / run_sim record them.
import type { CovSpec, WaveSpec } from "./index.ts";

/** Every run-switch variable dtsim forwards to its children when set. */
export const RUN_ENV = [
	"DTSIM_WAVE",
	"DTSIM_WAVE_DEPTH",
	"DTSIM_WAVE_TOP",
	"DTSIM_COV",
	"DTSIM_COV_METRICS",
	"DTSIM_COV_MERGE",
] as const;

type Env = Readonly<Record<string, string | undefined>>;

function flag(env: Env, name: string, fallback: boolean): boolean {
	const v = env[name]?.trim().toLowerCase();
	if (v === undefined || v === "") return fallback;
	if (["1", "true", "yes", "on"].includes(v)) return true;
	if (["0", "false", "no", "off"].includes(v)) return false;
	throw new Error(`dtsim: $${name}=${env[name]}: use 1 or 0`);
}

/** $DTSIM_WAVE (default off), $DTSIM_WAVE_DEPTH (default 0: every level),
 *  $DTSIM_WAVE_TOP (dump scope; default: the backend's top). */
export function waveFromEnv(env: Env = process.env): WaveSpec {
	const raw = env.DTSIM_WAVE_DEPTH?.trim() || "0";
	const depth = Number(raw);
	if (!Number.isInteger(depth) || depth < 0) {
		throw new Error(`dtsim: $DTSIM_WAVE_DEPTH=${raw}: use a whole number >= 0`);
	}
	const top = env.DTSIM_WAVE_TOP?.trim();
	return {
		enabled: flag(env, "DTSIM_WAVE", false),
		depth,
		...(top ? { top } : {}),
	};
}

/** $DTSIM_COV (default off), $DTSIM_COV_METRICS, $DTSIM_COV_MERGE (default on). */
export function covFromEnv(env: Env = process.env): CovSpec {
	return {
		enabled: flag(env, "DTSIM_COV", false),
		metrics: env.DTSIM_COV_METRICS?.trim() || "line+cond+fsm+tgl+branch+assert",
		merge: flag(env, "DTSIM_COV_MERGE", true),
	};
}
