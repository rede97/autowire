// Child-process environment assembly. Deny-by-default: a parent variable is
// copied only when the tool plugin or the user passthrough list names it.
// Case variables are explicit assignments, not inheritance. On Windows the
// few variables a process needs to start at all are always copied.
import type { EnvValue, SimTool } from "../dsl/index.ts";

const CONTROL_NAMES = new Set([
	"DTSIM_TASK_TYPE",
	"DTSIM_TASK_QUEUE",
	"DSIM_TASK_TYPE",
	"DSIM_TASK_QUEUE",
]);

/** Windows names are case-insensitive; compared upper-cased. */
const WINDOWS_ESSENTIAL = [
	"SYSTEMROOT",
	"SYSTEMDRIVE",
	"WINDIR",
	"COMSPEC",
	"PATHEXT",
	"TEMP",
	"TMP",
];

export type EnvSource = "plugin" | "user" | "case" | "inject";

export type BuiltEnv = {
	env: Record<string, string>;
	sources: Map<string, EnvSource>;
	stats: {
		inject: number;
		plugin: number;
		user: number;
		case: number;
		denied: number;
		dropped: number;
	};
};

function matches(pattern: string, name: string): boolean {
	// Windows environment names are case-insensitive ("Path" is PATH).
	const win = process.platform === "win32";
	const p = win ? pattern.toUpperCase() : pattern;
	const n = win ? name.toUpperCase() : name;
	return p.endsWith("*") ? n.startsWith(p.slice(0, -1)) : n === p;
}

function scopeOf(v: EnvValue): "both" | "compile" | "sim" {
	return typeof v === "string" ? "both" : (v.scope ?? "both");
}

function rawOf(v: EnvValue): string {
	return typeof v === "string" ? v : v.value;
}

/** Case env entries that take part in compilation and its compile key. */
export function compileEnvEntries(
	caseEnv: Record<string, EnvValue>,
): Array<[string, string]> {
	return Object.entries(caseEnv)
		.filter(([, v]) => scopeOf(v) !== "sim")
		.map(([k, v]) => [k, rawOf(v)] as [string, string])
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export function assertNoDeniedAssignments(
	caseId: string,
	caseEnv: Record<string, EnvValue>,
	deny: readonly string[],
): void {
	for (const key of Object.keys(caseEnv)) {
		if (deny.some((p) => matches(p, key))) {
			throw new Error(
				`dtsim: case ${caseId} assigns env.${key}, which is in the deny list`,
			);
		}
	}
}

export function buildChildEnv(args: {
	phase: "compile" | "sim";
	tool: SimTool;
	/** The selected launcher's passthrough (LSF_*, SLURM_*); counted as plugin. */
	launcherPassthrough?: readonly string[];
	passthrough: readonly string[];
	deny: readonly string[];
	caseEnv: Record<string, EnvValue>;
	injected: Record<string, string>;
	expand: (value: string) => string;
	parent?: Record<string, string | undefined>;
}): BuiltEnv {
	const parent = args.parent ?? process.env;
	const env: Record<string, string> = {};
	const sources = new Map<string, EnvSource>();

	const copy = (names: readonly string[], source: EnvSource): number => {
		let n = 0;
		for (const pattern of names) {
			for (const key of Object.keys(parent)) {
				if (!matches(pattern, key) || CONTROL_NAMES.has(key)) continue;
				const value = parent[key];
				if (value === undefined || sources.get(key) === "case") continue;
				if (env[key] === undefined) n += 1;
				env[key] = value;
				sources.set(key, source);
			}
		}
		return n;
	};

	if (process.platform === "win32") {
		for (const [key, value] of Object.entries(parent)) {
			if (value === undefined || !WINDOWS_ESSENTIAL.includes(key.toUpperCase()))
				continue;
			env[key] = value;
			sources.set(key, "plugin");
		}
	}
	const pluginCount =
		copy(args.tool.passthrough, "plugin") +
		copy(args.launcherPassthrough ?? [], "plugin");
	const userCount = copy(args.passthrough, "user");

	let denied = 0;
	for (const pattern of args.deny) {
		for (const key of Object.keys(env)) {
			if (matches(pattern, key)) {
				delete env[key];
				sources.delete(key);
				denied += 1;
			}
		}
	}

	let caseCount = 0;
	for (const [key, value] of Object.entries(args.caseEnv)) {
		const scope = scopeOf(value);
		if (scope !== "both" && scope !== args.phase) continue;
		env[key] = args.expand(rawOf(value));
		sources.set(key, "case");
		caseCount += 1;
	}

	let injectCount = 0;
	for (const [key, value] of Object.entries(args.injected)) {
		if (env[key] === undefined) injectCount += 1;
		env[key] = value;
		sources.set(key, "inject");
	}

	let dropped = 0;
	for (const key of Object.keys(parent)) {
		if (env[key] === undefined) dropped += 1;
	}

	return {
		env,
		sources,
		stats: {
			inject: injectCount,
			plugin: pluginCount,
			user: userCount,
			case: caseCount,
			denied,
			dropped,
		},
	};
}

export function envStatsLine(stats: BuiltEnv["stats"]): string {
	return (
		`env: inject ${stats.inject}, plugin ${stats.plugin}, ` +
		`user ${stats.user}, case ${stats.case}, ` +
		`denied ${stats.denied}, dropped ${stats.dropped}`
	);
}
