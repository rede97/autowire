// Workspace loading: find <project>/dt/config/dtsim.config.ts, materialize the
// DSL copy, import the TypeScript sources, merge cases, and compute compile
// keys.
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	findWorkspace,
	loadWorkspace as loadTomlWorkspace,
} from "../../workspace.ts";
import { DSL_FILES } from "../dsl/embedded.generated.ts";
import {
	type CaseDef,
	type CaseOpts,
	type CovSpec,
	checkCaseOpts,
	DefaultGrader,
	type EnvValue,
	type EnvVarDoc,
	type Grader,
	type GroupDef,
	type GroupMember,
	type Hooks,
	isCase,
	isWorkspace,
	LocalLauncher,
	type SimTool,
	type SlotLimit,
	type TaskSpec,
	type UvmCfg,
	validateWorkspace,
	type WaveSpec,
	type WorkspaceDef,
} from "../dsl/index.ts";
import { assertNoDeniedAssignments, compileEnvEntries } from "./env.ts";
import { resolveLauncher } from "./launch.ts";
import { probeOk } from "./run.ts";

export type MergedCase = {
	id: string;
	/** Abstract base (abstract: true): derivation only, never run. */
	abstract: boolean;
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
	/** Top-level module: the case's `top`, else the workspace's. */
	top: string;
	/** Waveform dump; scope defaults to `top`. */
	wave: WaveSpec;
	/** Coverage (the backend may not collect it: SimTool.coverage). */
	cov: CovSpec;
	/** The case's grader (bareDefaults and parents included), else the workspace's. */
	grader: Grader;
	/** Tools the case runs on; undefined = every Workspace tool. */
	tools?: string[];
};

/** The fully-resolved workspace dtsim runs with. */
export type ResolvedWorkspace = {
	configPath: string;
	/** Project root: the RTL design dir that owns dt/. `${workspace}` / $WORKSPACE. */
	root: string;
	/** Config dir (<project>/dt/config). `${verify}`. */
	verify: string;
	/** Output root: <project>/dt/simout, plus /<tool> when several tools exist. */
	out: string;
	/** Selected backend: the first configured tool whose probe passes. */
	tool: SimTool;
	/** Every configured backend, in config order. */
	tools: SimTool[];
	/** The workspace seed set (default ["0"]). */
	seeds: string[];
	/** Workspace filelists, absolute. */
	filelists: string[];
	/** Workspace `top` / `wave*` / `cov*` case defaults applied: the base
	 *  every case inherits, below bareDefaults. */
	caseDefaults: {
		top: string;
		wave: boolean;
		waveDepth: number;
		waveScope?: string;
		cov: boolean;
		covMetrics: string;
	};
	bareDefaults?: CaseOpts;
	passthrough: string[];
	deny: string[];
	/** Environment knobs the config documents, for `dtsim env`. */
	vars: readonly EnvVarDoc[];
	/** Launcher after the probe / DTSIM_TASK_TYPE override, plus slot limits. */
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

export type WorkspaceEnv = {
	configPath: string;
	vars: readonly EnvVarDoc[];
};

/** Load only the config registry, without evaluating workspace options. */
export async function loadWorkspaceEnv(): Promise<WorkspaceEnv> {
	const configPath = configFile(await findConfig(process.cwd()));
	await ensureDsl(dirname(configPath));
	const wsDef = (await importModule(configPath)).default as
		| WorkspaceDef
		| undefined;
	if (!isWorkspace(wsDef)) {
		throw new Error(`dtsim: ${configPath} must default-export Workspace(...)`);
	}
	return { configPath, vars: [...wsDef.env] };
}

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
	for (const key of [
		"top",
		"wave",
		"waveDepth",
		"waveScope",
		"cov",
		"covMetrics",
	] as const) {
		if (overlay[key] !== undefined) Object.assign(out, { [key]: overlay[key] });
	}
	if (overlay.random !== undefined) out.random = overlay.random;
	if (overlay.grader !== undefined) out.grader = overlay.grader;
	if (overlay.tools !== undefined) out.tools = overlay.tools;
	return out;
}

type CaseSource = Pick<
	ResolvedWorkspace,
	| "cases"
	| "resolved"
	| "bareDefaults"
	| "deny"
	| "grader"
	| "tool"
	| "tools"
	| "caseDefaults"
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

