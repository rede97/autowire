// Single-case orchestration: compile once into dt/simout/<case>/, then run each
// seed in its own subdirectory. Quiet by default; failures leave error.txt.
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import type { CovSpec, SimTool, WaveSpec } from "../dsl/index.ts";
import {
	assertConcrete,
	assertRunsOn,
	type MergedCase,
	mergeCase,
	type ResolvedWorkspace,
} from "./config.ts";
import {
	childEnv,
	type EngineOptions,
	executeCompile,
	executeSim,
	type SeedResult,
	toolContext,
	writeCovMerge,
} from "./engine.ts";
import { envStatsLine } from "./env.ts";
import { CaseMonitor } from "./monitor.ts";
import { elapsedLine, fmtElapsed } from "./scripts.ts";
import { block, pathBlock, status, table } from "./ui.ts";

export function readSeeds(defaults: readonly string[]): string[] {
	if (defaults.length === 0) throw new Error("dtsim: no seeds");
	return [...defaults];
}

export function randomSeed(): string {
	return String(Math.floor(Math.random() * 2 ** 31));
}

export function seedsFor(c: MergedCase, seeds: readonly string[]): string[] {
	const first = seeds[0];
	if (first === undefined) throw new Error("dtsim: no seeds");
	return c.random ? [...seeds] : [first];
}

export function caseOutputDir(
	ws: ResolvedWorkspace,
	caseId: string,
	label?: string,
): string {
	return join(ws.out, ...(label ? [label] : []), caseId);
}

function printBlock(
	title: string,
	rows: ReadonlyArray<readonly [string, string]>,
): void {
	console.log(block(title, rows));
}

export type SingleOptions = EngineOptions & {
	label?: string;
	compileOnly: boolean;
	simOnly: boolean;
	/** No live panel: one line per step (also when stderr is no TTY). */
	plain: boolean;
};

