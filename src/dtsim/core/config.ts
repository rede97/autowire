// Workspace loading: find <project>/dt/config/dtsim.config.ts, materialize the
// DSL copy, import the TypeScript sources, merge cases, and compute compile
// fingerprints.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
	type PatchSpec,
	type SubcaseDef,
	type TaskSpec,
	type UvmCfg,
	type WaiveRuleDef,
	type WorkspaceDef,
} from "../dsl/index.ts";
import { assertNoDeniedAssignments, compileEnvEntries } from "./env.ts";
import { getTool, registerTool } from "./registry.ts";

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
	patches: PatchSpec[];
	hooks: Partial<Record<HookPhase, HookSpec>>;
	groups: Map<string, string[]>;
	cases: Map<string, CaseDef>;
	subcases: Map<string, SubcaseDef>;
};

export function expandVars(
	text: string,
	vars: {
		verify: string;
		workspace: string;
		output_dir?: string;
		caseId?: string;
		seed?: string;
		tool?: string;
	},
): string {
	const table: Record<string, string | undefined> = {
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
	return text.replace(
		/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
		(whole, name: string) => (table[name] === undefined ? whole : table[name]),
	);
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

export function compileFingerprint(c: MergedCase, toolId: string): string {
	return JSON.stringify({
		tool: toolId,
		defines: [...c.defines].sort(),
		compileArgs: [...c.compileArgs].sort(),
		env: compileEnvEntries(c.env),
		filelist: c.filelist ?? "",
		extra: [...(getTool(toolId).fingerprint?.(c) ?? [])].sort(),
	});
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
	await ensureDsl(verify);

	const configModule = await importModule(configPath);
	const wsDef = configModule.default as WorkspaceDef | undefined;
	if (!isWorkspace(wsDef)) {
		throw new Error(`dtsim: ${configPath} must default-export Workspace(...)`);
	}
	const o = wsDef.opts;
	for (const tool of o.tools ?? []) registerTool(tool);
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
		const path = resolve(verify, rel);
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

	// <project>/dt/config/dtsim.config.ts: dt/ holds the testbench, its parent
	// is the RTL design dir that filelists and ${workspace} resolve against.
	const dt = dirname(verify);
	const root = dirname(dt);
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

	return {
		configPath,
		root,
		verify,
		out: join(dt, "simout"),
		toolId: o.tool,
		filelist: resolve(verify, o.filelist ?? "file.lst"),
		toolOptions: { ...o.toolOptions },
		...partial,
		passthrough: [...(o.env?.passthrough ?? [])],
		deny,
		task: {
			type: o.task?.type ?? "local",
			...(o.task?.queue === undefined ? {} : { queue: o.task.queue }),
			maxSlots: o.task?.maxSlots ?? 8,
			maxCompiles: o.task?.maxCompiles ?? 4,
		},
		waive: [...(o.waive ?? [])],
		patches: [...(o.patches ?? [])],
		hooks: { ...o.hooks },
		groups,
	};
}

export async function applyPatches(
	ws: ResolvedWorkspace,
	compileDir: string,
	expand: (text: string) => string,
): Promise<void> {
	for (const patch of ws.patches) {
		const from = expand(patch.from);
		const to = expand(patch.to);
		const text = await readFile(from, "utf8");
		await mkdir(dirname(to), { recursive: true });
		await writeFile(to, expand(text));
	}
	if (compileDir.length === 0) throw new Error("dtsim: empty compile dir");
}
