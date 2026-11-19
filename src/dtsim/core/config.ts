// Workspace loading: find <project>/dt/config/dtsim.config.ts, materialize the
// DSL copy, import the TypeScript sources, merge cases, and compute compile
// keys.
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DSL_FILES } from "../dsl/embedded.generated.ts";
import {
	type CaseDef,
	type CaseOpts,
	checkCaseOpts,
	DefaultGrader,
	type EnvValue,
	type Grader,
	type GroupDef,
	type GroupMember,
	type Hooks,
	isCase,
	isWorkspace,
	LocalLauncher,
	type SimTool,
	type TaskSpec,
	type UvmCfg,
	type WorkspaceDef,
} from "../dsl/index.ts";
import { assertNoDeniedAssignments, compileEnvEntries } from "./env.ts";
import { resolveLauncher } from "./launch.ts";

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
	uvm?: UvmCfg;
	toolOptions: Record<string, unknown>;
	/** Case filelists (config strings, relative to dt/config), appended in
	 *  merge order after the workspace's. */
	filelists: string[];
	/** Case grader, else bareDefaults' (bare top-level cases), else the workspace's. */
	grader: Grader;
	/** Tools the case runs on; undefined = every Workspace tool. */
	tools?: string[];
};

export type ResolvedWorkspace = {
	configPath: string;
	/** Project root: the RTL design dir that owns dt/. `${workspace}` / $WORKSPACE. */
	root: string;
	/** Config dir (<project>/dt/config). `${verify}`. */
	verify: string;
	/** Output root: <project>/dt/simout, plus /<tool> when several tools exist. */
	out: string;
	/** Selected backend (--tool, $DTSIM_TOOL, else the first of `tools`). */
	tool: SimTool;
	/** Every configured backend, in config order. */
	tools: SimTool[];
	/** Workspace filelists, absolute. */
	filelists: string[];
	bareDefaults?: CaseOpts;
	passthrough: string[];
	deny: string[];
	/** Launcher after the DTSIM_TASK_TYPE override, plus slot limits. */
	task: TaskSpec;
	hooks: Hooks;
	/** Default grader. */
	grader: Grader;
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
	for (const key of [
		"defines",
		"compileArgs",
		"simArgs",
		"filelists",
	] as const) {
		if (overlay[key] !== undefined || base[key] !== undefined) {
			out[key] = [...(base[key] ?? []), ...(overlay[key] ?? [])];
		}
	}
	if (base.env || overlay.env) out.env = { ...base.env, ...overlay.env };
	if (base.uvm || overlay.uvm) out.uvm = { ...base.uvm, ...overlay.uvm };
	if (base.toolOptions || overlay.toolOptions) {
		out.toolOptions = { ...base.toolOptions, ...overlay.toolOptions };
	}
	if (overlay.owner !== undefined) out.owner = overlay.owner;
	if (overlay.random !== undefined) out.random = overlay.random;
	if (overlay.grader !== undefined) out.grader = overlay.grader;
	if (overlay.tools !== undefined) out.tools = overlay.tools;
	return out;
}

type CaseSource = Pick<
	ResolvedWorkspace,
	"cases" | "resolved" | "bareDefaults" | "deny" | "grader" | "tool" | "tools"
>;

/** One level's options for the selected tool: its `byTool.<tool>` merged on
 *  top, `byTool` dropped. Tool names in `tools` / `byTool` must exist. */
function forTool(ws: CaseSource, what: string, opts: CaseOpts): CaseOpts {
	const known = ws.tools.map((t) => t.name);
	const check = (name: string, where: string) => {
		if (!known.includes(name)) {
			throw new Error(
				`dtsim: ${what}.${where}: no tool "${name}" (tools: ${known.join(", ")})`,
			);
		}
	};
	for (const name of opts.tools ?? []) check(name, "tools");
	for (const name of Object.keys(opts.byTool ?? {})) check(name, "byTool");
	const { byTool, ...rest } = opts;
	const extra = byTool?.[ws.tool.name];
	return extra ? mergeOpts(rest, extra) : rest;
}

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

/** Merged options of a node: bareDefaults as the lowest-priority base of
 *  every top-level case, then the root's options, then each derivation level
 *  in order (derived cases inherit bareDefaults through their parent).
 *  Function options run here, once per load. */
function treeOpts(ws: CaseSource, node: CaseDef): CaseOpts {
	const cached = ws.resolved.get(node.id);
	if (cached) return cached;
	const parent = node.parent
		? treeOpts(ws, node.parent)
		: ws.bareDefaults
			? forTool(ws, "bareDefaults", ws.bareDefaults)
			: {};
	const own = forTool(
		ws,
		node.id,
		typeof node.opts === "function"
			? checkCaseOpts(node.id, node.opts(parent))
			: node.opts,
	);
	const opts = mergeOpts(parent, own);
	assertNoDeniedAssignments(node.id, opts.env ?? {}, ws.deny);
	ws.resolved.set(node.id, opts);
	return opts;
}