export async function runSingle(
	ws: ResolvedWorkspace,
	caseId: string,
	opts: SingleOptions,
): Promise<number> {
	const t0 = Date.now();
	if (opts.compileOnly && opts.simOnly) {
		throw new Error(
			"dtsim: --compile-only and --sim-only are mutually exclusive",
		);
	}
	const c = mergeCase(ws, caseId);
	assertConcrete(c);
	assertRunsOn(c, ws.tool);
	const seeds = seedsFor(c, readSeeds(ws.seeds));
	const compileDir = caseOutputDir(ws, c.id, opts.label);
	const tool = ws.tool;
	// -v on a TTY prints the child's output above the live panel (the panel
	// reads it from the child, not the log); -v elsewhere streams the child
	// directly. --interactive owns the terminal.
	const tty = !opts.plain && Boolean(process.stderr.isTTY);
	const follow = opts.verbose && tty;
	const monitor =
		opts.interactive || (opts.verbose && !tty)
			? undefined
			: new CaseMonitor(opts.plain, follow, ws.liveLines);
	const engine: EngineOptions = monitor
		? { ...opts, verbose: opts.verbose && !follow, monitor }
		: opts;

	printBlock("Run", [
		["WORKSPACE", ws.root],
		["Verify", ws.verify],
		["Tool", tool.name],
		["Top", c.top],
		["Wave", waveLabel(c.wave)],
		["Coverage", covLabel(c.cov, ws.tool)],
		["Test Name", c.id],
		["Test Seq", c.uvm?.seq ?? ""],
		["Seeds", seeds.join(",") + (c.random ? "" : " (no-random)")],
		["Defines", c.defines.join(" ")],
		["Compile args", c.compileArgs.join(" ")],
		["Sim args", c.simArgs.join(" ")],
		["Env", Object.keys(c.env).join(" ")],
		["Output", compileDir],
	]);

	if (!opts.simOnly) {
		await rm(compileDir, { recursive: true, force: true });
		const outcome = await executeCompile(ws, c, compileDir, engine);
		monitor?.stop();
		if (!outcome.ok) {
			printBlock("Summary", [
				["Test", c.id],
				["Result", status("FAIL")],
				["Phase", "compile"],
				["Log", outcome.log],
				["Error", join(compileDir, "error.txt")],
			]);
			console.log(chalk.dim(elapsedLine(t0)));
			return 1;
		}
		if (opts.compileOnly) {
			printBlock("Summary", [
				["Test", c.id],
				["Result", status("COMPILE ONLY")],
				["Log", outcome.log],
			]);
			console.log(chalk.dim(elapsedLine(t0)));
			return 0;
		}
	} else {
		const ctx = toolContext(
			ws,
			c,
			"compile",
			compileDir,
			compileDir,
			undefined,
			opts,
			childEnv(ws, c, "compile", compileDir).env,
		);
		const exe = tool.compile(ctx).executable;
		if (exe && !existsSync(exe)) {
			throw new Error(`dtsim: --sim-only needs an existing build at ${exe}`);
		}
	}

	let worst = 0;
	for (const seed of seeds) {
		const seedDir = join(compileDir, seed);
		const started = Date.now();
		const result: SeedResult = await executeSim(
			ws,
			c,
			compileDir,
			seedDir,
			seed,
			engine,
		);
		monitor?.stop();
		const rows: Array<[string, string]> = [
			["Test", c.id],
			["Seq", c.uvm?.seq ?? ""],
			["Seed", seed],
			[
				"Result",
				status(result.status) + (result.note ? ` (${result.note})` : ""),
			],
			["Output", seedDir],
			["Log", `${result.log} (${Bun.file(result.log).size} bytes)`],
			["Elapsed", fmtElapsed((Date.now() - started) / 1000)],
		];
		for (const [label, value] of result.details ?? [])
			rows.push([label, value]);
		if (result.status !== "PASS") {
			rows.push(["Error", join(seedDir, "error.txt")]);
		}
		printBlock("Summary", rows);
		if (result.status !== "PASS" && result.status !== "PASS WITH ERRORS") {
			worst = 1;
		}
	}
	const cov = writeCovMerge(ws, c, compileDir, [c.id], `cov_merge_${c.id}`);
	if (cov) {
		console.log(
			pathBlock("Coverage (not merged by dtsim; run the scripts by hand)", [
				["Database", cov.db],
				["Merge", cov.merge],
				["View", `${cov.view} (${cov.merged} once merged)`],
			]),
		);
	}
	console.log(chalk.dim(elapsedLine(t0)));
	return worst;
}

/** `dtsim env`: show what would reach the child, without running anything. */
export function printCaseEnv(
	ws: ResolvedWorkspace,
	caseId: string,
	phase: "compile" | "sim",
	showValues: boolean,
): void {
	const c = mergeCase(ws, caseId);
	assertConcrete(c);
	assertRunsOn(c, ws.tool);
	const dir = caseOutputDir(ws, c.id);
	const built = childEnv(ws, c, phase, dir, phase === "sim" ? "0" : undefined);
	console.log(chalk.dim(envStatsLine(built.stats)));
	const rows = [...built.sources.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([key, source]) =>
			showValues ? [source, key, built.env[key] ?? ""] : [source, key],
		);
	console.log(
		table(rows, showValues ? ["Source", "Name", "Value"] : ["Source", "Name"]),
	);
}

/** "off", or "on (depth N, scope S)". */
export function waveLabel(w: WaveSpec): string {
	if (!w.enabled) return "off";
	return `on (depth ${w.depth}, scope ${w.scope})`;
}

/** "off", "on (<metrics>)", or why a requested coverage is not collected. */
export function covLabel(cov: CovSpec, tool: SimTool): string {
	if (!cov.enabled) return "off";
	if (!tool.coverage) return `off (${tool.name} collects no coverage)`;
	return `on (${cov.metrics})`;
}
