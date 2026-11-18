// Regression: group cases by compile fingerprint, share one compile per
// group, and pipeline compile -> sim behind a shared slot pool.
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	compileFingerprint,
	type MergedCase,
	mergeCase,
	type ResolvedWorkspace,
	resolveGroup,
} from "./config.ts";
import {
	childEnv,
	type EngineOptions,
	executeCompile,
	executeSim,
	type SeedResult,
} from "./engine.ts";
import { resolveTask } from "./launch.ts";
import { Progress } from "./progress.ts";
import { runProcess } from "./run.ts";
import {
	timingLines,
	writeDresultsScript,
	writeResultMarker,
} from "./scripts.ts";
import { readSeeds, type SeedOptions, seedsFor } from "./single.ts";

export type CompileGroup = {
	index: number;
	fingerprint: string;
	representative: MergedCase;
	cases: MergedCase[];
	dir: string;
};

export function regressionDir(ws: ResolvedWorkspace, label?: string): string {
	return join(ws.out, ...(label ? [label] : []), "regression");
}

export function planGroups(
	ws: ResolvedWorkspace,
	group: string,
	label?: string,
): CompileGroup[] {
	const members = resolveGroup(ws, group).map((id) => mergeCase(ws, id));
	const byFp = new Map<string, MergedCase[]>();
	for (const c of members) {
		const fp = compileFingerprint(c, ws.toolId);
		const list = byFp.get(fp) ?? [];
		list.push(c);
		byFp.set(fp, list);
	}
	const sorted = [...byFp.entries()].sort((a, b) => {
		if (a[1].length !== b[1].length) return b[1].length - a[1].length;
		return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
	});
	return sorted.map(([fp, cases], i) => {
		const representative = cases[0];
		if (!representative) throw new Error("dtsim: empty compile group");
		return {
			index: i + 1,
			fingerprint: fp,
			representative,
			cases,
			dir: join(regressionDir(ws, label), `compile_g${i + 1}`),
		};
	});
}

export function planText(groups: readonly CompileGroup[]): string {
	const total = groups.reduce((n, g) => n + g.cases.length, 0);
	const lines = [
		"========== Regression Plan ==========",
		`Total cases    : ${total}`,
		`Compile groups : ${groups.length}`,
	];
	for (const g of groups) {
		lines.push(`Group ${g.index} (${g.cases.length} cases)`);
		const rep = g.representative;
		if (rep.defines.length > 0)
			lines.push(`  defines: ${rep.defines.join(" ")}`);
		if (rep.compileArgs.length > 0) {
			lines.push(`  compileArgs: ${rep.compileArgs.join(" ")}`);
		}
		const envKeys = Object.keys(rep.env);
		if (envKeys.length > 0) lines.push(`  env: ${envKeys.join(", ")}`);
		for (const c of g.cases) {
			lines.push(`  ${c.id}${c.random ? "" : " (no-random)"}`);
		}
	}
	return lines.join("\n");
}

export type RegressionOptions = EngineOptions &
	SeedOptions & { label?: string; plain: boolean };

