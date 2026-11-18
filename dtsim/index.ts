#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
// dtsim CLI. Dev entry: `bun dtsim/index.ts ...`. Production: `bun dtsim.js ...`.
import { Command } from "commander";
import { loadWorkspace, mergeCase, resolveGroup } from "./core/config.ts";
import {
	planGroups,
	planText,
	regressionDir,
	runRegression,
} from "./core/regression.ts";
import { resultsCommand } from "./core/results.ts";
import { printCaseEnv, runSingle } from "./core/single.ts";

type CommonOpts = {
	config?: string;
	root?: string;
	seed?: string;
	seedFile?: string;
	numSeeds?: number;
	label?: string;
	verbose: boolean;
	plain: boolean;
	cov: boolean;
	covMetrics: string;
	covMerge: boolean;
	wave: boolean;
	waveDepth: string;
	waveTop: string;
};

function engineOpts(opts: CommonOpts, interactive: boolean) {
	return {
		verbose: opts.verbose,
		interactive,
		plain: opts.plain,
		regression: false,
		wave: {
			enabled: opts.wave,
			depth: Number(opts.waveDepth),
			top: opts.waveTop,
		},
		cov: { enabled: opts.cov, metrics: opts.covMetrics, merge: opts.covMerge },
		...(opts.seed === undefined ? {} : { seed: opts.seed }),
		...(opts.seedFile === undefined ? {} : { seedFile: opts.seedFile }),
		...(opts.numSeeds === undefined ? {} : { numSeeds: opts.numSeeds }),
		...(opts.label === undefined ? {} : { label: opts.label }),
	};
}

function addCommon(cmd: Command): Command {
	return cmd
		.option("--config <path>", "workspace dtsim.config.ts")
		.option("--root <path>", "simulation workspace root")
		.option("-s, --seed <seed>", "explicit random seed")
		.option("--seed-file <file>", "one seed per line")
		.option("--num-seeds <n>", "generate N seeds", (v) => Number(v))
		.option("-d, --label <label>", "output label under simout/")
		.option("-v, --verbose", "stream child logs to the terminal", false)
		.option("--plain", "no dashboard; one line per task", false)
		.option("--cov", "collect coverage", false)
		.option(
			"--cov-metrics <metrics>",
			"coverage metrics",
			"line+cond+fsm+tgl+branch+assert",
		)
		.option("--no-cov-merge", "skip per-group urg merge")
		.option("--no-wave", "disable waveform dump")
		.option("--wave-depth <n>", "waveform dump depth", "0")
		.option("--wave-top <top>", "waveform dump top module", "tb_top");
}

async function load(opts: CommonOpts) {
	return loadWorkspace({ config: opts.config, root: opts.root });
}

export function buildProgram(): Command {
	const program = new Command();
	program
		.name("dtsim")
		.description(
			"TypeScript-configured simulation runner with pluggable backends",
		)
		.version("0.1.0");

	addCommon(
		program.command("run <case>").description("compile and simulate one case"),
	)
		.option("--compile-only", "compile only", false)
		.option("--sim-only", "reuse an existing build", false)
		.option("--interactive", "attach the terminal to the simulator", false)
		.action(
			async (
				caseId: string,
				opts: CommonOpts & {
					compileOnly: boolean;
					simOnly: boolean;
					interactive: boolean;
				},
			) => {
				const ws = await load(opts);
				const controller = new AbortController();
				process.once("SIGINT", () => controller.abort());
				const code = await runSingle(ws, caseId, {
					...engineOpts(opts, opts.interactive),
					compileOnly: opts.compileOnly,
					simOnly: opts.simOnly,
					abort: controller.signal,
				});
				process.exitCode = code;
			},
		);

	addCommon(
		program.command("regr [group]").description("run a regression group"),
	).action(async (group: string | undefined, opts: CommonOpts) => {
		const ws = await load(opts);
		const controller = new AbortController();
		process.once("SIGINT", () => controller.abort());
		process.exitCode = await runRegression(ws, group ?? "all", {
			...engineOpts(opts, false),
			regression: true,
			abort: controller.signal,
		});
	});

	addCommon(
		program.command("plan [group]").description("print the compile-group plan"),
	).action(async (group: string | undefined, opts: CommonOpts) => {
		const ws = await load(opts);
		const groups = planGroups(ws, group ?? "all", opts.label);
		console.log(planText(groups));
		const dir = regressionDir(ws, opts.label);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "regression.txt"), `${planText(groups)}\n`);
	});

	program
		.command("list")
		.description("list base testcases")
		.option("--config <path>", "workspace dtsim.config.ts")
		.option("--root <path>", "simulation workspace root")
		.action(async (opts: CommonOpts) => {
			const ws = await load(opts);
			for (const [id] of [...ws.cases.entries()].sort()) {
				const c = mergeCase(ws, id);
				console.log(`${id}\t${c.uvm?.seq ?? ""}\t${c.owner}`);
			}
		});

	program
		.command("groups")
		.description("list regression groups")
		.option("--config <path>", "workspace dtsim.config.ts")
		.option("--root <path>", "simulation workspace root")
		.action(async (opts: CommonOpts) => {
			const ws = await load(opts);
			for (const name of ["all", ...ws.groups.keys()]) {
				console.log(`${name}\t${resolveGroup(ws, name).length} cases`);
			}
		});

	program
		.command("results")
		.description("read or re-grade results under a directory")
		.requiredOption("--dir <dir>", "regression or case output directory")
		.option("--recheck", "re-grade from sim.log", false)
		.option("--csv", "machine-readable rows", false)
		.option("--config <path>", "workspace dtsim.config.ts")
		.option("--root <path>", "simulation workspace root")
		.action(
			async (opts: {
				dir: string;
				recheck: boolean;
				csv: boolean;
				config?: string;
			}) => {
				process.exitCode = await resultsCommand(opts);
			},
		);

	program
		.command("env")
		.description("show the environment a case would receive")
		.requiredOption("--case <id>", "case id")
		.option("--phase <phase>", "compile or sim", "sim")
		.option("--show-values", "print values, not just names", false)
		.option("--config <path>", "workspace dtsim.config.ts")
		.option("--root <path>", "simulation workspace root")
		.action(
			async (
				opts: { case: string; phase: string; showValues: boolean } & CommonOpts,
			) => {
				const ws = await load(opts);
				printCaseEnv(
					ws,
					opts.case,
					opts.phase === "compile" ? "compile" : "sim",
					opts.showValues,
				);
			},
		);

	return program;
}

export async function main(argv: string[]): Promise<void> {
	try {
		await buildProgram().parseAsync(argv);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

if (import.meta.main) await main(process.argv);