/** Merged options of a node. A top-level case starts from the workspace's
 *  top / wave defaults with bareDefaults on them, then its own options; a
 *  derived case starts from its parent's merged options. Function options
 *  see that base as `parent` and run here, once per load. */
function treeOpts(ws: CaseSource, node: CaseDef): CaseOpts {
	const cached = ws.resolved.get(node.id);
	if (cached) return cached;
	const parent = node.parent
		? treeOpts(ws, node.parent)
		: mergeOpts(
				ws.caseDefaults,
				ws.bareDefaults ? forTool(ws, "bareDefaults", ws.bareDefaults) : {},
			);
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
		abstract: node.abstract,
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
		top: opts.top as string,
		wave: {
			enabled: opts.wave === true,
			depth: opts.waveDepth ?? 0,
			scope: opts.waveScope ?? (opts.top as string),
		},
		cov: { enabled: opts.cov === true, metrics: opts.covMetrics as string },
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
			`dtsim: case ${c.id} does not run on ${tool.name} (tools: ${c.tools?.join(", ")}); the config picks the tool by ordering Workspace tools`,
		);
	}
}

/** An abstract base used by mistake as a run target: the error for run / env. */
export function assertConcrete(c: MergedCase): void {
	if (c.abstract) {
		throw new Error(
			`dtsim: ${c.id} is an abstract base case (abstract: true); run a derived case`,
		);
	}
}

/** Compile identity of a case; equal keys share one build. The generic key
 *  keeps compileArgs in order: "-CFLAGS a -LDFLAGS b" and "-CFLAGS b
 *  -LDFLAGS a" are different builds. The backend may extend or replace it. */
