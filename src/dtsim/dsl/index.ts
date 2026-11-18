// dtsim authoring DSL. Constructors validate at import time and return plain
// objects tagged with `kind`. Never use instanceof: the bundle and the
// materialized .dtsim/dsl copy may both be loaded in one process.

export type EnvScope = "both" | "compile" | "sim";
export type EnvValue = string | { value: string; scope?: EnvScope };

export type GradeSpec = {
	pass: string[];
	error: string[];
	expect: string[];
};

export type UvmCfg = {
	test?: string;
	verbosity?: string;
	maxQuit?: number;
	timeout?: string;
	drainTime?: number;
	seq?: string;
};

export type CaseOpts = {
	owner?: string;
	random?: boolean;
	defines?: readonly string[];
	compileArgs?: readonly string[];
	simArgs?: readonly string[];
	env?: Record<string, EnvValue>;
	grade?: Partial<GradeSpec>;
	uvm?: UvmCfg;
	/** Free-form per-tool options, interpreted by the selected SimTool only. */
	toolOptions?: Record<string, unknown>;
	/** Filelist for this case instead of the workspace one (relative to dt/config). */
	filelist?: string;
};

/** Case options, or a function computing them from the parent's merged
 *  options. Functions run only when that case is used (run, regr, env, plan)
 *  and at most once per load. */
export type CaseOptsInput =
	| CaseOpts
	| ((parent: Readonly<CaseOpts>) => CaseOpts);

export type CaseDef = {
	kind: "dtsim-case";
	/** Last id segment: the case name for a root, the suffix for a derived case. */
	name: string;
	/** Full id: root.suffix.suffix... */
	id: string;
	parent?: CaseDef;
	opts: CaseOptsInput;
	/** Derived cases, in declaration order. */
	readonly children: readonly CaseDef[];
	/** Derive `<id>.<suffix>`: lists append, maps merge, scalars override the
	 *  parent (which is this case, itself possibly derived). */
	SubCase(suffix: string, opts?: CaseOptsInput): CaseDef;
	/** Every derived case below this one, depth-first in declaration order
	 *  (not this case itself). Walks the tree only; options are not evaluated. */
	descendants(): CaseDef[];
};

/** A group member: a case object, an exact id, or an id pattern where `*`
 *  matches within one id segment and `**` across segments
 *  (`hello_world_base.*.cosim`, `hello_world_base.**`). */
export type GroupMember = string | CaseDef;

export type GroupDef = {
	kind: "dtsim-group";
	name: string;
	members: readonly GroupMember[];
};

export type WaiveRuleDef = {
	kind: "dtsim-waive";
	name: string;
	pattern: string;
};

export type HookStage =
	| "preCompile"
	| "postCompile"
	| "preSim"
	| "postSim"
	| "onGrade"
	| "onResult";

/** Result statuses. A const object rather than a TS `enum`: hooks may return
 *  either `Status.Pass` or the plain string `"PASS"`, and the value is the
 *  same in the bundled DSL and in the materialized .dtsim/dsl copy. */
