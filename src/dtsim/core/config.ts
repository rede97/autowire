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
	checkCaseOpts,
	type EnvValue,
	type GradeSpec,
	type GroupDef,
	type GroupMember,
	type Hooks,
	isCase,
	isWorkspace,
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
	/** Top-level case name (first id segment). */
	base: string;
	/** Last id segment of a derived case. */
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
	hooks: Hooks;
	groups: Map<string, GroupMember[]>;
	/** Top-level cases by name; derived cases hang off `children`. */
	cases: Map<string, CaseDef>;
	/** Lazily merged options per case id (functions evaluated once). */
	resolved: Map<string, CaseOpts>;
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

type CaseSource = Pick<
	ResolvedWorkspace,
	"cases" | "resolved" | "bareDefaults" | "deny"
>;

/** Case node by id: root name, then one child per `.suffix`. */
export function findCase(
	ws: Pick<ResolvedWorkspace, "cases">,
	id: string,
): CaseDef | undefined {
	const [rootName, ...suffixes] = id.split(".");
	let node = ws.cases.get(rootName ?? "");
	for (const suffix of suffixes) {
		node = node?.children.find((c) => c.name === suffix);
	}
	return node;
}

/** Merged options of a node without bareDefaults: root options, then each
 *  derivation level in order. Function options run here, once per load. */
function treeOpts(ws: CaseSource, node: CaseDef): CaseOpts {
	const cached = ws.resolved.get(node.id);
	if (cached) return cached;
	const parent = node.parent ? treeOpts(ws, node.parent) : {};
	const own =
		typeof node.opts === "function"
			? checkCaseOpts(node.id, node.opts(parent))
			: node.opts;
	const opts = node.parent ? mergeOpts(parent, own) : own;
	assertNoDeniedAssignments(node.id, opts.env ?? {}, ws.deny);
	ws.resolved.set(node.id, opts);
	return opts;
}

export function mergeCase(ws: CaseSource, id: string): MergedCase {
	const node = findCase(ws, id);
	if (!node) throw new Error(`dtsim: testcase "${id}" not found`);
	let opts = treeOpts(ws, node);
	// A bare top-level case gets bareDefaults; derived cases do not.
	if (!node.parent && ws.bareDefaults) opts = mergeOpts(opts, ws.bareDefaults);
	const baseName = id.split(".")[0] as string;
	const suffix = node.parent ? node.name : undefined;
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

/** Every case id in tree order: each top-level case, then its descendants. */
function allIds(ws: Pick<ResolvedWorkspace, "cases">): string[] {
	return [...ws.cases.values()].flatMap((root) => [
		root.id,
		...root.descendants().map((c) => c.id),
	]);
}

/** `*` stays inside one id segment, `**` crosses segments. */
function idPattern(pattern: string): RegExp {
	const body = pattern
		.split("**")
		.map((part) =>
			part
				.split("*")
				.map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
				.join("[^.]*"),
		)
		.join(".*");
	return new RegExp(`^${body}$`);
}

/** Member ids of a group, in member order, duplicates dropped. Patterns and
 *  case objects are expanded against the loaded trees without evaluating any
 *  options; the members themselves are then merged so bad ids fail early. */
export function resolveGroup(ws: ResolvedWorkspace, group: string): string[] {
	if (group === "all") return [...ws.cases.keys()].sort();
	const members = ws.groups.get(group);
	if (!members) {
		const known = ["all", ...ws.groups.keys()].sort().join(", ");
		throw new Error(`dtsim: unknown group "${group}" (groups: ${known})`);
	}
	const ids: string[] = [];
	for (const m of members) {
		if (typeof m !== "string") {
			if (findCase(ws, m.id) !== m) {
				throw new Error(
					`dtsim: group "${group}": case ${m.id} is not part of an exported case tree`,
				);
			}
			ids.push(m.id);
		} else if (m.includes("*")) {
			const re = idPattern(m);
			const hits = allIds(ws).filter((id) => re.test(id));
			if (hits.length === 0) {
				throw new Error(
					`dtsim: group "${group}": pattern "${m}" matches no case`,
				);
			}
			ids.push(...hits);
		} else {
			ids.push(m);
		}
	}
	const unique = [...new Set(ids)];
	for (const id of unique) mergeCase(ws, id); // fail early on unknown ids
	return unique;
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

	// Only top-level cases need exporting. A derived case exported as well
	// registers its root; the same root object exported twice is fine.
	const cases = new Map<string, CaseDef>();
	const registerExports = (
		mod: Record<string, unknown>,
		from: string,
	): void => {
		for (const value of Object.values(mod)) {
			if (!isCase(value)) continue;
			let root = value;
			while (root.parent) root = root.parent;
			const known = cases.get(root.name);
			if (known && known !== root) {
				throw new Error(`dtsim: duplicate case "${root.name}" (${from})`);
			}
			cases.set(root.name, root);
		}
	};
	registerExports(configModule, configPath);
	for (const rel of o.cases ?? []) {
		const path = resolvePath(rel, paths);
		registerExports(await importModule(path), path);
	}

	const groups = new Map<string, GroupMember[]>();
	for (const g of (o.groups ?? []) as GroupDef[])
		groups.set(g.name, [...g.members]);

	// Case options (and deny checks on them) are evaluated per case on first
	// use, not here: a load touches only the cases a command runs.
	const deny = [...(o.env?.deny ?? [])];
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
		cases,
		resolved: new Map(),
		...(o.bareDefaults === undefined ? {} : { bareDefaults: o.bareDefaults }),
		passthrough: [...(o.env?.passthrough ?? [])],
		deny,
		task,
		waive: [...(o.waive ?? [])],
		hooks: { ...o.hooks },
		groups,
	};
}
