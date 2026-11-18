// Regression: group cases by compile key (SimTool.compileKey), share one
// compile per group, and pipeline compile -> sim behind a shared slot pool.
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import {
	compileKey,
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
	elapsedLine,
	writeDresultsScript,
	writeResultMarker,
} from "./scripts.ts";
import { readSeeds, type SeedOptions, seedsFor } from "./single.ts";
import { plain, status, table, tree } from "./ui.ts";

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
		const fp = compileKey(c, ws.toolId);
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

/** Plan header plus one table row per compile group. */
export function planText(groups: readonly CompileGroup[]): string {
	const total = groups.reduce((n, g) => n + g.cases.length, 0);
	const rows = groups.map((g) => {
		const rep = g.representative;
		return [
			`g${g.index}`,
			g.cases
				.map((c) => `${c.id}${c.random ? "" : chalk.dim(" (no-random)")}`)
				.join("\n"),
			rep.defines.join(" "),
			rep.compileArgs.join(" "),
			Object.keys(rep.env).join(" "),
		];
	});
	const n = groups.length;
	return `${chalk.bold("Regression plan")}: ${total} cases in ${n} compile group${n === 1 ? "" : "s"}\n${table(
		rows,
		["Group", "Cases", "Defines", "Compile args", "Env"],
		60,
	)}`;
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
	await writeFile(
		join(regDir, "regression.txt"),
		`${plain(planText(groups))}\n`,
	);
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
	console.log(chalk.dim(elapsedLine(t0)));
	return exitCode;
}

/** Results as a case → seed tree, then one count per status. */
export function resultTree(results: readonly SeedResult[]): string {
	const byCase = new Map<string, SeedResult[]>();
	for (const r of results) {
		const list = byCase.get(r.caseId) ?? [];
		list.push(r);
		byCase.set(r.caseId, list);
	}
	const width = Math.max(0, ...results.map((r) => r.seed.length));
	const nodes = [...byCase.entries()].sort().map(([caseId, list]) => ({
		label: caseId,
		children: list
			.sort((a, b) => a.seed.localeCompare(b.seed))
			.map((r) => ({
				label: `${r.seed.padEnd(width)}  ${status(r.status)}${r.note ? chalk.dim(` (${r.note})`) : ""}`,
			})),
	}));
	const counts = new Map<string, number>();
	for (const r of results)
		counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
	const summary = [...counts.entries()]
		.sort()
		.map(([s, n]) => `${status(s)} ${n}`)
		.join("  ");
	return [chalk.bold("Results"), ...tree(nodes), summary].join("\n");
}

async function finishRegression(
	ws: ResolvedWorkspace,
	groups: readonly CompileGroup[],
	regDir: string,
	results: readonly SeedResult[],
	opts: RegressionOptions,
): Promise<number> {
	const text = resultTree(results);
	console.log(text);
	await writeFile(join(regDir, "result.txt"), `${plain(text)}\n`);
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
