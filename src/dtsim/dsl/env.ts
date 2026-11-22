// Coverage switches read from the environment (DTSIM_COV*).
import type { CovSpec } from "./index.ts";

/** Coverage variables dtsim forwards to its children when set. */
export const RUN_ENV = [
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

/** $DTSIM_COV (default off), $DTSIM_COV_METRICS, $DTSIM_COV_MERGE (default on). */
export function covFromEnv(env: Env = process.env): CovSpec {
	return {
		enabled: flag(env, "DTSIM_COV", false),
		metrics: env.DTSIM_COV_METRICS?.trim() || "line+cond+fsm+tgl+branch+assert",
		merge: flag(env, "DTSIM_COV_MERGE", true),
	};
}
