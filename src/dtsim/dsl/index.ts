// dtsim authoring DSL. Constructors validate at import time and return plain
// objects tagged with `kind`. Never use instanceof: the bundle and the
// materialized .dtsim/dsl copy may both be loaded in one process.

export { covFromEnv, RUN_ENV, waveFromEnv } from "./env.ts";
export {
	type ClusterOpts,
	LocalLauncher,
	LsfLauncher,
	SlurmLauncher,
} from "./launchers.ts";
export { type VcsOpts, VcsTool } from "./tools/vcs.ts";
export { type VerilatorOpts, VerilatorTool } from "./tools/verilator.ts";

export type EnvScope = "both" | "compile" | "sim";
export type EnvValue = string | { value: string; scope?: EnvScope };

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
	uvm?: UvmCfg;
	/** Per-case options the tool reads on top of its factory options
	 *  (e.g. VerilatorTool `top`, VcsTool `flags`); objects merge per key.
	 *  With several tools, put them under `byTool.<tool>`. */
	toolOptions?: Record<string, unknown>;
	/** Filelists (paths relative to dt/config), appended to the workspace's
	 *  and the parent's. dtsim never reads them: each reaches the tool as -f,
	 *  which runs in the project root. */
	filelists?: readonly string[];
	/** Grader for this case and its derived cases (default: Workspace.grader). */
	grader?: Grader;
	/** Tools this case runs on (default: every Workspace tool). Inherited. */
	tools?: readonly string[];
	/** Options merged on top of this level's options when that tool is
	 *  selected: `byTool: { vcs: { filelists: ["vcs.f"] }, verilator: { ... } }`. */
	byTool?: Readonly<Record<string, ToolCaseOpts>>;
};

/** Case options for one tool (`byTool.<tool>`): no nested tools / byTool. */
export type ToolCaseOpts = Omit<CaseOpts, "tools" | "byTool">;

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
	| "onResult";

/** Result statuses. A const object rather than a TS `enum`: graders may return
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

/** Statuses a grader may return (ABORTED is dtsim's own). */
export type GradeStatus = Exclude<Status, typeof Status.Aborted>;

export type TaskSpec = {
	/** How commands run. Default `LocalLauncher()`. */
	launcher: Launcher;
	maxSlots: number;
	maxCompiles: number;
};

/** What hooks and graders see for one case directory. */
export type CaseContext = {
	caseId: string;
	baseId: string;
	/** Compile dir (compile stages) or seed dir (sim stages, graders); `${output_dir}`. */
	dir: string;
	/** The phase log: compile log for compile stages, sim log otherwise. */
	log: string;
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
		filelists: string[];
	};
	/** The isolated environment the tool command of this phase receives. */
	env: Readonly<Record<string, string>>;
	/** Expand `${...}` placeholders in text. */
	expand: (text: string) => string;
	/** `${...}` placeholders plus shell variables, absolute against dt/config. */
	resolvePath: (text: string) => string;
	/** Run `command` with bash in `dir` under `env`. Output is appended to
	 *  `<dir>/hook-<stage>.log` (hooks) or `<dir>/grade.log` (graders) and
	 *  stdout returned; a non-zero exit throws. */
	sh: (command: string, opts?: { timeoutSec?: number }) => Promise<string>;
};

/** What every hook sees. Compile stages describe one compile directory (in a
 *  regression: the compile group's first case); sim stages one seed. */
export type HookContext = CaseContext & {
	stage: HookStage;
	/** Sim stages only. */
	seed?: string;
	/** onResult only: the final status. */
	status?: string;
};

/** A hook runs in the dtsim process; a throw (or rejected promise) fails that
 *  compile / seed, except onResult, whose errors are only logged. */
export type Hook = (ctx: HookContext) => void | Promise<void>;

export type Hooks = {
	/** Before the compile tool: generate or patch sources (and filelists). */
	preCompile?: Hook | readonly Hook[];
	postCompile?: Hook | readonly Hook[];
	preSim?: Hook | readonly Hook[];
	postSim?: Hook | readonly Hook[];
	onResult?: Hook | readonly Hook[];
};

const HOOK_STAGES: readonly string[] = [
	"preCompile",
	"postCompile",
	"preSim",
	"postSim",
	"onResult",
];

// --- Grader plugin contract --------------------------------------------------

