// Regression: group cases by compile key (SimTool.compileKey), share one
// compile per group, and pipeline compile -> sim behind a shared slot pool.
// Output: a header table, the plan tree, live build trees on stderr, then
// the results tree and a summary table.
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import { covFromEnv } from "../dsl/env.ts";
import {
	compileKey,
	type MergedCase,
	mergeCase,
	type ResolvedWorkspace,
	resolveGroup,
	runsOn,
} from "./config.ts";
import {
	childEnv,
	type EngineOptions,
	executeCompile,
	executeSim,
	type SeedResult,
} from "./engine.ts";
import { type BuildNode, Progress, type TaskNode } from "./progress.ts";
import { runProcess } from "./run.ts";
import {
	elapsedLine,
	writeDresultsScript,
	writeResultMarker,
} from "./scripts.ts";
import { readSeeds, type SeedOptions, seedsFor, waveLabel } from "./single.ts";
import { block, plain, status, type TreeNode, tree } from "./ui.ts";

export type CompileGroup = {
	index: number;
	/** Readable build name (SimTool.buildName, default the first case id). */
	name: string;
	fingerprint: string;
	representative: MergedCase;
	cases: MergedCase[];
	dir: string;
};

export function regressionDir(ws: ResolvedWorkspace, label?: string): string {
	return join(ws.out, ...(label ? [label] : []), "regression");
}

/** Group members the selected tool cannot run (Case `tools`), in order. */
export function skippedCases(ws: ResolvedWorkspace, group: string): string[] {
	return resolveGroup(ws, group).filter(
		(id) => !runsOn(mergeCase(ws, id), ws.tool),
	);
}

export function planGroups(
	ws: ResolvedWorkspace,
	group: string,
	label?: string,
): CompileGroup[] {
	const members = resolveGroup(ws, group)
		.map((id) => mergeCase(ws, id))
		.filter((c) => runsOn(c, ws.tool));
	const byFp = new Map<string, MergedCase[]>();
	for (const c of members) {
		const fp = compileKey(c, ws.tool);
		const list = byFp.get(fp) ?? [];
		list.push(c);
		byFp.set(fp, list);
	}
	const sorted = [...byFp.entries()].sort((a, b) => {
		if (a[1].length !== b[1].length) return b[1].length - a[1].length;
		return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
	});
	const used = new Set<string>();
	return sorted.map(([fp, cases], i) => {
		const representative = cases[0];
		if (!representative) throw new Error("dtsim: empty compile group");
		const raw = ws.tool.buildName?.(representative) ?? representative.id;
		// A directory name: unsafe characters become "_", repeats get -2, -3.
		const base = raw.replace(/[^A-Za-z0-9_.-]/g, "_") || "build";
		let name = base;
		for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
		used.add(name);
		return {
			index: i + 1,
			name,
			fingerprint: fp,
			representative,
			cases,
			dir: join(regressionDir(ws, label), `compile_${name}`),
		};
	});
}

/** How many seeds a sim node lists before folding the rest. */
const SEEDS_SHOWN = 8;

/** A sim node's children: seeds, UVM test, sim args, env; one per line. */
function simNodes(c: MergedCase, seeds: readonly string[]): TreeNode[] {
	const dim = (s: string): TreeNode => ({ label: chalk.dim(s) });
	const env = Object.entries(c.env).map(
		([k, v]) => `${k}=${typeof v === "string" ? v : v.value}`,
	);
	return [
		...seeds.slice(0, SEEDS_SHOWN).map((s) => dim(`seed ${s}`)),
		...(seeds.length > SEEDS_SHOWN
			? [dim(`… ${seeds.length - SEEDS_SHOWN} more seeds`)]
			: []),
		...(c.uvm?.test ? [dim(`test ${c.uvm.test}`)] : []),
		...c.simArgs.map(dim),
		...env.map((e) => dim(`env ${e}`)),
	];
}

/**
 * The plan as a tree: each compile node with its defines (one per line)
 * under a `defines` node, then its sim cases, each with its seeds and sim
 * arguments. The full compile command is in `compile_<name>/run_compile`.
 */
