// Workspace loading: find <project>/dt/config/dtsim.config.ts, materialize the
// DSL copy, import the TypeScript sources, merge cases, and compute compile
// keys.
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DSL_SOURCE } from "../dsl/embedded.generated.ts";
import {
	type CaseDef,
	type CaseOpts,
	type EnvValue,
	type GradeSpec,
	type GroupDef,
	type HookPhase,
	type HookSpec,
	isCase,
	isSubcase,
	isWorkspace,
	type Patch,
	type SubcaseDef,
	type TaskSpec,
	type UvmCfg,
	type WaiveRuleDef,
	type WorkspaceDef,
} from "../dsl/index.ts";
import { assertNoDeniedAssignments, compileEnvEntries } from "./env.ts";
import { resolveTask } from "./launch.ts";
import {
	getLauncher,
	getTool,
	registerLauncher,
	registerTool,
} from "./registry.ts";

export type MergedCase = {
	id: string;
	base: string;
	suffix?: string;
	owner: string;
	random: boolean;
	defines: string[];
	compileArgs: string[];
	simArgs: string[];
	env: Record<string, EnvValue>;
	grade: GradeSpec;
	uvm?: UvmCfg;
	toolOptions: Record<string, unknown>;
	/** Case filelist override, relative to the config dir (default: workspace filelist). */
	filelist?: string;
};

export type ResolvedWorkspace = {
	configPath: string;
	/** Project root: the RTL design dir that owns dt/. `${workspace}` / $WORKSPACE. */
	root: string;
	/** Config dir (<project>/dt/config). `${verify}`. */
	verify: string;
	/** Output root: <project>/dt/simout. */
	out: string;
	toolId: string;
	filelist: string;
	toolOptions: Record<string, unknown>;
	bareDefaults?: CaseOpts;
	passthrough: string[];
	deny: string[];
	task: TaskSpec;
	waive: WaiveRuleDef[];
	patches: Patch[];
	hooks: Partial<Record<HookPhase, HookSpec>>;
	groups: Map<string, string[]>;
	cases: Map<string, CaseDef>;
	subcases: Map<string, SubcaseDef>;
};

export type ExpandVars = {
	verify: string;
	workspace: string;
	output_dir?: string;
	caseId?: string;
	seed?: string;
	tool?: string;
};

function varTable(vars: ExpandVars): Record<string, string | undefined> {
	return {
		verify: vars.verify,
		workspace: vars.workspace,
		WORKSPACE: vars.workspace,
		project_home: vars.workspace,
		root: vars.workspace,
		output_dir: vars.output_dir,
		case: vars.caseId,
		seed: vars.seed,
		tool: vars.tool,
	};
}

/** Replace dtsim placeholders `${name}` in args, env values and patched file
 *  text. Bare `$NAME` and unknown names are left for the shell / simulator. */
export function expandVars(text: string, vars: ExpandVars): string {
	const table = varTable(vars);
	return text.replace(
		/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
		(whole, name: string) => table[name] ?? whole,
	);
}

function parentEnv(name: string): string | undefined {
	if (process.platform !== "win32") return process.env[name];
	const upper = name.toUpperCase();
	for (const [k, v] of Object.entries(process.env))
		if (k.toUpperCase() === upper) return v;
	return undefined;
}

/**
 * Turn a configured path into an absolute one. Same `${name}` placeholders
 * as args and env values: dtsim variables first (workspace, verify,
 * output_dir, case, seed, tool), then variables of the shell that started
 * dtsim (`${HOME}`, `${SCRATCH}`); a relative result resolves against `base`
 * (dt/config). Unknown names and bare `$NAME` are errors: a path never keeps
 * a literal `$` segment.
 */
export function resolvePath(
	text: string,
	vars: ExpandVars,
	base: string = vars.verify,
): string {
	const table = varTable(vars);
	const expanded = text.replace(
		/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
		(_whole, name: string) => {
			// dtsim names never fall back to the shell: `${case}` in a workspace
			// path is an error, not whatever $case the shell happens to hold.
			const value = name in table ? table[name] : parentEnv(name);
			if (value === undefined) {
				const why =
					name in table
						? "is not known for this path (only per-case paths see output_dir / case / seed)"
						: "is neither a dtsim variable nor set in the environment";
				throw new Error(`dtsim: path "${text}": \${${name}} ${why}`);
			}
			return value;
		},
	);
	// Checked on the source text: a substituted value may contain "$" itself.
	const bare = /\$([A-Za-z_][A-Za-z0-9_]*)/.exec(
		text.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, ""),
	);
	if (bare) {
		throw new Error(
			`dtsim: path "${text}": write \${${bare[1]}} instead of $${bare[1]}`,
		);
	}
	return resolve(base, expanded);
}

