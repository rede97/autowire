// Shared execution engine for single-case and regression runs: environment
// assembly, tool invocation, hooks, grading, and per-directory artifacts.
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RUN_ENV } from "../dsl/env.ts";
import type {
	CaseContext,
	HookStage,
	Status,
	ToolContext,
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
import { type Graded, runGrader } from "./grade.ts";
import { type HookBase, runHooks } from "./hooks.ts";
import { wrapCommand } from "./launch.ts";
import { runProcess } from "./run.ts";
import {
	writeGitRev,
	writeResultMarker,
	writeRunCompile,
	writeRunSim,
	writeSubmitScript,
} from "./scripts.ts";

/** Steps of one case, reported to EngineOptions.monitor. */
export type CasePhase =
	| "preCompile"
	| "compile"
	| "postCompile"
	| "preSim"
	| "sim"
	| "postSim"
	| "grade"
	| "onResult";

/** Live display hook. Every step starts (hook steps only when that stage
 *  has hooks); compile and sim carry their log and submitted command.
 *  Compile, sim, grade and failed hooks also end with a result ("OK",
 *  "FAIL", "exit 3", or the seed status). */
export type PhaseObserver = {
	start(
		phase: CasePhase,
		info: { log?: string; seed?: string; cmd?: readonly string[] },
	): void;
	end(phase: CasePhase, result: string): void;
};

/** Report a hook step only when the workspace has hooks for it. */
function hookStep(
	ws: ResolvedWorkspace,
	opts: EngineOptions,
	stage: HookStage,
	seed?: string,
): void {
	if (ws.hooks[stage] === undefined) return;
	opts.monitor?.start(stage, seed === undefined ? {} : { seed });
}

export type EngineOptions = {
	verbose: boolean;
	interactive: boolean;
	/** true only for `regr`: shared compile dirs, absolute paths in run_sim. */
	regression: boolean;
	abort?: AbortSignal;
	monitor?: PhaseObserver;
};

export type SeedResult = {
	caseId: string;
	seed: string;
	dir: string;
	log: string;
	status: Status;
	code: number;
	/** Grader report rows (run summary, error.txt). */
	details?: ReadonlyArray<readonly [string, string]>;
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
		tool: ws.tool.name,
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

/** Windows tools and the generated bash scripts all accept forward slashes. */
export function toolPath(path: string): string {
	return process.platform === "win32" ? path.replaceAll("\\", "/") : path;
}

/** A case's filelists, absolute: the workspace's, then the case's in merge
 *  order. dtsim never reads them; the tool gets each as -f. */
export function caseFilelists(
	ws: ResolvedWorkspace,
	c: MergedCase,
	dir: string,
): string[] {
	const vars = varsFor(ws, c.id, dir);
	return [...ws.filelists, ...c.filelists.map((f) => resolvePath(f, vars))].map(
		toolPath,
	);
}

export function toolContext(
	ws: ResolvedWorkspace,
	c: MergedCase,
	phase: "compile" | "sim",
	dir: string,
	compileDir: string,
	seed: string | undefined,
	opts: EngineOptions,
	env: Record<string, string>,
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
			toolOptions: { ...c.toolOptions },
		},
		dir,
		compileDir,
		...(seed === undefined ? {} : { seed }),
		verify: ws.verify,
		workspace: ws.root,
		filelists: caseFilelists(ws, c, compileDir),
		regression: opts.regression,
		interactive: opts.interactive,
		env,
		expand: expandFor(ws, c.id, dir, seed),
		resolvePath: (text) => resolvePath(text, varsFor(ws, c.id, dir, seed)),
		submitScript: (scriptName) => {
			const launcher = ws.task.launcher;
			if (!launcher.scriptPrefix) return;
			const argv = wrapCommand(
				["bash", toolPath(resolve(dir, scriptName))],
				launcher,
				{
					phase,
					jobName: phase === "sim" ? `${c.id}_${seed}` : `compile_${c.base}`,
					caseId: c.id,
					...(seed === undefined ? {} : { seed }),
					cwd: dir,
					interactive: phase === "sim" ? opts.interactive : false,
				},
			);
			writeSubmitScript(
				dir,
				`${launcher.scriptPrefix}_${scriptName.replace(/^run_/, "")}`,
				argv,
			);
		},
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
		tool: ws.tool,
		launcherPassthrough: ws.task.launcher.passthrough,
		passthrough: ws.passthrough,
		deny: ws.deny,
		caseEnv: c.env,
		injected: {
			WORKSPACE: ws.root,
			workspace: ws.root,
			project_home: ws.root,
			verify: ws.verify,
			output_dir: dir,
			// Run switches as the backend read them.
			...runSwitches(),
			DTSIM_CASE: c.id,
			DTSIM_PHASE: phase,
			...(seed === undefined ? {} : { DTSIM_SEED: seed }),
		},
		expand: expandFor(ws, c.id, dir, seed),
	});
}