export function compileKey(c: MergedCase, tool: SimTool): string {
	const base = JSON.stringify({
		tool: tool.name,
		top: c.top,
		// Depth and scope only matter (and only split builds) with waves on;
		// coverage likewise, and only on a backend that collects it.
		wave: c.wave.enabled ? c.wave : false,
		cov: c.cov.enabled && tool.coverage ? c.cov : false,
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

/** Runnable cases under a node: descend through abstract bases and stop at the
 *  first concrete case (which may still carry its own derived variants). */
function concreteFrontier(node: CaseDef): string[] {
	return node.abstract ? node.children.flatMap(concreteFrontier) : [node.id];
}

/** Member ids of a group, in member order, duplicates dropped. A group name
 *  that contains `*` is itself a pattern (`*` = top-level cases, `**` = every
 *  depth), so there is no reserved `all` group. Patterns and case objects are
 *  expanded against the loaded trees; an abstract base (named directly, matched
 *  by a pattern, or passed as an object) expands to the concrete cases it
 *  fronts. The members are merged so bad ids fail early. */
export function resolveGroup(ws: ResolvedWorkspace, group: string): string[] {
	let members: readonly GroupMember[];
	if (group.includes("*")) {
		members = [group];
	} else {
		const named = ws.groups.get(group);
		if (!named) {
			const known = [...ws.groups.keys()].sort().join(", ");
			throw new Error(
				`dtsim: unknown group "${group}" (groups: ${known || "none"}; or a pattern such as "*" or "sb.*")`,
			);
		}
		members = named;
	}
	const ids: string[] = [];
	const add = (id: string): void => {
		const node = findCase(ws, id);
		if (node?.abstract) ids.push(...concreteFrontier(node));
		else ids.push(id);
	};
	for (const m of members) {
		if (typeof m !== "string") {
			if (findCase(ws, m.id) !== m) {
				throw new Error(
					`dtsim: group "${group}": case ${m.id} is not part of an exported case tree`,
				);
			}
			add(m.id);
		} else if (m.includes("*")) {
			const re = idPattern(m);
			const hits = allIds(ws).filter((id) => re.test(id));
			if (hits.length === 0) {
				throw new Error(
					`dtsim: group "${group}": pattern "${m}" matches no case`,
				);
			}
			for (const id of hits) add(id);
		} else {
			add(m);
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

const CONFIG_REL = join("dt", "config", "dtsim.config.ts");

/** autowire.toml's `[dtsim] config` when set or when its default file exists;
 *  otherwise dt/config/dtsim.config.ts searched upward from `start`. */
async function findConfig(start: string): Promise<string> {
	const tomlPath = findWorkspace(start);
	if (tomlPath) {
		const toml = await loadTomlWorkspace(tomlPath);
		if (toml.dtsimConfigSet || existsSync(toml.dtsimConfig))
			return toml.dtsimConfig;
	}
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
		`dtsim: no ${CONFIG_REL} found from ${start}: set [dtsim] config in autowire.toml`,
	);
}

/** Check the selected config before anything is written next to it. The
 *  project root is derived from the path, so it must be
 *  <project>/dt/config/<file>.ts. */
function configFile(path: string): string {
	if (!existsSync(path)) throw new Error(`dtsim: ${path}: config not found`);
	const verify = dirname(path);
	if (
		extname(path) !== ".ts" ||
		basename(verify) !== "config" ||
		basename(dirname(verify)) !== "dt"
	) {
		throw new Error(
			`dtsim: ${path}: the config must live in <project>/dt/config/`,
		);
	}
	return path;
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
	mode?: "run" | "regr";
	/** Select this configured tool instead of the probe fallback. */
	tool?: string;
}): Promise<ResolvedWorkspace> {
	const cwd = opts.cwd ?? process.cwd();
	const configPath = configFile(
		opts.config ? resolve(cwd, opts.config) : await findConfig(cwd),
	);
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
	// Registered CLI options are parsed by Commander before this factory runs.
	const o =
		typeof wsDef.opts === "function"
			? wsDef.opts(opts.mode ?? "run")
			: wsDef.opts;
	// A factory's result is validated here (static opts were validated by
	// Workspace() at import).
	if (typeof wsDef.opts === "function") validateWorkspace(o);
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
	const launcher = await resolveLauncher(o.task?.launcher ?? LocalLauncher());

	// Tool auto-fallback: the first tool whose probe executables are all on
	// PATH (a tool with no probe is always available). `opts.tool` (a
	// regression's recheck) names the tool instead.
	const tools = [...o.tools];
	let fallback: SimTool;
	if (opts.tool !== undefined) {
		const named = tools.find((t) => t.name === opts.tool);
		if (!named) {
			throw new Error(
				`dtsim: tool "${opts.tool}" is not configured in ${configPath} (tools: ${tools.map((t) => t.name).join(", ")})`,
			);
		}
		fallback = named;
	} else {
		const available = await Promise.all(tools.map((t) => probeOk(t.probe)));
		fallback = tools.find((_, i) => available[i]) ?? (tools[0] as SimTool);
	}
	const ctx = { tool: fallback.name, launcher: launcher.name };
	const limit = (v: SlotLimit | undefined, d: number): number =>
		typeof v === "function" ? v(ctx) : (v ?? d);
	const task: TaskSpec = {
		launcher,
		maxSlots: limit(o.task?.maxSlots, 8),
		maxCompiles: limit(o.task?.maxCompiles, 4),
	};
	const outRoot =
		o.output === undefined ? join(dt, "simout") : resolvePath(o.output, paths);

	// The tool auto-fallback picks the backend; a factory may have ordered or
	// filtered `tools` to steer it. Several tools: one output tree each.
	const ws: ResolvedWorkspace = {
		configPath,
		root,
		verify,
		out: tools.length > 1 ? join(outRoot, fallback.name) : outRoot,
		tool: fallback,
		tools,
		seeds: [...(o.seeds ?? ["0"])],
		filelists: (o.filelists ?? []).map((f) => resolvePath(f, paths)),
		caseDefaults: {
			top: o.top ?? "tb_top",
			wave: o.wave ?? false,
			waveDepth: o.waveDepth ?? 0,
			...(o.waveScope === undefined ? {} : { waveScope: o.waveScope }),
			cov: o.cov ?? false,
			covMetrics: o.covMetrics ?? "line+cond+fsm+tgl+branch+assert",
		},
		cases,
		resolved: new Map(),
		...(o.bareDefaults === undefined ? {} : { bareDefaults: o.bareDefaults }),
		passthrough: [...(o.env?.passthrough ?? [])],
		deny,
		vars: [...wsDef.env],
		task,
		hooks: { ...o.hooks },
		grader: o.grader ?? DefaultGrader(),
		groups,
	};
	return ws;
}