/** What a grader sees for one seed after the simulation (and postSim). */
export type GradeContext = CaseContext & { seed: string };

/** A verdict with optional report. `details` rows go to the `run` summary
 *  and error.txt; `highlight` names log lines error.txt should show. */
export type GradeOutcome = {
	status: GradeStatus;
	/** Short text shown next to the status in results. */
	note?: string;
	details?: ReadonlyArray<readonly [string, string]>;
	highlight?: readonly string[];
};

/** Decides the status of one seed; also used by `results --recheck`.
 *  Built-in: DefaultGrader. dtsim reports NO SIM LOG itself when the log
 *  is missing; a throw or an unknown status grades FAIL. */
export type Grader = {
	kind: "dtsim-grader";
	/** Shown in grade.log and as $DTSIM_GRADER for ctx.sh. */
	name: string;
	grade: (
		ctx: GradeContext,
	) => GradeStatus | GradeOutcome | Promise<GradeStatus | GradeOutcome>;
};

export type WorkspaceOpts = {
	/** Simulator backends: VcsTool(...), VerilatorTool(...) or defineTool(...).
	 *  The first is the default; `--tool <name>` or $DTSIM_TOOL picks another. */
	tools: readonly SimTool[];
	/** Filelists every case compiles (paths relative to dt/config, `${...}`
	 *  allowed); cases append theirs. Default: none. */
	filelists?: readonly string[];
	/** Output root (`${...}` allowed; relative to dt/config). Default "${workspace}/dt/simout". */
	output?: string;
	/** Default grader. Default `DefaultGrader()`. */
	grader?: Grader;
	bareDefaults?: CaseOpts;
	env?: { passthrough?: readonly string[]; deny?: readonly string[] };
	task?: Partial<TaskSpec>;
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

/** Waveform switch ($DTSIM_WAVE*; read with waveFromEnv()). `top`: dump
 *  scope (default: the backend's top). */
export type WaveSpec = { enabled: boolean; depth: number; top?: string };
/** Coverage switch ($DTSIM_COV*; read with covFromEnv()). */
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
	/** Filelists of this case, absolute, workspace's first. Contents are the
	 *  tool's business: pass each as -f with the project root as cwd. */
	filelists: string[];
	regression: boolean;
	/** `run --interactive`: the terminal is attached to the simulator. */
	interactive: boolean;
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
	filelists: readonly string[];
};

export type SimTool = {
	kind: "dtsim-tool";
	/** `${tool}`, $DTSIM_TOOL and part of the compile key. */
	name: string;
	/** Parent-environment names this tool needs; copied only when present. */
	passthrough: readonly string[];
	/** true: first Ctrl+C is forwarded to the child (UCLI-style). */
	interactive: boolean;
	/**
	 * Compile identity: cases whose keys are equal share one build in a
	 * regression. `base` is dtsim's generic key (tool, defines as a set,
	 * compileArgs in order, compile-scope env, filelists). Return it, extend it
	 * (`${base}|top=x`), or replace it with what this simulator actually
	 * compiles from. Default: `base`.
	 */
	compileKey?: (c: CompileKeyInput, base: string) => string;
	/** Readable name of the build `c` stands for (the first case of a compile
	 *  group), shown in plans and progress and used for its directory
	 *  (`compile_<name>`). Default: the case id. Duplicates get `-2`, `-3`. */
	buildName?: (c: CompileKeyInput) => string;
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
	/** $DTSIM_TASK_QUEUE; "" when unset (a launcher's own queue applies). */
	queue: string;
	/** true only for `run --interactive`: the terminal is attached. */
	interactive: boolean;
};

/** Decides HOW a command runs (local, bsub, srun, ...). The scheduler owns
 *  WHEN: slots and compile limits never reach the launcher. */