export async function runRegression(
	ws: ResolvedWorkspace,
	group: string,
	opts: RegressionOptions,
): Promise<number> {
	const t0 = Date.now();
	const groups = planGroups(ws, group, opts.label);
	const regDir = regressionDir(ws, opts.label);
	await mkdir(regDir, { recursive: true });
	await writeFile(join(regDir, "regression.txt"), `${planText(groups)}\n`);
	console.log(planText(groups));

	const seeds = await readSeeds(opts);
	const simCount = groups.reduce(
		(n, g) => n + g.cases.reduce((m, c) => m + seedsFor(c, seeds).length, 0),
		0,
	);
	const progress = new Progress(opts.plain);
	progress.plan(groups.length, simCount);
	const results: SeedResult[] = [];
	const task = resolveTask(ws.task);
	const running = new Set<Promise<void>>();
	const simQueue: Array<() => void> = [];
	let nextCompile = 0;
	let activeCompiles = 0;

	const record = (result: SeedResult): void => {
		results.push(result);
		progress.done(
			"sim",
			`${result.caseId}/${result.seed}`,
			result.status,
			result.log,
		);
	};

	const launchSim = (c: MergedCase, compileDir: string, seed: string): void => {
		const seedDir = join(regDir, c.id, seed);
		const p = (async () => {
			progress.start("sim", `${c.id}/${seed}`, join(seedDir, "sim.log"));
			try {
				record(await executeSim(ws, c, compileDir, seedDir, seed, opts));
			} catch (error) {
				// A worker exception must fail the task, not hang the pipeline.
				writeResultMarker(seedDir, "FAIL");
				record({
					caseId: c.id,
					seed,
					dir: seedDir,
					log: join(seedDir, "sim.log"),
					status: "FAIL",
					code: 1,
					note: error instanceof Error ? error.message : String(error),
				});
			}
		})().finally(() => running.delete(p));
		running.add(p);
	};

	const launchCompile = (g: CompileGroup): void => {
		nextCompile += 1;
		activeCompiles += 1;
		const p = (async () => {
			progress.start("compile", `g${g.index}`, join(g.dir, "vcs.log"));
			try {
				const outcome = await executeCompile(ws, g.representative, g.dir, opts);
				progress.done(
					"compile",
					`g${g.index}`,
					outcome.ok ? "OK" : "FAIL",
					outcome.log,
				);
				for (const c of g.cases) {
					for (const seed of seedsFor(c, seeds)) {
						if (!outcome.ok) {
							const seedDir = join(regDir, c.id, seed);
							await mkdir(seedDir, { recursive: true });
							writeResultMarker(seedDir, "FAIL");
							record({
								caseId: c.id,
								seed,
								dir: seedDir,
								log: outcome.log,
								status: "FAIL",
								code: outcome.code,
								note: "skipped: compile failed",
							});
						} else {
							simQueue.push(() => launchSim(c, g.dir, seed));
						}
					}
				}
			} finally {
				activeCompiles -= 1;
			}
		})().finally(() => running.delete(p));
		running.add(p);
	};

	while (
		nextCompile < groups.length ||
		running.size > 0 ||
		simQueue.length > 0
	) {
		while (running.size < task.maxSlots && !opts.abort?.aborted) {
			if (nextCompile < groups.length && activeCompiles < task.maxCompiles) {
				const g = groups[nextCompile];
				if (g) launchCompile(g);
				continue;
			}
			const job = simQueue.shift();
			if (job) {
				job();
				continue;
			}
			break;
		}
		if (opts.abort?.aborted) {
			for (const job of simQueue.splice(0)) job();
			break;
		}
		if (running.size === 0) break;
		await Promise.race(running);
	}
	await Promise.all([...running]);
	progress.stop();

	const exitCode = await finishRegression(ws, groups, regDir, results, opts);
	for (const line of timingLines(t0)) console.log(`[dtsim] ${line}`);
	return exitCode;
}

export function resultTree(results: readonly SeedResult[]): string {
	const lines = ["========== Results =========="];
	const byCase = new Map<string, SeedResult[]>();
	for (const r of results) {
		const list = byCase.get(r.caseId) ?? [];
		list.push(r);
		byCase.set(r.caseId, list);
	}
	for (const [caseId, list] of [...byCase.entries()].sort()) {
		lines.push(caseId);
		for (const r of list.sort((a, b) => a.seed.localeCompare(b.seed))) {
			lines.push(`  ${r.seed}: ${r.status}${r.note ? ` (${r.note})` : ""}`);
		}
	}
	const counts = new Map<string, number>();
	for (const r of results)
		counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
	for (const [status, n] of [...counts.entries()].sort()) {
		lines.push(`${status}: ${n}`);
	}
	return lines.join("\n");
}

async function finishRegression(
	ws: ResolvedWorkspace,
	groups: readonly CompileGroup[],
	regDir: string,
	results: readonly SeedResult[],
	opts: RegressionOptions,
): Promise<number> {
	const tree = resultTree(results);
	console.log(tree);
	await writeFile(join(regDir, "result.txt"), `${tree}\n`);
	writeDresultsScript(regDir);

	let covOk = true;
	if (opts.cov.enabled) {
		if (opts.cov.merge) {
			for (const g of groups) {
				const env = childEnv(ws, g.representative, "compile", g.dir);
				const code = await runProcess({
					argv: [
						"urg",
						"-dir",
						join(g.dir, "simv.vdb"),
						"-dbname",
						join(g.dir, "merge.vdb"),
						"-report",
						join(g.dir, "urgReport"),
					],
					cwd: g.dir,
					env: env.env,
					captureLog: join(g.dir, "urg.log"),
					verbose: opts.verbose,
					interactive: false,
				});
				if (code !== 0) covOk = false;
			}
		}
		const dcov = join(regDir, "dcov");
		await writeFile(
			dcov,
			'#!/bin/bash\n# Cross-group coverage merge. Different +define configs must not\n# be merged automatically; run this explicitly.\nurg -dir compile_g*/simv.vdb -dbname merge.vdb -report urgReport "$@"\n',
		);
		await chmod(dcov, 0o755);
	}

	return covOk &&
		results.every((r) => r.status === "PASS" || r.status === "PASS WITH ERRORS")
		? 0
		: 1;
}