export function mergeCase(ws: CaseSource, id: string): MergedCase {
	const node = findCase(ws, id);
	if (!node) throw new Error(`dtsim: testcase "${id}" not found`);
	const opts = treeOpts(ws, node);
	const grader = opts.grader ?? ws.grader;
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
		...(opts.uvm === undefined ? {} : { uvm: { ...opts.uvm } }),
		toolOptions: { ...opts.toolOptions },
		filelists: [...(opts.filelists ?? [])],
		grader,
		...(opts.tools === undefined ? {} : { tools: [...opts.tools] }),
	};
}

/** Whether a merged case runs on the selected tool (its `tools`, if set). */
export function runsOn(c: MergedCase, tool: SimTool): boolean {
	return c.tools === undefined || c.tools.includes(tool.name);
}

/** A case the selected tool cannot run: the error for run / env. */
export function assertRunsOn(c: MergedCase, tool: SimTool): void {
	if (!runsOn(c, tool)) {
		throw new Error(
			`dtsim: case ${c.id} does not run on ${tool.name} (tools: ${c.tools?.join(", ")}); pick one with --tool`,
		);
	}
}

/** Compile identity of a case; equal keys share one build. The generic key
 *  keeps compileArgs in order: "-CFLAGS a -LDFLAGS b" and "-CFLAGS b
 *  -LDFLAGS a" are different builds. The backend may extend or replace it. */
export function compileKey(c: MergedCase, tool: SimTool): string {
	const base = JSON.stringify({
		tool: tool.name,
		defines: [...c.defines].sort(),
		compileArgs: c.compileArgs,
		env: compileEnvEntries(c.env),
		filelists: c.filelists,
	});
	return tool.compileKey?.(c, base) ?? base;
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
	for (const [rel, text] of Object.entries(DSL_FILES)) {
		const target = join(dir, rel);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, text);
	}
	return join(dir, "index.ts");
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
	/** Tool name; default $DTSIM_TOOL, else the first Workspace tool. */
	tool?: string;
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
	// Only top-level cases need exporting, alone or inside an exported array,
	// Set or Map (values). A derived case exported as well registers its root;
	// the same root object exported twice is fine. Other objects (a Group's
	// members, the Workspace) are not searched.
	const cases = new Map<string, CaseDef>();
	const register = (value: unknown, from: string): void => {
		if (Array.isArray(value) || value instanceof Set) {
			for (const v of value) register(v, from);
			return;
		}
		if (value instanceof Map) {
			for (const v of value.values()) register(v, from);
			return;
		}
		if (!isCase(value)) return;
		let root = value;
		while (root.parent) root = root.parent;
		const known = cases.get(root.name);
		if (known && known !== root) {
			throw new Error(`dtsim: duplicate case "${root.name}" (${from})`);
		}
		cases.set(root.name, root);
	};
	const registerExports = (
		mod: Record<string, unknown>,
		from: string,
	): void => {
		for (const value of Object.values(mod)) register(value, from);
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
	// An unknown DTSIM_TASK_TYPE fails here, before any output dir exists.
	const task: TaskSpec = {
		launcher: resolveLauncher(o.task?.launcher ?? LocalLauncher()),
		maxSlots: o.task?.maxSlots ?? 8,
		maxCompiles: o.task?.maxCompiles ?? 4,
	};

	const tools = [...o.tools];
	const wanted = opts.tool ?? process.env.DTSIM_TOOL;
	const tool = wanted
		? tools.find((t) => t.name === wanted)
		: (tools[0] as SimTool);
	if (!tool) {
		const from = opts.tool ? "--tool" : "$DTSIM_TOOL";
		throw new Error(
			`dtsim: ${from} ${wanted}: not a Workspace tool (tools: ${tools.map((t) => t.name).join(", ")})`,
		);
	}
	const outRoot =
		o.output === undefined ? join(dt, "simout") : resolvePath(o.output, paths);

	return {
		configPath,
		root,
		verify,
		// Several tools: one output tree each, so switching never overwrites.
		out: tools.length > 1 ? join(outRoot, tool.name) : outRoot,
		tool,
		tools,
		filelists: (o.filelists ?? []).map((f) => resolvePath(f, paths)),
		cases,
		resolved: new Map(),
		...(o.bareDefaults === undefined ? {} : { bareDefaults: o.bareDefaults }),
		passthrough: [...(o.env?.passthrough ?? [])],
		deny,
		task,
		hooks: { ...o.hooks },
		grader: o.grader ?? DefaultGrader(),
		groups,
	};
}