export function planText(
	groups: readonly CompileGroup[],
	seedsOf: (c: MergedCase) => readonly string[],
	skipped: { tool: string; ids: readonly string[] } = { tool: "", ids: [] },
): string {
	const total = groups.reduce((n, g) => n + g.cases.length, 0);
	const n = groups.length;
	const lines = [
		`${chalk.bold("Plan")}: ${total} cases in ${n} compile group${n === 1 ? "" : "s"}`,
		...(skipped.ids.length
			? [
					chalk.yellow(
						`Skipped (not for ${skipped.tool}): ${skipped.ids.join(", ")}`,
					),
				]
			: []),
	];
	for (const g of groups) {
		const many = g.cases.length === 1 ? "case" : "cases";
		lines.push(
			`${chalk.bold.cyan("compile")} ${chalk.bold(g.name)}  ${chalk.dim(`(${g.cases.length} ${many})`)}`,
		);
		const defines = g.representative.defines;
		lines.push(
			...tree([
				...(defines.length
					? [
							{
								label: chalk.cyan("defines"),
								children: defines.map((d) => ({ label: chalk.dim(d) })),
							},
						]
					: []),
				...g.cases.map((c) => ({
					label: `${chalk.cyan("sim")} ${c.id}`,
					children: simNodes(c, seedsOf(c)),
				})),
			]),
		);
	}
	return lines.join("\n");
}

export type RegressionOptions = EngineOptions &
	SeedOptions & { label?: string; plain: boolean };

/** Header block: what a regression is about to run, and where. */
function headerRows(
	ws: ResolvedWorkspace,
	group: string,
	groups: readonly CompileGroup[],
	sims: number,
	regDir: string,
	opts: RegressionOptions,
): Array<[string, string]> {
	const l = ws.task.launcher;
	const queue = process.env.DTSIM_TASK_QUEUE ?? process.env.DSIM_TASK_QUEUE;
	const launcher = [
		l.summary,
		queue ? `queue ${queue} ($DTSIM_TASK_QUEUE)` : "",
	]
		.filter(Boolean)
		.join(", ");
	return [
		["Group", group],
		["Tool", ws.tool.name],
		["Wave", waveLabel(ws.tool)],
		["Launcher", launcher ? `${l.name} (${launcher})` : l.name],
		["Tasks", `${groups.length} compiles, ${sims} sims`],
		["Slots", `${ws.task.maxSlots} (compile ${ws.task.maxCompiles})`],
		["Label", opts.label ?? ""],
		["Output", regDir],
	];
}