export type Launcher = {
	kind: "dtsim-launcher";
	/** Shown in logs; $DTSIM_TASK_TYPE picks a built-in by this name. */
	name: string;
	/** Parent-environment names the launcher needs (LSF_*, SLURM_*);
	 *  copied like a SimTool's passthrough. */
	passthrough: readonly string[];
	/** Return the argv that runs `argv` (already tool-resolved) under this launcher. */
	wrap: (argv: readonly string[], ctx: LaunchContext) => string[];
	/** One line for the regression header, e.g. "queue normal, -R rusage[...]". */
	summary?: string;
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
	for (const key of [
		"defines",
		"compileArgs",
		"simArgs",
		"tools",
		"filelists",
	] as const) {
		const list = opts[key];
		if (list !== undefined && !Array.isArray(list)) {
			throw new Error(`dtsim: ${what}.${key} must be an array`);
		}
		if (list?.some((x) => typeof x !== "string")) {
			throw new Error(`dtsim: ${what}.${key} entries must be strings`);
		}
	}
	if (opts.grader !== undefined) needGrader(`${what}.grader`, opts.grader);
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
	if (opts.byTool !== undefined) {
		if (typeof opts.byTool !== "object" || opts.byTool === null) {
			throw new Error(`dtsim: ${what}.byTool must be { <tool>: options }`);
		}
		for (const [name, sub] of Object.entries(opts.byTool)) {
			const inner = sub as CaseOpts;
			if (inner?.tools !== undefined || inner?.byTool !== undefined) {
				throw new Error(
					`dtsim: ${what}.byTool.${name} cannot set tools or byTool`,
				);
			}
			needOpts(`${what}.byTool.${name}`, inner);
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

export function isGrader(v: unknown): v is Grader {
	return (
		typeof v === "object" && v !== null && (v as Grader).kind === "dtsim-grader"
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

function needTool(what: string, v: unknown): SimTool {
	if (!isTool(v)) {
		throw new Error(
			`dtsim: ${what} must be a tool (VcsTool(...), VerilatorTool(...) or defineTool(...))`,
		);
	}
	return v;
}

function needLauncher(what: string, v: unknown): Launcher {
	if (!isLauncher(v)) {
		throw new Error(
			`dtsim: ${what} must be a launcher (LocalLauncher(), LsfLauncher(...), SlurmLauncher(...) or defineLauncher(...))`,
		);
	}
	return v;
}

/** A user simulator backend; `interactive` defaults to false. */
export function defineTool(
	spec: Omit<SimTool, "kind" | "interactive"> & { interactive?: boolean },
): SimTool {
	needString("tool name", spec.name);
	if (
		typeof spec.compile !== "function" ||
		typeof spec.simulate !== "function"
	) {
		throw new Error(`dtsim: tool ${spec.name} needs compile() and simulate()`);
	}
	if (!Array.isArray(spec.passthrough)) {
		throw new Error(`dtsim: tool ${spec.name} needs a passthrough array`);
	}
	return {
		...spec,
		kind: "dtsim-tool",
		interactive: spec.interactive ?? false,
	};
}

/** A user launcher (cluster or wrapper backend). */
export function defineLauncher(spec: Omit<Launcher, "kind">): Launcher {
	needString("launcher name", spec.name);
	if (typeof spec.wrap !== "function") {
		throw new Error(`dtsim: launcher ${spec.name} needs wrap()`);
	}
	if (!Array.isArray(spec.passthrough)) {
		throw new Error(`dtsim: launcher ${spec.name} needs a passthrough array`);
	}
	return { ...spec, kind: "dtsim-launcher" };
}

function needGrader(what: string, v: unknown): Grader {
	if (!isGrader(v)) {
		throw new Error(
			`dtsim: ${what} must be a grader (DefaultGrader(...) or defineGrader(...))`,
		);
	}
	return v;
}

/** A user grader: `name` plus `grade(ctx)`. */
export function defineGrader(spec: Omit<Grader, "kind">): Grader {
	needString("grader name", spec.name);
	if (typeof spec.grade !== "function") {
		throw new Error(`dtsim: grader ${spec.name} needs grade()`);
	}
	return { kind: "dtsim-grader", name: spec.name, grade: spec.grade };
}

export function Workspace(opts: WorkspaceOpts): WorkspaceDef {
	if (typeof opts !== "object" || opts === null) {
		throw new Error("dtsim: Workspace options must be an object");
	}
	if (!Array.isArray(opts.tools) || opts.tools.length === 0) {
		throw new Error(
			"dtsim: Workspace tools must be a non-empty array, e.g. tools: [VcsTool()]",
		);
	}
	const names = new Set<string>();
	for (const [i, t] of opts.tools.entries()) {
		const tool = needTool(`workspace tools[${i}]`, t);
		if (names.has(tool.name)) {
			throw new Error(`dtsim: two Workspace tools are named "${tool.name}"`);
		}
		names.add(tool.name);
	}
	needList("Workspace filelists", opts.filelists);
	if (opts.task?.launcher !== undefined) {
		needLauncher("task.launcher", opts.task.launcher);
	}
	if (opts.grader !== undefined) needGrader("workspace grader", opts.grader);
	if (opts.bareDefaults) needOpts("bareDefaults", opts.bareDefaults);
	for (const [stage, value] of Object.entries(opts.hooks ?? {})) {
		if (!HOOK_STAGES.includes(stage)) {
			throw new Error(
				`dtsim: unknown hooks.${stage} (stages: ${HOOK_STAGES.join(", ")}; result verdicts are graders)`,
			);
		}
		const fns = Array.isArray(value) ? value : [value];
		if (fns.some((f) => typeof f !== "function")) {
			throw new Error(
				`dtsim: hooks.${stage} must be a function (ctx) => ... or an array of them`,
			);
		}
	}
	return { kind: "dtsim-workspace", opts };
}

// --- DefaultGrader -----------------------------------------------------------

export type DefaultGraderOpts = {
	/** A line matching any of these marks a finished run (substring, or "re:"
	 *  for a regex). Default ["TEST PASSED"]. */
	pass?: readonly string[];
	/** Kept (not waived) lines matching any of these: PASS WITH ERRORS.
	 *  Substring, or "re:" for a regex. */
	error?: readonly string[];
	/** Each must match somewhere in the log, else PASS WITH ERRORS. */
	expect?: readonly string[];
	/** Named rules switched on by DSIM_WAIVE_ON in the log. */
	waive?: readonly WaiveRuleDef[];
	/** A UVM Report Summary also marks a finished run, and any kept
	 *  UVM_ERROR / UVM_FATAL message fails the seed. Default true. */
	uvm?: boolean;
};

export type DefaultGraderDef = Grader & {
	readonly opts: Readonly<DefaultGraderOpts>;
	/** A new grader: lists and waive rules appended, `uvm` overridden. */
	extend(more: DefaultGraderOpts): DefaultGraderDef;
};

// --- Log scanning --------------------------------------------------------------

/** Lines of a (possibly huge) log, streamed: memory stays at one chunk. */
export async function* streamLines(path: string): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let rest = "";
	const reader = Bun.file(path).stream().getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		rest += decoder.decode(value, { stream: true });
		// CRLF logs (Windows tools): no trailing \r reaches a scanner, so
		// anchored keywords (re:^...$) match there too.
		const parts = rest.split(/\r?\n/);
		rest = parts.pop() ?? "";
		yield* parts;
	}
	rest = (rest + decoder.decode()).replace(/\r$/, "");
	if (rest.length > 0) yield rest;
}

/** Sees every line once, then reports. */
export type LineScanner<T> = { push(line: string): void; finish(): T };

/**
 * Run `makeScanner(arg)` over the lines of `path` in a worker thread: the
 * log is streamed there and only `finish()`'s result comes back, so a
 * multi-hundred-MB log neither fills memory nor blocks dtsim. `makeScanner`
 * is sent as source text: a function declaration or arrow that uses only its
 * own body, `arg` and globals. `arg` and the result must be
 * structured-cloneable.
 */
export async function scanLog<A, T>(
	path: string,
	makeScanner: (arg: A) => LineScanner<T>,
	arg: A,
): Promise<T> {
	const src = [
		`const makeScanner = (${makeScanner.toString()});`,
		`const streamLines = (${streamLines.toString()});`,
		"self.onmessage = async ({ data }) => {",
		"  try {",
		"    const scanner = makeScanner(data.arg);",
		"    for await (const line of streamLines(data.path)) scanner.push(line);",
		"    postMessage({ ok: true, value: scanner.finish() });",
		"  } catch (e) {",
		"    postMessage({ ok: false, error: String((e && e.stack) || e) });",
		"  }",
		"};",
	].join("\n");
	const url = URL.createObjectURL(
		new Blob([src], { type: "application/javascript" }),
	);
	const worker = new Worker(url);
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	worker.onmessage = ({ data }) =>
		data.ok ? resolve(data.value as T) : reject(new Error(data.error));
	worker.onerror = (e) => reject(new Error(e.message));
	worker.postMessage({ path, arg });
	try {
		return await promise;
	} finally {
		worker.terminate();
		URL.revokeObjectURL(url);
	}
}

export type GradeReport = {
	status: GradeStatus;
	/** A pass keyword (or, with uvm, the UVM Report Summary) was seen. */
	finished: boolean;
	/** The pass keywords that were looked for. */
	pass: string[];
	errorCounts: Record<string, number>;
	missingExpect: string[];
	uvmErrors: number;
	uvmFatals: number;
	waived: number;
	unclosed: boolean;
	unknown: string[];
	/** First kept lines that hit an error keyword or a UVM error / fatal. */
	hits: string[];
};

/**
 * DefaultGrader's line scanner. Self-contained (it runs in a worker).
 * Waive: marker lines are never kept (their text usually contains the error
 * pattern); DSIM_WAIVE_ON <rules> replaces the active named rules,
 * DSIM_WAIVE_OFF clears them; DSIM_WAIVE_BEGIN [pattern] .. DSIM_WAIVE_END
 * waives matching lines (all lines without a pattern), unclosed = to EOF.
 * Keywords: substring, or "re:" for a regex (an invalid one is a substring).
 */
export function defaultScanner(
	opts: DefaultGraderOpts & { maxHits?: number },
): LineScanner<GradeReport> {
	const match = (kw: string, line: string): boolean => {
		if (!kw.startsWith("re:")) return line.includes(kw);
		try {
			return new RegExp(kw.slice(3)).test(line);
		} catch {
			return line.includes(kw.slice(3));
		}
	};
	const rules: Record<string, string> = {};
	for (const r of opts.waive ?? []) rules[r.name] = r.pattern;
	const uvm = opts.uvm !== false;
	// A UVM message ("UVM_ERROR file.sv(12) @ 10ns: ..."), not the report
	// summary's count line ("UVM_ERROR :    0").
	const uvmMessage = /^\W*UVM_(ERROR|FATAL)\b(?!\s*:)/;
	const pass = opts.pass ?? ["TEST PASSED"];
	const errors = (opts.error ?? []).filter((kw) => kw.length > 0);
	const expects = (opts.expect ?? []).filter((kw) => kw.length > 0);
	const maxHits = opts.maxHits ?? 40;
	const seen = new Set<string>();
	const errorCounts: Record<string, number> = {};
	const hits: string[] = [];
	const unknown = new Set<string>();
	let active = new Set<string>();
	let finished = false;
	let inRegion = false;
	let regionPat = "";
	let waived = 0;
	let uvmErrors = 0;
	let uvmFatals = 0;
	const waivedLine = (line: string): boolean => {
		if (inRegion && (regionPat.length === 0 || match(regionPat, line)))
			return true;
		for (const name of active) {
			const pattern = rules[name];
			if (pattern !== undefined && match(pattern, line)) return true;
		}
		return false;
	};
	return {
		push(line) {
			if (
				!finished &&
				(pass.some((kw) => match(kw, line)) ||
					(uvm && line.includes("UVM Report Summary")))
			) {
				finished = true;
			}
			for (const kw of expects)
				if (!seen.has(kw) && match(kw, line)) seen.add(kw);
			if (line.includes("DSIM_WAIVE_ON")) {
				const names =
					line.split("DSIM_WAIVE_ON", 2)[1]?.trim().split(/\s+/) ?? [];
				active = new Set(names.filter((n) => n.length > 0));
				for (const n of active) if (rules[n] === undefined) unknown.add(n);
				return;
			}
			if (line.includes("DSIM_WAIVE_OFF")) {
				active = new Set();
				return;
			}
			if (line.includes("DSIM_WAIVE_BEGIN")) {
				inRegion = true;
				regionPat = line.slice(line.indexOf("DSIM_WAIVE_BEGIN") + 16).trim();
				return;
			}
			if (line.includes("DSIM_WAIVE_END")) {
				inRegion = false;
				regionPat = "";
				return;
			}
			if (waivedLine(line)) {
				waived += 1;
				return;
			}
			let hit = false;
			for (const kw of errors) {
				if (match(kw, line)) {
					errorCounts[kw] = (errorCounts[kw] ?? 0) + 1;
					hit = true;
				}
			}
			const msg = uvm ? uvmMessage.exec(line) : null;
			if (msg?.[1] === "ERROR") uvmErrors += 1;
			if (msg?.[1] === "FATAL") uvmFatals += 1;
			if ((hit || msg) && hits.length < maxHits) hits.push(line);
		},
		finish() {
			const missingExpect = expects.filter((kw) => !seen.has(kw));
			let status: GradeStatus = "PASS";
			if (!finished || uvmErrors + uvmFatals > 0) status = "FAIL";
			else if (Object.keys(errorCounts).length > 0 || missingExpect.length > 0)
				status = "PASS WITH ERRORS";
			return {
				status,
				finished,
				pass: [...pass],
				errorCounts,
				missingExpect,
				uvmErrors,
				uvmFatals,
				waived,
				unclosed: inRegion,
				unknown: [...unknown].sort(),
				hits,
			};
		},
	};
}

/** DefaultGrader's verdict on lines already in memory (tests, small logs). */
export function gradeLines(
	lines: Iterable<string>,
	opts: DefaultGraderOpts,
): GradeReport {
	const scanner = defaultScanner(opts);
	for (const line of lines) scanner.push(line);
	return scanner.finish();
}

function reportOutcome(r: GradeReport): GradeOutcome {
	const details: Array<[string, string]> = [];
	const unfinished = `no line matched ${r.pass.join(" | ") || "(no pass keyword)"}`;
	if (!r.finished) details.push(["Finished", unfinished]);
	const kws = Object.entries(r.errorCounts)
		.map(([kw, n]) => `${kw} (${n})`)
		.join(", ");
	if (kws) details.push(["Error kws", kws]);
	if (r.missingExpect.length > 0) {
		details.push(["Expect kws", `missing: ${r.missingExpect.join(", ")}`]);
	}
	const uvm = `UVM_ERROR ${r.uvmErrors}, UVM_FATAL ${r.uvmFatals}`;
	if (r.uvmErrors + r.uvmFatals > 0) details.push(["UVM", uvm]);
	if (r.waived > 0) details.push(["Waived errs", String(r.waived)]);
	if (r.unclosed) details.push(["Warning", "unclosed waive region"]);
	if (r.unknown.length > 0) {
		details.push(["Warning", `unknown waive rule: ${r.unknown.join(", ")}`]);
	}
	return {
		status: r.status,
		...(r.uvmErrors + r.uvmFatals > 0
			? { note: uvm }
			: r.finished
				? {}
				: { note: "not finished" }),
		details,
		highlight: r.hits,
	};
}

function needList(what: string, v: unknown): void {
	if (v === undefined) return;
	if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
		throw new Error(`dtsim: ${what} must be an array of strings`);
	}
}

/** The built-in grader (also the default when Workspace.grader is unset):
 *  pass / error / expect keywords, waive rules, and UVM report checks. */
export function DefaultGrader(opts: DefaultGraderOpts = {}): DefaultGraderDef {
	for (const key of ["pass", "error", "expect"] as const) {
		needList(`DefaultGrader.${key}`, opts[key]);
	}
	if (
		opts.waive !== undefined &&
		(!Array.isArray(opts.waive) ||
			opts.waive.some((r) => r?.kind !== "dtsim-waive"))
	) {
		throw new Error(
			"dtsim: DefaultGrader.waive must be WaiveRule(...) entries",
		);
	}
	if (opts.uvm !== undefined && typeof opts.uvm !== "boolean") {
		throw new Error("dtsim: DefaultGrader.uvm must be a boolean");
	}
	return {
		kind: "dtsim-grader",
		name: "default",
		opts,
		grade: async (ctx) => {
			if (!(await Bun.file(ctx.log).exists())) return Status.NoSimLog;
			return reportOutcome(await scanLog(ctx.log, defaultScanner, opts));
		},
		extend: (more) => {
			const join = <T>(a?: readonly T[], b?: readonly T[]) =>
				a === undefined && b === undefined
					? undefined
					: [...(a ?? []), ...(b ?? [])];
			const merged: DefaultGraderOpts = {};
			for (const key of ["pass", "error", "expect"] as const) {
				const list = join(opts[key], more[key]);
				if (list !== undefined) merged[key] = list;
			}
			const waive = join(opts.waive, more.waive);
			if (waive !== undefined) merged.waive = waive;
			const uvm = more.uvm ?? opts.uvm;
			if (uvm !== undefined) merged.uvm = uvm;
			return DefaultGrader(merged);
		},
	};
}
