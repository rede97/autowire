// Shared execution engine for single-case and regression runs: environment
// assembly, tool invocation, hooks, grading, and per-directory artifacts.
import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	CovSpec,
	HookStage,
	Status,
	ToolContext,
	WaveSpec,
} from "../dsl/index.ts";
import {
	type ExpandVars,
	expandVars,
	type MergedCase,
	type ResolvedWorkspace,
	resolvePath,
} from "./config.ts";
import { buildChildEnv, envStatsLine } from "./env.ts";
import { formatExcerpt } from "./excerpt.ts";
import { toolPath, writeFlatFilelist } from "./filelist.ts";
import {
	checkResultSource,
	type GradeDetails,
	gradeLog,
	waiveRuleMap,
} from "./grade.ts";
import { type HookBase, runGradeHook, runHooks } from "./hooks.ts";
import { resolveTask, wrapCommand } from "./launch.ts";
import { getLauncher, getTool } from "./registry.ts";
import { runProcess } from "./run.ts";
import { writeGitRev, writeResultMarker, writeRunSim } from "./scripts.ts";

export type EngineOptions = {
	verbose: boolean;
	interactive: boolean;
	/** true only for `regr`: shared compile dirs, absolute paths in run_sim. */
	regression: boolean;
	wave: WaveSpec;
	cov: CovSpec;
	abort?: AbortSignal;
};

export type SeedResult = {
	caseId: string;
	seed: string;
	dir: string;
	log: string;
	status: Status;
	code: number;
	details?: GradeDetails;
	note?: string;
};

/** Placeholder values for one case phase (forward slashes on Windows). */
export function varsFor(
	ws: ResolvedWorkspace,
	caseId: string,
	dir: string,
	seed?: string,
): ExpandVars {
	return {
		verify: toolPath(ws.verify),
		workspace: toolPath(ws.root),
		output_dir: toolPath(dir),
		caseId,
		...(seed === undefined ? {} : { seed }),
		tool: ws.toolId,
	};
}

export function expandFor(
	ws: ResolvedWorkspace,
	caseId: string,
	dir: string,
	seed?: string,
): (text: string) => string {
	const vars = varsFor(ws, caseId, dir, seed);
	return (text) => expandVars(text, vars);
}

/** Source filelist of a case: its own override, else the workspace one. */
export function caseFilelist(
	ws: ResolvedWorkspace,
	c: MergedCase,
	dir: string,
): string {
	return c.filelist === undefined
		? ws.filelist
		: resolvePath(c.filelist, varsFor(ws, c.id, dir));
}

/** The flattened, absolute filelist dtsim writes into every compile dir. */
export function flatFilelist(compileDir: string): string {
	return join(compileDir, "filelist.f");
}

export function toolContext(
	ws: ResolvedWorkspace,
	c: MergedCase,
	phase: "compile" | "sim",
	dir: string,
	compileDir: string,
	seed: string | undefined,
	opts: EngineOptions,
): ToolContext {
	return {
		phase,
		caseId: c.id,
		baseId: c.base,
		caseOpts: {
			defines: c.defines,
			compileArgs: c.compileArgs,
			simArgs: c.simArgs,
			...(c.uvm === undefined ? {} : { uvm: c.uvm }),
			toolOptions: { ...ws.toolOptions, ...c.toolOptions },
		},
		dir,
		compileDir,
		...(seed === undefined ? {} : { seed }),
		verify: ws.verify,
		workspace: ws.root,
		filelist: toolPath(flatFilelist(compileDir)),
		wave: opts.wave,
		cov: opts.cov,
		regression: opts.regression,
		expand: expandFor(ws, c.id, dir, seed),
		resolvePath: (text) => resolvePath(text, varsFor(ws, c.id, dir, seed)),
	};
}

export function childEnv(
	ws: ResolvedWorkspace,
	c: MergedCase,
	phase: "compile" | "sim",
	dir: string,
	seed?: string,
) {
	return buildChildEnv({
		phase,
		tool: getTool(ws.toolId),
		launcherPassthrough: getLauncher(resolveTask(ws.task).type).passthrough,
		passthrough: ws.passthrough,
		deny: ws.deny,
		caseEnv: c.env,
		injected: {
			WORKSPACE: ws.root,
			workspace: ws.root,
			project_home: ws.root,
			verify: ws.verify,
			output_dir: dir,
			DTSIM_TOOL: ws.toolId,
			DTSIM_CASE: c.id,
			DTSIM_PHASE: phase,
			...(seed === undefined ? {} : { DTSIM_SEED: seed }),
		},
		expand: expandFor(ws, c.id, dir, seed),
	});
}

