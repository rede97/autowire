// Single-case orchestration: compile once into dt/simout/<case>/, then run each
// seed in its own subdirectory. Quiet by default; failures leave error.txt.
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
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
} from "./engine.ts";
import { envStatsLine } from "./env.ts";
import { getTool } from "./registry.ts";
import { fmtElapsed, timingLines } from "./scripts.ts";

export type SeedOptions = {
	seed?: string;
	seedFile?: string;
	numSeeds?: number;
};

export async function readSeeds(opts: SeedOptions): Promise<string[]> {
	if (opts.seedFile !== undefined && opts.numSeeds !== undefined) {
		throw new Error(
			"dtsim: --seed-file and --num-seeds are mutually exclusive",
		);
	}
	if (opts.seedFile !== undefined) {
		const text = await readFile(opts.seedFile, "utf8");
		const seeds = text
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
		if (seeds.length === 0) throw new Error("dtsim: empty seed file");
		return seeds;
	}
	if (opts.numSeeds !== undefined) {
		if (!Number.isInteger(opts.numSeeds) || opts.numSeeds < 1) {
			throw new Error("dtsim: --num-seeds must be a positive integer");
		}
		return Array.from({ length: opts.numSeeds }, () => randomSeed());
	}
	return [opts.seed ?? randomSeed()];
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

function printBlock(title: string, rows: Array<[string, string]>): void {
	console.log(`[dtsim] ========== ${title} ==========`);
	for (const [label, value] of rows) {
		console.log(`[dtsim] ${label.padEnd(12)}: ${value}`);
	}
}

export type SingleOptions = EngineOptions &
	SeedOptions & {
		label?: string;
		compileOnly: boolean;
		simOnly: boolean;
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
	const seeds = seedsFor(c, await readSeeds(opts));
	const compileDir = caseOutputDir(ws, c.id, opts.label);
	const tool = getTool(ws.toolId);

	printBlock("Run", [
		["WORKSPACE", ws.root],
		["Verify", ws.verify],
		["Tool", ws.toolId],
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
		const outcome = await executeCompile(ws, c, compileDir, opts);
		if (!outcome.ok) {
			printBlock("Summary", [
				["Test", c.id],
				["Result", "FAIL"],
				["Phase", "compile"],
				["Log", outcome.log],
				["Error", join(compileDir, "error.txt")],
			]);
			for (const line of timingLines(t0)) console.log(`[dtsim] ${line}`);
			return 1;
		}
		if (opts.compileOnly) {
			printBlock("Summary", [
				["Test", c.id],
				["Result", "COMPILE ONLY"],
				["Log", outcome.log],
			]);
			for (const line of timingLines(t0)) console.log(`[dtsim] ${line}`);
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
			opts,
		);
		const rows: Array<[string, string]> = [
			["Test", c.id],
			["Seq", c.uvm?.seq ?? ""],
			["Seed", seed],
			["Result", result.status + (result.note ? ` (${result.note})` : "")],
			["Output", seedDir],
			["Log", `${result.log} (${Bun.file(result.log).size} bytes)`],
			["Elapsed", fmtElapsed((Date.now() - started) / 1000)],
		];
		const details = result.details;
		if (details) {
			const hits = Object.entries(details.errorCounts)
				.map(([kw, n]) => `${kw} (${n})`)
				.join(", ");
			if (hits) rows.push(["Error kws", hits]);
			if (details.missingExpect.length > 0) {
				rows.push([
					"Expect kws",
					`missing: ${details.missingExpect.join(", ")}`,
				]);
			}
			if (details.waived > 0)
				rows.push(["Waived errs", String(details.waived)]);
			if (details.unclosed) rows.push(["Warning", "unclosed waive region"]);
			if (details.unknown.length > 0) {
				rows.push([
					"Warning",
					`unknown waive rule: ${details.unknown.join(", ")}`,
				]);
			}
		}
		if (result.status !== "PASS") {
			rows.push(["Error", join(seedDir, "error.txt")]);
		}
		printBlock("Summary", rows);
		if (result.status !== "PASS" && result.status !== "PASS WITH ERRORS") {
			worst = 1;
		}
	}
	for (const line of timingLines(t0)) console.log(`[dtsim] ${line}`);
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
	const dir = caseOutputDir(ws, c.id);
	const built = childEnv(ws, c, phase, dir, phase === "sim" ? "0" : undefined);
	console.log(`[dtsim] ${envStatsLine(built.stats)}`);
	for (const [key, source] of [...built.sources.entries()].sort()) {
		const value = showValues ? ` = ${built.env[key] ?? ""}` : "";
		console.log(`${source.padEnd(7)} ${key}${value}`);
	}
}