function mergeOpts(base: CaseOpts, overlay: CaseOpts): CaseOpts {
	const out: CaseOpts = { ...base };
	for (const key of ["defines", "compileArgs", "simArgs"] as const) {
		if (overlay[key] !== undefined || base[key] !== undefined) {
			out[key] = [...(base[key] ?? []), ...(overlay[key] ?? [])];
		}
	}
	if (base.env || overlay.env) out.env = { ...base.env, ...overlay.env };
	if (base.grade || overlay.grade) {
		out.grade = {
			pass: [...(base.grade?.pass ?? []), ...(overlay.grade?.pass ?? [])],
			error: [...(base.grade?.error ?? []), ...(overlay.grade?.error ?? [])],
			expect: [...(base.grade?.expect ?? []), ...(overlay.grade?.expect ?? [])],
		};
	}
	if (base.uvm || overlay.uvm) out.uvm = { ...base.uvm, ...overlay.uvm };
	if (base.toolOptions || overlay.toolOptions) {
		out.toolOptions = { ...base.toolOptions, ...overlay.toolOptions };
	}
	if (overlay.owner !== undefined) out.owner = overlay.owner;
	if (overlay.random !== undefined) out.random = overlay.random;
	if (overlay.filelist !== undefined) out.filelist = overlay.filelist;
	return out;
}

export function mergeCase(
	ws: Pick<ResolvedWorkspace, "cases" | "subcases" | "bareDefaults">,
	id: string,
): MergedCase {
	const dot = id.indexOf(".");
	const baseName = dot === -1 ? id : id.slice(0, dot);
	const base = ws.cases.get(baseName);
	if (!base) throw new Error(`dtsim: testcase "${id}" not found`);
	let opts = base.opts;
	let suffix: string | undefined;
	if (dot === -1) {
		if (ws.bareDefaults) opts = mergeOpts(opts, ws.bareDefaults);
	} else {
		const sub = ws.subcases.get(id);
		if (!sub) throw new Error(`dtsim: testcase "${id}" not found`);
		suffix = sub.suffix;
		opts = mergeOpts(opts, sub.opts);
	}
	return {
		id,
		base: baseName,
		...(suffix === undefined ? {} : { suffix }),
		owner: opts.owner ?? "",
		random: opts.random ?? true,
		defines: [...(opts.defines ?? [])],
		compileArgs: [...(opts.compileArgs ?? [])],
		simArgs: [...(opts.simArgs ?? [])],
		env: { ...opts.env },
		grade: {
			pass: opts.grade?.pass ?? ["TEST PASSED"],
			error: opts.grade?.error ?? [],
			expect: opts.grade?.expect ?? [],
		},
		...(opts.uvm === undefined ? {} : { uvm: { ...opts.uvm } }),
		toolOptions: { ...opts.toolOptions },
		...(opts.filelist === undefined ? {} : { filelist: opts.filelist }),
	};
}

/** Compile identity of a case; equal keys share one build. The generic key
 *  keeps compileArgs in order: "-CFLAGS a -LDFLAGS b" and "-CFLAGS b
 *  -LDFLAGS a" are different builds. The backend may extend or replace it. */
export function compileKey(c: MergedCase, toolId: string): string {
	const base = JSON.stringify({
		tool: toolId,
		defines: [...c.defines].sort(),
		compileArgs: c.compileArgs,
		env: compileEnvEntries(c.env),
		filelist: c.filelist ?? "",
	});
	return getTool(toolId).compileKey?.(c, base) ?? base;
}

export function resolveGroup(ws: ResolvedWorkspace, group: string): string[] {
	if (group === "all") return [...ws.cases.keys()].sort();
	const members = ws.groups.get(group);
	if (!members) {
		const known = ["all", ...ws.groups.keys()].sort().join(", ");
		throw new Error(`dtsim: unknown group "${group}" (groups: ${known})`);
	}
	for (const id of members) mergeCase(ws, id); // fail early on unknown ids
	return [...members];
}

/** Re-materialize the DSL next to the config so user files can import it. */
export async function ensureDsl(configDir: string): Promise<string> {
	const dir = join(configDir, ".dtsim", "dsl");
	await mkdir(dir, { recursive: true });
	const target = join(dir, "index.ts");
	await writeFile(target, DSL_SOURCE);
	return target;
}

/** Config location inside a project: <project>/dt/config/dtsim.config.ts. */
export const CONFIG_REL = join("dt", "config", "dtsim.config.ts");