/** The shared hook context for one stage of one case directory. */
export function hookBase(
	ws: ResolvedWorkspace,
	c: MergedCase,
	stage: HookStage,
	dir: string,
	log: string,
	env: Record<string, string>,
	extra: { seed?: string; status?: string } = {},
): HookBase {
	const vars = varsFor(ws, c.id, dir, extra.seed);
	return {
		stage,
		caseId: c.id,
		baseId: c.base,
		dir,
		...extra,
		log,
		verify: ws.verify,
		workspace: ws.root,
		tool: ws.toolId,
		caseOpts: {
			defines: c.defines,
			compileArgs: c.compileArgs,
			simArgs: c.simArgs,
			env: c.env,
			...(c.uvm === undefined ? {} : { uvm: c.uvm }),
			toolOptions: { ...ws.toolOptions, ...c.toolOptions },
			...(c.filelist === undefined ? {} : { filelist: c.filelist }),
		},
		env,
		expand: (text) => expandVars(text, vars),
		resolvePath: (text) => resolvePath(text, vars),
	};
}

/** Run one stage; on a throw write error.txt (phase: hook) and report it. */
async function hookStage(
	ws: ResolvedWorkspace,
	base: HookBase,
): Promise<{ log: string } | undefined> {
	const failure = await runHooks(ws.hooks, base);
	if (!failure) return undefined;
	await writeFile(
		join(base.dir, "error.txt"),
		formatExcerpt({
			status: "FAIL",
			phase: "hook",
			tool: ws.toolId,
			caseId: base.caseId,
			...(base.seed === undefined ? {} : { seed: base.seed }),
			log: failure.log,
			hookLog: failure.log,
		}),
	);
	return { log: failure.log };
}

export type CompileOutcome = {
	ok: boolean;
	code: number;
	log: string;
	hookFailed: boolean;
};

export async function executeCompile(
	ws: ResolvedWorkspace,
	c: MergedCase,
	compileDir: string,
	opts: EngineOptions,
): Promise<CompileOutcome> {
	const tool = getTool(ws.toolId);
	const ctx = toolContext(
		ws,
		c,
		"compile",
		compileDir,
		compileDir,
		undefined,
		opts,
	);
	await mkdir(compileDir, { recursive: true });
	tool.writeAux?.(ctx);
	const env = childEnv(ws, c, "compile", compileDir);
	if (opts.verbose) process.stderr.write(`${envStatsLine(env.stats)}\n`);
	// Preparing argv is pure; it gives preCompile the compile log path.
	const prepared = tool.compile(ctx);
	const stage = (s: HookStage) =>
		hookBase(ws, c, s, compileDir, prepared.log, env.env);
	// preCompile runs before the filelist is flattened so it can generate or
	// patch sources the filelist names.
	const pre = await hookStage(ws, stage("preCompile"));
	if (pre) return { ok: false, code: 1, log: pre.log, hookFailed: true };
	writeFlatFilelist(
		caseFilelist(ws, c, compileDir),
		flatFilelist(compileDir),
		ws.root,
		ctx.expand,
	);
	writeGitRev(compileDir, ws.verify);

	let hookFailed = false;
	const task = resolveTask(ws.task);
	const argv = wrapCommand(prepared.argv, task, {
		phase: "compile",
		jobName: `compile_${c.base}`,
		caseId: c.id,
		cwd: prepared.cwd,
		interactive: false,
	});
	let code = await runProcess({
		argv,
		cwd: prepared.cwd,
		env: env.env,
		...(prepared.logMode === "tee" ? { captureLog: prepared.log } : {}),
		verbose: opts.verbose,
		interactive: false,
		...(opts.abort === undefined ? {} : { abort: opts.abort }),
	});
	if (await hookStage(ws, stage("postCompile"))) {
		code = 1;
		hookFailed = true;
	}
	const ok = code === 0;
	if (!ok && !hookFailed) {
		const logText = existsSync(prepared.log)
			? (await Bun.file(prepared.log).text()).split("\n")
			: [];
		await writeFile(
			join(compileDir, "error.txt"),
			formatExcerpt({
				status: "FAIL",
				phase: "compile",
				exitCode: code,
				tool: ws.toolId,
				caseId: c.id,
				log: prepared.log,
				toolErrors: tool.compileErrors,
				details: {
					status: "FAIL",
					errorCounts: {},
					missingExpect: [],
					waived: 0,
					unclosed: false,
					unknown: [],
					lines: logText,
					kept: logText,
				},
			}),
		);
	}
	return { ok, code, log: prepared.log, hookFailed };
}