function runSwitches(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of RUN_ENV) {
		const v = process.env[name];
		if (v !== undefined) out[name] = v;
	}
	return out;
}

/** Fields hooks and graders share for one case directory (no `sh`). */
function caseContext(
	ws: ResolvedWorkspace,
	c: MergedCase,
	dir: string,
	log: string,
	env: Record<string, string>,
	seed?: string,
): Omit<CaseContext, "sh"> {
	const vars = varsFor(ws, c.id, dir, seed);
	return {
		caseId: c.id,
		baseId: c.base,
		dir,
		log,
		verify: ws.verify,
		workspace: ws.root,
		tool: ws.tool.name,
		caseOpts: {
			defines: c.defines,
			compileArgs: c.compileArgs,
			simArgs: c.simArgs,
			env: c.env,
			...(c.uvm === undefined ? {} : { uvm: c.uvm }),
			toolOptions: { ...c.toolOptions },
			filelists: [...c.filelists],
		},
		env,
		expand: (text) => expandVars(text, vars),
		resolvePath: (text) => resolvePath(text, vars),
	};
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
	return { ...caseContext(ws, c, dir, log, env, extra.seed), stage, ...extra };
}

/** Grade one seed directory with the case's grader (run and --recheck). */
export function gradeSeed(
	ws: ResolvedWorkspace,
	c: MergedCase,
	dir: string,
	log: string,
	seed: string,
): Promise<Graded> {
	const env = childEnv(ws, c, "sim", dir, seed).env;
	return runGrader(c.grader, {
		...caseContext(ws, c, dir, log, env, seed),
		seed,
	});
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
		await formatExcerpt({
			status: "FAIL",
			phase: "hook",
			tool: ws.tool.name,
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
	const tool = ws.tool;
	const env = childEnv(ws, c, "compile", compileDir);
	const ctx = toolContext(
		ws,
		c,
		"compile",
		compileDir,
		compileDir,
		undefined,
		opts,
		env.env,
	);
	await mkdir(compileDir, { recursive: true });
	tool.writeAux?.(ctx);
	if (opts.verbose) process.stderr.write(`${envStatsLine(env.stats)}\n`);
	// Preparing argv is pure; it gives preCompile the compile log path.
	const prepared = tool.compile(ctx);
	const stage = (s: HookStage) =>
		hookBase(ws, c, s, compileDir, prepared.log, env.env);
	// preCompile may generate sources or the filelists themselves; then each
	// listed filelist must exist. Their contents are the tool's to read.
	hookStep(ws, opts, "preCompile");
	const pre = await hookStage(ws, stage("preCompile"));
	if (pre) {
		opts.monitor?.end("preCompile", "FAIL");
		return { ok: false, code: 1, log: pre.log, hookFailed: true };
	}
	for (const f of ctx.filelists) {
		if (!existsSync(f)) {
			throw new Error(`dtsim: ${c.id}: filelist not found: ${f}`);
		}
	}
	writeGitRev(compileDir, ws.verify);

	let hookFailed = false;
	const argv = wrapCommand(prepared.argv, ws.task.launcher, {
		phase: "compile",
		jobName: `compile_${c.base}`,
		caseId: c.id,
		cwd: prepared.cwd,
		interactive: false,
	});
	// A record of the command; dtsim still runs it itself below.
	writeRunCompile({
		dir: compileDir,
		cwd: prepared.cwd,
		exports: env.env,
		argv: prepared.argv,
		submitted: argv,
	});
	ctx.submitScript("run_compile");
	opts.monitor?.start("compile", { log: prepared.log, cmd: argv });
	let code = await runProcess({
		argv,
		cwd: prepared.cwd,
		env: env.env,
		...(prepared.logMode === "tee" ? { captureLog: prepared.log } : {}),
		verbose: opts.verbose,
		interactive: false,
		...(opts.abort === undefined ? {} : { abort: opts.abort }),
	});
	opts.monitor?.end("compile", code === 0 ? "OK" : "FAIL");
	hookStep(ws, opts, "postCompile");
	if (await hookStage(ws, stage("postCompile"))) {
		opts.monitor?.end("postCompile", "FAIL");
		code = 1;
		hookFailed = true;
	}
	const ok = code === 0;
	if (!ok && !hookFailed) {
		await writeFile(
			join(compileDir, "error.txt"),
			await formatExcerpt({
				status: "FAIL",
				phase: "compile",
				exitCode: code,
				tool: ws.tool.name,
				caseId: c.id,
				log: prepared.log,
				toolErrors: tool.compileErrors,
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
	const tool = ws.tool;
	const env = childEnv(ws, c, "sim", seedDir, seed);
	const ctx = toolContext(
		ws,
		c,
		"sim",
		seedDir,
		compileDir,
		seed,
		opts,
		env.env,
	);
	await mkdir(seedDir, { recursive: true });
	tool.writeAux?.(ctx);
	writeGitRev(seedDir, ws.verify);

	const prepared = tool.simulate(ctx);
	const runSim = writeRunSim({
		dir: seedDir,
		seed,
		exports: env.env,
		argv: prepared.argv,
	});
	ctx.submitScript("run_sim");

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
	hookStep(ws, opts, "preSim", seed);
	if (await hookStage(ws, stage("preSim"))) {
		opts.monitor?.end("preSim", "FAIL");
		writeResultMarker(seedDir, "FAIL");
		return { ...base, status: "FAIL", code: 1, note: "preSim hook failed" };
	}

	const argv = wrapCommand(["bash", runSim], ws.task.launcher, {
		phase: "sim",
		jobName: `${c.id}_${seed}`,
		caseId: c.id,
		seed,
		cwd: seedDir,
		interactive: opts.interactive,
	});
	opts.monitor?.start("sim", { log: prepared.log, seed, cmd: argv });
	const code = await runProcess({
		argv,
		cwd: seedDir,
		env: env.env,
		...(prepared.logMode === "tee" ? { captureLog: prepared.log } : {}),
		verbose: opts.verbose,
		interactive: opts.interactive,
		...(opts.abort === undefined ? {} : { abort: opts.abort }),
	});
	opts.monitor?.end("sim", code === 0 ? "OK" : `exit ${code}`);
	hookStep(ws, opts, "postSim", seed);
	if (await hookStage(ws, stage("postSim"))) {
		opts.monitor?.end("postSim", "FAIL");
		writeResultMarker(seedDir, "FAIL");
		return { ...base, status: "FAIL", code: 1, note: "postSim hook failed" };
	}

	opts.monitor?.start("grade", { seed });
	await waitForLog(prepared.log);
	const graded = await gradeSeed(ws, c, seedDir, prepared.log, seed);
	opts.monitor?.end("grade", graded.status);
	let status: Status = graded.status;
	if (opts.abort?.aborted) status = "ABORTED";
	writeResultMarker(seedDir, status);

	if (status !== "PASS") {
		await writeFile(
			join(seedDir, "error.txt"),
			await formatExcerpt({
				status,
				phase: "sim",
				exitCode: code,
				tool: ws.tool.name,
				caseId: c.id,
				seed,
				log: prepared.log,
				...(graded.details === undefined ? {} : { details: graded.details }),
				...(graded.highlight === undefined
					? {}
					: { highlight: graded.highlight }),
				toolErrors: tool.simErrors,
			}),
		);
	}
	// onResult cannot change the result; a throw is only recorded in its log.
	hookStep(ws, opts, "onResult", seed);
	await runHooks(ws.hooks, stage("onResult", status));
	return {
		...base,
		status,
		code,
		...(graded.note === undefined ? {} : { note: graded.note }),
		...(graded.details === undefined ? {} : { details: graded.details }),
	};
}