export const Status = {
	Pass: "PASS",
	PassWithErrors: "PASS WITH ERRORS",
	Fail: "FAIL",
	NoSimLog: "NO SIM LOG",
	Aborted: "ABORTED",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

/** Statuses an onGrade hook may return (ABORTED is dtsim's own). */
export type HookStatus = Exclude<Status, typeof Status.Aborted>;

export type TaskSpec = {
	/** Launcher id: built-in "local" / "lsf" / "slurm", or a Workspace.launchers entry. */
	type: string;
	queue?: string;
	maxSlots: number;
	maxCompiles: number;
	/** Free-form launcher options, interpreted by the selected Launcher only. */
	options?: Record<string, unknown>;
};

/** What every hook sees. Compile stages describe one compile directory (in a
 *  regression: the compile group's first case); sim stages one seed. */
export type HookContext = {
	stage: HookStage;
	caseId: string;
	baseId: string;
	/** Compile dir (compile stages) or seed dir (sim stages); `${output_dir}`. */
	dir: string;
	/** Sim stages only. */
	seed?: string;
	/** The phase log: compile log for compile stages, sim log for sim stages. */
	log: string;
	/** onResult only: the final status. */
	status?: string;
	/** dt/config. */
	verify: string;
	/** Project root. */
	workspace: string;
	tool: string;
	/** Merged case options, placeholders intact. */
	caseOpts: {
		defines: readonly string[];
		compileArgs: readonly string[];
		simArgs: readonly string[];
		env: Readonly<Record<string, EnvValue>>;
		uvm?: UvmCfg;
		toolOptions: Record<string, unknown>;
		filelist?: string;
	};
	/** The isolated environment the tool command of this phase receives. */
	env: Readonly<Record<string, string>>;
	/** Expand `${...}` placeholders in text. */
	expand: (text: string) => string;
	/** `${...}` placeholders plus shell variables, absolute against dt/config. */
	resolvePath: (text: string) => string;
	/** Run `command` with bash in `dir` under `env`. Output is appended to
	 *  `<dir>/hook-<stage>.log` and stdout returned; a non-zero exit throws. */
	sh: (command: string, opts?: { timeoutSec?: number }) => Promise<string>;
};

/** A hook runs in the dtsim process; a throw (or rejected promise) fails that
 *  compile / seed, except onResult, whose errors are only logged. */
export type Hook = (ctx: HookContext) => void | Promise<void>;

/** Replaces keyword grading for one seed; also used by `results --recheck`. */
export type GradeHook = (ctx: HookContext) => HookStatus | Promise<HookStatus>;

export type Hooks = {
	/** Before the compile tool, before the filelist is flattened: generate or
	 *  patch sources (the former `patches`). */
	preCompile?: Hook | readonly Hook[];
	postCompile?: Hook | readonly Hook[];
	preSim?: Hook | readonly Hook[];
	postSim?: Hook | readonly Hook[];
	onGrade?: GradeHook;
	onResult?: Hook | readonly Hook[];
};

export type WorkspaceOpts = {
	tool: string;
	/** Filelist path (`${...}` allowed; relative to dt/config). Default "file.lst". */
	filelist?: string;
	/** Output root (`${...}` allowed; relative to dt/config). Default "${workspace}/dt/simout". */
	output?: string;
	tools?: readonly SimTool[];
	launchers?: readonly Launcher[];
	toolOptions?: Record<string, unknown>;
	bareDefaults?: CaseOpts;
	env?: { passthrough?: readonly string[]; deny?: readonly string[] };
	task?: Partial<TaskSpec>;
	waive?: readonly WaiveRuleDef[];
	hooks?: Hooks;
	groups?: readonly GroupDef[];
	cases?: readonly string[];
};

export type WorkspaceDef = {
	kind: "dtsim-workspace";
	opts: WorkspaceOpts;
};

// --- SimTool plugin contract -------------------------------------------------

export type Prepared = {
	argv: string[];
	cwd: string;
	/** Path of the phase log. */
	log: string;
	/** "tool": the tool writes the log itself (e.g. -l). "tee": dtsim captures it. */
	logMode: "tool" | "tee";
	/** Compile only: produced executable, used by --sim-only and run_sim. */
	executable?: string;
};

export type WaveSpec = { enabled: boolean; depth: number; top: string };
export type CovSpec = { enabled: boolean; metrics: string; merge: boolean };

export type ToolContext = {
	phase: "compile" | "sim";
	caseId: string;
	baseId: string;
	/** Merged, unresolved case options (raw strings, placeholders intact). */
	caseOpts: Required<Pick<CaseOpts, "defines" | "compileArgs" | "simArgs">> & {
		uvm?: UvmCfg;
		toolOptions: Record<string, unknown>;
	};
	dir: string;
	compileDir: string;
	seed?: string;
	/** Config dir: <project>/dt/config. */
	verify: string;
	/** Project root: the RTL design dir that owns dt/. */
	workspace: string;
	/** Flat filelist in the compile dir: nested -f inlined, paths absolute. */
	filelist: string;
	wave: WaveSpec;
	cov: CovSpec;
	regression: boolean;
	/** Expand ${verify}/${workspace}/${output_dir}/... placeholders. */
	expand: (text: string) => string;
	/** Same placeholders plus shell variables (${HOME}), then absolute against
	 *  dt/config; unknown names throw. For paths a backend reads or writes. */
	resolvePath: (text: string) => string;
};

/** The merged case options a compile key is computed from (placeholders intact). */
export type CompileKeyInput = {
	id: string;
	defines: readonly string[];
	compileArgs: readonly string[];
	simArgs: readonly string[];
	env: Readonly<Record<string, EnvValue>>;
	uvm?: UvmCfg;
	toolOptions: Record<string, unknown>;
	filelist?: string;
};

export type SimTool = {
	kind: "dtsim-tool";
	id: string;
	/** Parent-environment names this tool needs; copied only when present. */
	passthrough: readonly string[];
	/** true: first Ctrl+C is forwarded to the child (UCLI-style). */
	interactive: boolean;
	/**
	 * Compile identity: cases whose keys are equal share one build in a
	 * regression. `base` is dtsim's generic key (tool, defines as a set,
	 * compileArgs in order, compile-scope env, filelist). Return it, extend it
	 * (`${base}|top=x`), or replace it with what this simulator actually
	 * compiles from. Default: `base`.
	 */
	compileKey?: (c: CompileKeyInput, base: string) => string;
	/** Write tool-specific helper files (dump.tcl, run_verdi, ...). */
	writeAux?: (ctx: ToolContext) => void;
	compile: (ctx: ToolContext) => Prepared;
	simulate: (ctx: ToolContext) => Prepared;
	/** Used for error excerpts only; never for PASS/FAIL grading. */
	compileErrors: readonly RegExp[];
	simErrors: readonly RegExp[];
};

// --- Launcher plugin contract ------------------------------------------------

export type LaunchContext = {
	phase: "compile" | "sim";
	/** compile_<base> or <case>_<seed>. */
	jobName: string;
	caseId: string;
	seed?: string;
	/** Directory the wrapped command runs in. */
	cwd: string;
	/** task.queue after DTSIM_TASK_QUEUE; "" when unset. */
	queue: string;
	/** true only for `run --interactive`: the terminal is attached. */
	interactive: boolean;
	/** task.options, unresolved. */
	options: Record<string, unknown>;
};

/** Decides HOW a command runs (local, bsub, srun, ...). The scheduler owns
 *  WHEN: slots and compile limits never reach the launcher. */
export type Launcher = {
	kind: "dtsim-launcher";
	id: string;
	/** Parent-environment names the launcher needs (LSF_*, SLURM_*);
	 *  copied like a SimTool's passthrough. */
	passthrough: readonly string[];
	/** Return the argv that runs `argv` (already tool-resolved) under this launcher. */
	wrap: (argv: readonly string[], ctx: LaunchContext) => string[];
};

// --- constructors ------------------------------------------------------------

function needString(what: string, v: unknown): string {
	if (typeof v !== "string" || v.length === 0) {
		throw new Error(`dtsim: ${what} must be a non-empty string`);
	}
	return v;
}

function needOpts(what: string, opts: CaseOpts | undefined): CaseOpts {
	if (opts === undefined) return {};
	if (typeof opts !== "object" || opts === null) {
		throw new Error(`dtsim: ${what} options must be an object`);
	}
	for (const key of ["defines", "compileArgs", "simArgs"] as const) {
		const list = opts[key];
		if (list !== undefined && !Array.isArray(list)) {
			throw new Error(`dtsim: ${what}.${key} must be an array`);
		}
		if (list?.some((x) => typeof x !== "string")) {
			throw new Error(`dtsim: ${what}.${key} entries must be strings`);
		}
	}
	if (opts.filelist !== undefined)
		needString(`${what}.filelist`, opts.filelist);
	if (opts.env) {
		for (const [k, v] of Object.entries(opts.env)) {
			const bad =
				typeof v === "string"
					? false
					: typeof v !== "object" || v === null || typeof v.value !== "string";
			if (bad) {
				throw new Error(
					`dtsim: ${what}.env.${k} must be a string or { value, scope }`,
				);
			}
		}
	}
	return opts;
}

export function isCase(v: unknown): v is CaseDef {
	return (
		typeof v === "object" && v !== null && (v as CaseDef).kind === "dtsim-case"
	);
}

export function isWorkspace(v: unknown): v is WorkspaceDef {
	return (
		typeof v === "object" &&
		v !== null &&
		(v as WorkspaceDef).kind === "dtsim-workspace"
	);
}

export function isTool(v: unknown): v is SimTool {
	return (
		typeof v === "object" && v !== null && (v as SimTool).kind === "dtsim-tool"
	);
}

export function isLauncher(v: unknown): v is Launcher {
	return (
		typeof v === "object" &&
		v !== null &&
		(v as Launcher).kind === "dtsim-launcher"
	);
}

/** Validate evaluated case options (also used for lazily computed ones). */
export function checkCaseOpts(
	what: string,
	opts: CaseOpts | undefined,
): CaseOpts {
	return needOpts(what, opts);
}

function caseNode(
	name: string,
	id: string,
	opts: CaseOptsInput,
	parent: CaseDef | undefined,
): CaseDef {
	// Object options validate now; functions validate when evaluated.
	if (typeof opts !== "function") needOpts(id, opts);
	const children: CaseDef[] = [];
	const node: CaseDef = {
		kind: "dtsim-case",
		name,
		id,
		...(parent === undefined ? {} : { parent }),
		opts,
		children,
		SubCase(suffix: string, sub: CaseOptsInput = {}): CaseDef {
			needString(`subcase suffix of ${id}`, suffix);
			if (
				suffix.includes("/") ||
				suffix.includes(".") ||
				suffix === "default"
			) {
				throw new Error(`dtsim: invalid subcase suffix "${suffix}" on ${id}`);
			}
			if (children.some((c) => c.name === suffix)) {
				throw new Error(`dtsim: ${id} already has subcase "${suffix}"`);
			}
			const child = caseNode(suffix, `${id}.${suffix}`, sub, node);
			children.push(child);
			return child;
		},
		descendants(): CaseDef[] {
			return children.flatMap((c) => [c, ...c.descendants()]);
		},
	};
	return node;
}

/** A top-level case. Derive with `.SubCase(suffix, opts)`, at any depth; a
 *  case file only needs to export the top-level cases. */
export function Case(name: string, opts: CaseOpts = {}): CaseDef {
	needString("case name", name);
	if (name.includes(".") || name.includes("/")) {
		throw new Error(`dtsim: case name "${name}" must not contain "." or "/"`);
	}
	return caseNode(name, name, opts, undefined);
}

export function Group(name: string, members: readonly GroupMember[]): GroupDef {
	needString("group name", name);
	if (!Array.isArray(members)) {
		throw new Error(`dtsim: group ${name} members must be an array`);
	}
	for (const m of members) {
		if (typeof m !== "string" && !isCase(m)) {
			throw new Error(
				`dtsim: group ${name} members must be case ids, id patterns or Case objects`,
			);
		}
	}
	return { kind: "dtsim-group", name, members };
}

export function WaiveRule(name: string, pattern: string): WaiveRuleDef {
	needString("waive rule name", name);
	needString(`waive rule ${name} pattern`, pattern);
	return { kind: "dtsim-waive", name, pattern };
}

/** Validate and register a user simulator backend. */
export function defineTool(tool: SimTool): SimTool {
	if (!isTool(tool)) {
		throw new Error('dtsim: a tool must have kind: "dtsim-tool"');
	}
	needString("tool id", tool.id);
	if (
		typeof tool.compile !== "function" ||
		typeof tool.simulate !== "function"
	) {
		throw new Error(`dtsim: tool ${tool.id} needs compile() and simulate()`);
	}
	if (!Array.isArray(tool.passthrough)) {
		throw new Error(`dtsim: tool ${tool.id} needs a passthrough array`);
	}
	return tool;
}

/** Validate a user launcher (cluster or wrapper backend). */
export function defineLauncher(launcher: Launcher): Launcher {
	if (!isLauncher(launcher)) {
		throw new Error('dtsim: a launcher must have kind: "dtsim-launcher"');
	}
	needString("launcher id", launcher.id);
	if (typeof launcher.wrap !== "function") {
		throw new Error(`dtsim: launcher ${launcher.id} needs wrap()`);
	}
	if (!Array.isArray(launcher.passthrough)) {
		throw new Error(`dtsim: launcher ${launcher.id} needs a passthrough array`);
	}
	return launcher;
}

export function Workspace(opts: WorkspaceOpts): WorkspaceDef {
	if (typeof opts !== "object" || opts === null) {
		throw new Error("dtsim: Workspace options must be an object");
	}
	needString("workspace tool", opts.tool);
	for (const t of opts.tools ?? []) defineTool(t);
	for (const l of opts.launchers ?? []) defineLauncher(l);
	if (opts.bareDefaults) needOpts("bareDefaults", opts.bareDefaults);
	for (const [stage, value] of Object.entries(opts.hooks ?? {})) {
		const fns = Array.isArray(value) ? value : [value];
		if (fns.some((f) => typeof f !== "function")) {
			throw new Error(
				`dtsim: hooks.${stage} must be a function (ctx) => ...${stage === "onGrade" ? "" : " or an array of them"}`,
			);
		}
		if (stage === "onGrade" && Array.isArray(value)) {
			throw new Error("dtsim: hooks.onGrade takes one function");
		}
	}
	return { kind: "dtsim-workspace", opts };
}
