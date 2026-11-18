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

export type CaseDef = {
	kind: "dtsim-case";
	name: string;
	opts: CaseOpts;
};

export type SubcaseDef = {
	kind: "dtsim-subcase";
	name: string;
	base: string;
	suffix: string;
	opts: CaseOpts;
};

export type GroupDef = {
	kind: "dtsim-group";
	name: string;
	members: readonly string[];
};

export type WaiveRuleDef = {
	kind: "dtsim-waive";
	name: string;
	pattern: string;
};

export type HookSpec = {
	kind: "dtsim-hook";
	path: string;
	fail: "stop" | "continue";
	timeoutSec: number;
};

export type HookPhase =
	| "preCompile"
	| "postCompile"
	| "preSim"
	| "postSim"
	| "onGrade"
	| "onResult";

export type TaskSpec = {
	type: string;
	queue?: string;
	maxSlots: number;
	maxCompiles: number;
};

export type PatchSpec = { from: string; to: string };

export type WorkspaceOpts = {
	tool: string;
	filelist?: string;
	tools?: readonly SimTool[];
	toolOptions?: Record<string, unknown>;
	bareDefaults?: CaseOpts;
	env?: { passthrough?: readonly string[]; deny?: readonly string[] };
	task?: Partial<TaskSpec>;
	waive?: readonly WaiveRuleDef[];
	patches?: readonly PatchSpec[];
	hooks?: Partial<Record<HookPhase, HookSpec>>;
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
};

export type SimTool = {
	kind: "dtsim-tool";
	id: string;
	/** Parent-environment names this tool needs; copied only when present. */
	passthrough: readonly string[];
	/** true: first Ctrl+C is forwarded to the child (UCLI-style). */
	interactive: boolean;
	/** Extra compile-fingerprint strings, e.g. top module. */
	fingerprint?: (c: {
		defines: readonly string[];
		compileArgs: readonly string[];
		toolOptions: Record<string, unknown>;
	}) => readonly string[];
	/** Write tool-specific helper files (dump.tcl, run_verdi, ...). */
	writeAux?: (ctx: ToolContext) => void;
	compile: (ctx: ToolContext) => Prepared;
	simulate: (ctx: ToolContext) => Prepared;
	/** Used for error excerpts only; never for PASS/FAIL grading. */
	compileErrors: readonly RegExp[];
	simErrors: readonly RegExp[];
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

export function isSubcase(v: unknown): v is SubcaseDef {
	return (
		typeof v === "object" &&
		v !== null &&
		(v as SubcaseDef).kind === "dtsim-subcase"
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

export function Case(name: string, opts: CaseOpts = {}): CaseDef {
	needString("case name", name);
	if (name.includes(".") || name.includes("/")) {
		throw new Error(`dtsim: case name "${name}" must not contain "." or "/"`);
	}
	return { kind: "dtsim-case", name, opts: needOpts(name, opts) };
}

export function Subcase(
	base: CaseDef,
	suffix: string,
	opts: CaseOpts = {},
): SubcaseDef {
	if (!isCase(base)) {
		throw new Error("dtsim: Subcase needs a Case(...) as its first arg");
	}
	needString("subcase suffix", suffix);
	if (suffix.includes("/") || suffix === "default" || suffix.includes(".")) {
		throw new Error(`dtsim: invalid subcase suffix "${suffix}"`);
	}
	return {
		kind: "dtsim-subcase",
		name: `${base.name}.${suffix}`,
		base: base.name,
		suffix,
		opts: needOpts(`${base.name}.${suffix}`, opts),
	};
}

export function Group(name: string, members: readonly string[]): GroupDef {
	needString("group name", name);
	if (!Array.isArray(members)) {
		throw new Error(`dtsim: group ${name} members must be an array`);
	}
	return { kind: "dtsim-group", name, members };
}

export function WaiveRule(name: string, pattern: string): WaiveRuleDef {
	needString("waive rule name", name);
	needString(`waive rule ${name} pattern`, pattern);
	return { kind: "dtsim-waive", name, pattern };
}

export function Hook(
	path: string,
	opts: { fail?: "stop" | "continue"; timeoutSec?: number } = {},
): HookSpec {
	needString("hook path", path);
	return {
		kind: "dtsim-hook",
		path,
		fail: opts.fail ?? "stop",
		timeoutSec: opts.timeoutSec ?? 600,
	};
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

export function Workspace(opts: WorkspaceOpts): WorkspaceDef {
	if (typeof opts !== "object" || opts === null) {
		throw new Error("dtsim: Workspace options must be an object");
	}
	needString("workspace tool", opts.tool);
	for (const t of opts.tools ?? []) defineTool(t);
	if (opts.bareDefaults) needOpts("bareDefaults", opts.bareDefaults);
	return { kind: "dtsim-workspace", opts };
}