/** Wait for a tool-written log to become visible (NFS flush). */
async function waitForLog(path: string): Promise<void> {
	if (existsSync(path)) return;
	const budgetSec = Number(process.env.DTSIM_LOG_WAIT_SEC ?? "180");
	const deadline = Date.now() + budgetSec * 1000;
	while (Date.now() < deadline) {
		await Bun.sleep(500);
		if (existsSync(path)) return;
	}
}

export async function executeSim(
	ws: ResolvedWorkspace,
	c: MergedCase,
	compileDir: string,
	seedDir: string,
	seed: string,
	opts: EngineOptions,
): Promise<SeedResult> {
	const tool = getTool(ws.toolId);
	const ctx = toolContext(ws, c, "sim", seedDir, compileDir, seed, opts);
	await mkdir(seedDir, { recursive: true });
	tool.writeAux?.(ctx);
	writeGitRev(seedDir, ws.verify);
	const rules = waiveRuleMap(ws.waive);
	await writeFile(
		join(seedDir, "waive_rules"),
		`${ws.waive.map((r) => `${r.name}\t${r.pattern}`).join("\n")}\n`,
	);
	await writeFile(
		join(seedDir, "error_keywords"),
		`${c.grade.error.join("\n")}\n`,
	);
	await writeFile(
		join(seedDir, "expect_keywords"),
		`${c.grade.expect.join("\n")}\n`,
	);
	await writeFile(
		join(seedDir, "pass_keywords"),
		`${c.grade.pass.join("\n")}\n`,
	);
	const checker = join(seedDir, "check_result.js");
	await writeFile(checker, checkResultSource());
	await chmod(checker, 0o755);

	const prepared = tool.simulate(ctx);
	const env = childEnv(ws, c, "sim", seedDir, seed);
	const runSim = writeRunSim({
		dir: seedDir,
		seed,
		exports: env.env,
		argv: prepared.argv,
	});

	const base: Omit<SeedResult, "status" | "code"> = {
		caseId: c.id,
		seed,
		dir: seedDir,
		log: prepared.log,
	};
	if (opts.abort?.aborted) {
		writeResultMarker(seedDir, "ABORTED");
		return { ...base, status: "ABORTED", code: -15 };
	}

	const stage = (s: HookStage, status?: string) =>
		hookBase(ws, c, s, seedDir, prepared.log, env.env, {
			seed,
			...(status === undefined ? {} : { status }),
		});
	if (await hookStage(ws, stage("preSim"))) {
		writeResultMarker(seedDir, "FAIL");
		return { ...base, status: "FAIL", code: 1, note: "preSim hook failed" };
	}

	const task = resolveTask(ws.task);
	const argv = wrapCommand(["bash", runSim], task, {
		phase: "sim",
		jobName: `${c.id}_${seed}`,
		caseId: c.id,
		seed,
		cwd: seedDir,
		interactive: opts.interactive,
	});
	const code = await runProcess({
		argv,
		cwd: seedDir,
		env: env.env,
		...(prepared.logMode === "tee" ? { captureLog: prepared.log } : {}),
		verbose: opts.verbose,
		interactive: opts.interactive,
		...(opts.abort === undefined ? {} : { abort: opts.abort }),
	});
	if (await hookStage(ws, stage("postSim"))) {
		writeResultMarker(seedDir, "FAIL");
		return { ...base, status: "FAIL", code: 1, note: "postSim hook failed" };
	}

	await waitForLog(prepared.log);
	let details: GradeDetails | undefined;
	let status: Status;
	const graded = await runGradeHook(ws.hooks, stage("onGrade"));
	if (graded) {
		status = graded;
	} else {
		details = gradeLog(prepared.log, c.grade, rules);
		status = details.status;
	}
	if (opts.abort?.aborted) status = "ABORTED";
	writeResultMarker(seedDir, status);

	if (status !== "PASS") {
		await writeFile(
			join(seedDir, "error.txt"),
			formatExcerpt({
				status,
				phase: "sim",
				exitCode: code,
				tool: ws.toolId,
				caseId: c.id,
				seed,
				log: prepared.log,
				...(details === undefined ? {} : { details }),
				toolErrors: tool.simErrors,
			}),
		);
	}
	// onResult cannot change the result; a throw is only recorded in its log.
	await runHooks(ws.hooks, stage("onResult", status));
	return {
		...base,
		status,
		code,
		...(details === undefined ? {} : { details }),
	};
}
