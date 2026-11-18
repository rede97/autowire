// Shared execution engine for single-case and regression runs: environment
// assembly, tool invocation, hooks, grading, and per-directory artifacts.
import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CovSpec, ToolContext, WaveSpec } from "../dsl/index.ts";
import {
	applyPatches,
	expandVars,
	type MergedCase,
	type ResolvedWorkspace,
} from "./config.ts";
import { buildChildEnv, envStatsLine } from "./env.ts";
import { formatExcerpt } from "./excerpt.ts";
import { toolPath, writeFlatFilelist } from "./filelist.ts";
import {
	checkResultSource,
	type GradeDetails,
	type GradeStatus,
	gradeLog,
	waiveRuleMap,
} from "./grade.ts";
import { runHook } from "./hooks.ts";
import { resolveTask, wrapCommand } from "./launch.ts";
import { getTool } from "./registry.ts";
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
	status: GradeStatus;
	code: number;
	details?: GradeDetails;
	note?: string;
};

export function expandFor(
	ws: ResolvedWorkspace,
	caseId: string,
	dir: string,
	seed?: string,
): (text: string) => string {
	return (text) =>
		expandVars(text, {
			verify: toolPath(ws.verify),
			workspace: toolPath(ws.root),
			output_dir: toolPath(dir),
			caseId,
			...(seed === undefined ? {} : { seed }),
			tool: ws.toolId,
		});
}

/** Source filelist of a case: its own override, else the workspace one. */
export function caseFilelist(ws: ResolvedWorkspace, c: MergedCase): string {
	return c.filelist === undefined
		? ws.filelist
		: resolve(ws.verify, c.filelist);
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

async function hookStage(
	ws: ResolvedWorkspace,
	phase: "preCompile" | "postCompile" | "preSim" | "postSim",
	c: MergedCase,
	dir: string,
	seed: string | undefined,
	env: Record<string, string>,
	log: string,
): Promise<{ ok: boolean; log: string; code: number } | undefined> {
	const spec = ws.hooks[phase];
	if (!spec) return undefined;
	const outcome = await runHook(spec, {
		phase,
		caseId: c.id,
		...(seed === undefined ? {} : { seed }),
		dir,
		verify: ws.verify,
		tool: ws.toolId,
		log,
		env,
	});
	if (!outcome.ok && spec.fail === "stop") {
		await writeFile(
			join(dir, "error.txt"),
			formatExcerpt({
				status: "FAIL",
				phase: "hook",
				exitCode: outcome.code,
				tool: ws.toolId,
				caseId: c.id,
				...(seed === undefined ? {} : { seed }),
				log: outcome.log,
				hookLog: outcome.log,
			}),
		);
		return { ok: false, log: outcome.log, code: outcome.code };
	}
	return { ok: true, log: outcome.log, code: outcome.code };
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
	await applyPatches(ws, compileDir, ctx.expand);
	writeFlatFilelist(
		caseFilelist(ws, c),
		flatFilelist(compileDir),
		ws.root,
		ctx.expand,
	);
	writeGitRev(compileDir, ws.verify);
	const prepared = tool.compile(ctx);
	const env = childEnv(ws, c, "compile", compileDir);
	if (opts.verbose)
		process.stderr.write(`[dtsim] ${envStatsLine(env.stats)}\n`);

	const pre = await hookStage(
		ws,
		"preCompile",
		c,
		compileDir,
		undefined,
		env.env,
		prepared.log,
	);
	let code = 0;
	let hookFailed = false;
	if (pre && !pre.ok) {
		code = pre.code;
		hookFailed = true;
	} else {
		const task = resolveTask(ws.task);
		const argv = wrapCommand(prepared.argv, task, `compile_${c.base}`);
		code = await runProcess({
			argv,
			cwd: prepared.cwd,
			env: env.env,
			...(prepared.logMode === "tee" ? { captureLog: prepared.log } : {}),
			verbose: opts.verbose,
			interactive: false,
			...(opts.abort === undefined ? {} : { abort: opts.abort }),
		});
		const post = await hookStage(
			ws,
			"postCompile",
			c,
			compileDir,
			undefined,
			env.env,
			prepared.log,
		);
		if (post && !post.ok) {
			code = post.code;
			hookFailed = true;
		}
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

	const pre = await hookStage(
		ws,
		"preSim",
		c,
		seedDir,
		seed,
		env.env,
		prepared.log,
	);
	if (pre && !pre.ok) {
		writeResultMarker(seedDir, "FAIL");
		return {
			...base,
			status: "FAIL",
			code: pre.code,
			note: "preSim hook failed",
		};
	}

	const task = resolveTask(ws.task);
	const argv = wrapCommand(["bash", runSim], task, `${c.id}_${seed}`);
	const code = await runProcess({
		argv,
		cwd: seedDir,
		env: env.env,
		...(prepared.logMode === "tee" ? { captureLog: prepared.log } : {}),
		verbose: opts.verbose,
		interactive: opts.interactive,
		...(opts.abort === undefined ? {} : { abort: opts.abort }),
	});
	const post = await hookStage(
		ws,
		"postSim",
		c,
		seedDir,
		seed,
		env.env,
		prepared.log,
	);
	if (post && !post.ok) {
		writeResultMarker(seedDir, "FAIL");
		return {
			...base,
			status: "FAIL",
			code: post.code,
			note: "postSim hook failed",
		};
	}

	await waitForLog(prepared.log);
	let details: GradeDetails | undefined;
	let status: GradeStatus;
	const onGrade = ws.hooks.onGrade;
	if (onGrade) {
		const outcome = await runHook(onGrade, {
			phase: "onGrade",
			caseId: c.id,
			seed,
			dir: seedDir,
			verify: ws.verify,
			tool: ws.toolId,
			log: prepared.log,
			env: env.env,
		});
		const valid: readonly string[] = [
			"PASS",
			"PASS WITH ERRORS",
			"FAIL",
			"NO SIM LOG",
		];
		status = valid.includes(outcome.firstLine)
			? (outcome.firstLine as GradeStatus)
			: "FAIL";
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
	const onResult = ws.hooks.onResult;
	if (onResult) {
		await runHook(onResult, {
			phase: "onResult",
			caseId: c.id,
			seed,
			dir: seedDir,
			verify: ws.verify,
			tool: ws.toolId,
			log: prepared.log,
			status,
			env: env.env,
		});
	}
	return {
		...base,
		status,
		code,
		...(details === undefined ? {} : { details }),
	};
}