async function findConfig(start: string): Promise<string> {
	let dir = resolve(start);
	for (let i = 0; i < 16; i++) {
		const candidate = join(dir, CONFIG_REL);
		if (existsSync(candidate)) return candidate;
		if (existsSync(join(dir, ".git"))) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(
		`dtsim: no dt/config/dtsim.config.ts found upward from ${start} (use --config)`,
	);
}

async function importModule(path: string): Promise<Record<string, unknown>> {
	// Static import cannot work here: the workspace config path is only known
	// at runtime, and user TypeScript must be loadable from the single-file
	// bundle without being part of its module graph.
	const url = `${pathToFileURL(path).href}?dtsim=${Date.now()}`;
	return (await import(url)) as Record<string, unknown>;
}

export async function loadWorkspace(opts: {
	config?: string;
	cwd?: string;
}): Promise<ResolvedWorkspace> {
	const cwd = opts.cwd ?? process.cwd();
	const configPath = opts.config
		? resolve(cwd, opts.config)
		: await findConfig(cwd);
	const verify = dirname(configPath);
	// <project>/dt/config/dtsim.config.ts: dt/ holds the testbench, its parent
	// is the RTL design dir that filelists and ${workspace} resolve against.
	const dt = dirname(verify);
	const root = dirname(dt);
	const paths: ExpandVars = { verify, workspace: root };
	await ensureDsl(verify);

	const configModule = await importModule(configPath);
	const wsDef = configModule.default as WorkspaceDef | undefined;
	if (!isWorkspace(wsDef)) {
		throw new Error(`dtsim: ${configPath} must default-export Workspace(...)`);
	}
	const o = wsDef.opts;
	for (const tool of o.tools ?? []) registerTool(tool);
	for (const launcher of o.launchers ?? []) registerLauncher(launcher);
	getTool(o.tool); // unknown tool fails before any output dir is created

	const cases = new Map<string, CaseDef>();
	const subcases = new Map<string, SubcaseDef>();
	const registerExports = (
		mod: Record<string, unknown>,
		from: string,
	): void => {
		for (const value of Object.values(mod)) {
			if (isCase(value)) {
				if (cases.has(value.name)) {
					throw new Error(`dtsim: duplicate case "${value.name}" (${from})`);
				}
				cases.set(value.name, value);
			} else if (isSubcase(value)) {
				if (subcases.has(value.name)) {
					throw new Error(`dtsim: duplicate subcase "${value.name}"`);
				}
				subcases.set(value.name, value);
			}
		}
	};
	registerExports(configModule, configPath);
	for (const rel of o.cases ?? []) {
		const path = resolvePath(rel, paths);
		registerExports(await importModule(path), path);
	}
	for (const sub of subcases.values()) {
		if (!cases.has(sub.base)) {
			throw new Error(
				`dtsim: subcase ${sub.name} has no base case ${sub.base}`,
			);
		}
	}

	const groups = new Map<string, string[]>();
	for (const g of (o.groups ?? []) as GroupDef[])
		groups.set(g.name, [...g.members]);

	const deny = [...(o.env?.deny ?? [])];
	const partial: Pick<
		ResolvedWorkspace,
		"cases" | "subcases" | "bareDefaults"
	> = {
		cases,
		subcases,
		...(o.bareDefaults === undefined ? {} : { bareDefaults: o.bareDefaults }),
	};
	for (const id of [...cases.keys(), ...subcases.keys()]) {
		assertNoDeniedAssignments(id, mergeCase(partial, id).env, deny);
	}
	const task: TaskSpec = {
		type: o.task?.type ?? "local",
		...(o.task?.queue === undefined ? {} : { queue: o.task.queue }),
		maxSlots: o.task?.maxSlots ?? 8,
		maxCompiles: o.task?.maxCompiles ?? 4,
		...(o.task?.options === undefined ? {} : { options: o.task.options }),
	};
	// Unknown launcher (config or DTSIM_TASK_TYPE) fails before any output dir.
	getLauncher(resolveTask(task).type);

	return {
		configPath,
		root,
		verify,
		out:
			o.output === undefined
				? join(dt, "simout")
				: resolvePath(o.output, paths),
		toolId: o.tool,
		filelist: resolvePath(o.filelist ?? "file.lst", paths),
		toolOptions: { ...o.toolOptions },
		...partial,
		passthrough: [...(o.env?.passthrough ?? [])],
		deny,
		task,
		waive: [...(o.waive ?? [])],
		patches: [...(o.patches ?? [])],
		hooks: Object.fromEntries(
			Object.entries(o.hooks ?? {}).map(([phase, spec]) => [
				phase,
				{ ...spec, path: resolvePath(spec.path, paths) },
			]),
		),
		groups,
	};
}