export async function runRegression(
	ws: ResolvedWorkspace,
	group: string,
	opts: RegressionOptions,
): Promise<number> {
	const t0 = Date.now();
	const groups = planGroups(ws, group, opts.label);
	const skipped = { tool: ws.tool.name, ids: skippedCases(ws, group) };
	if (groups.length === 0) {
		throw new Error(
			`dtsim: group "${group}" has no case for ${ws.tool.name} (skipped: ${skipped.ids.join(", ")}); pick another with --tool`,
		);
	}
	const regDir = regressionDir(ws, opts.label);
	const seeds = await readSeeds(opts, ws.seeds);
	const seedsOf = (c: MergedCase) => seedsFor(c, seeds);
	const simCount = groups.reduce(
		(n, g) => n + g.cases.reduce((m, c) => m + seedsOf(c).length, 0),
		0,
	);
	await mkdir(regDir, { recursive: true });
	const plan = planText(groups, seedsOf, skipped);
	await writeFile(join(regDir, "regression.txt"), `${plain(plan)}\n`);
	console.log(
		block("Regression", headerRows(ws, group, groups, simCount, regDir, opts)),
	);
	console.log(plan);

	// One display node per compile and per (case, seed); a case with several
	// seeds names the seed, a single-seed case does not.
	const simLabel = (c: MergedCase, seed: string) =>
		seedsOf(c).length > 1 ? `${c.id} seed ${seed}` : c.id;
	const progress = new Progress(
		groups.map((g) => ({
			name: g.name,
			sims: g.cases.flatMap((c) => seedsOf(c).map((s) => simLabel(c, s))),
		})),
		opts.plain,
	);
	const results: SeedResult[] = [];
	const task = ws.task;
	const running = new Set<Promise<void>>();
	const simQueue: Array<() => void> = [];
	let nextCompile = 0;
	let activeCompiles = 0;
	let compilesFailed = 0;

	const launchSim = (
		c: MergedCase,
		compileDir: string,
		seed: string,
		node: TaskNode,
	): void => {
		const seedDir = join(regDir, c.id, seed);
		const p = (async () => {
			progress.begin(node);
			let result: SeedResult;
			try {
				result = await executeSim(ws, c, compileDir, seedDir, seed, {
					...opts,
					monitor: progress.observer(node),
				});
			} catch (error) {
				// A worker exception must fail the task, not hang the pipeline.
				writeResultMarker(seedDir, "FAIL");
				result = {
					caseId: c.id,
					seed,
					dir: seedDir,
					log: join(seedDir, "sim.log"),
					status: "FAIL",
					code: 1,
					note: error instanceof Error ? error.message : String(error),
				};
			}
			results.push(result);
			progress.finish(node, result.status, result.log);
		})().finally(() => running.delete(p));
		running.add(p);
	};

	const launchCompile = (g: CompileGroup, build: BuildNode): void => {
		nextCompile += 1;
		activeCompiles += 1;
		const p = (async () => {
			progress.begin(build);
			try {
				const outcome = await executeCompile(ws, g.representative, g.dir, {
					...opts,
					monitor: progress.observer(build),
				});
				if (!outcome.ok) compilesFailed += 1;
				progress.finish(build, outcome.ok ? "OK" : "FAIL", outcome.log);
				const nodes = [...build.sims];
				for (const c of g.cases) {
					for (const seed of seedsOf(c)) {
						const node = nodes.shift() as TaskNode;
						if (!outcome.ok) {
							const seedDir = join(regDir, c.id, seed);
							await mkdir(seedDir, { recursive: true });
							writeResultMarker(seedDir, "FAIL");
							results.push({
								caseId: c.id,
								seed,
								dir: seedDir,
								log: outcome.log,
								status: "FAIL",
								code: outcome.code,
								note: "skipped: compile failed",
							});
							progress.finish(
								node,
								"FAIL",
								undefined,
								"skipped: compile failed",
							);
						} else {
							simQueue.push(() => launchSim(c, g.dir, seed, node));
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
				const build = progress.builds[nextCompile];
				if (g && build) launchCompile(g, build);
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

	return finishRegression(ws, groups, regDir, results, opts, {
		t0,
		compilesFailed,
	});
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
	run: { t0: number; compilesFailed: number },
): Promise<number> {
	const text = resultTree(results);
	console.log(text);
	await writeFile(join(regDir, "result.txt"), `${plain(text)}\n`);
	const dresults = writeDresultsScript(regDir);

	const counts = new Map<string, number>();
	for (const r of results) {
		counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
	}
	// Failures first (FAIL always, even at 0), then the passing counts.
	const sims = [
		["FAIL", counts.get("FAIL") ?? 0] as const,
		...[...counts.entries()]
			.filter(([s]) => !["FAIL", "PASS WITH ERRORS", "PASS"].includes(s))
			.sort(),
		...(counts.has("PASS WITH ERRORS")
			? [["PASS WITH ERRORS", counts.get("PASS WITH ERRORS") ?? 0] as const]
			: []),
		["PASS", counts.get("PASS") ?? 0] as const,
	];
	const ok = groups.length - run.compilesFailed;
	// A zero count is grey: nothing to look at.
	const count = (s: string, n: number) =>
		n === 0 ? chalk.gray(`${s} ${n}`) : `${status(s)} ${n}`;
	console.log(
		block("Summary", [
			["Compiles", `${count("FAIL", run.compilesFailed)}  ${count("OK", ok)}`],
			["Sims", sims.map(([s, n]) => count(s, n)).join("  ")],
			["Total", `${results.length} sims`],
			["Elapsed", elapsedLine(run.t0).replace(/^elapsed /, "")],
			["Results", join(regDir, "result.txt")],
			["Recheck", `${dresults} [--recheck]`],
		]),
	);

	let covOk = true;
	const cov = covFromEnv();
	if (cov.enabled) {
		if (cov.merge) {
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
			'#!/bin/bash\n# Cross-group coverage merge. Different +define configs must not\n# be merged automatically; run this explicitly.\nurg -dir compile_*/simv.vdb -dbname merge.vdb -report urgReport "$@"\n',
		);
		await chmod(dcov, 0o755);
	}

	return covOk &&
		results.every((r) => r.status === "PASS" || r.status === "PASS WITH ERRORS")
		? 0
		: 1;
}
