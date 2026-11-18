// `autowire dtsim ...` and the `dtsim` multi-call name (ln -s autowire.js dtsim).
// The subcommands are the same either way; only the program name differs.
// Config: <project>/dt/config/dtsim.config.ts, found upward from CWD.

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Command } from "commander";
import {
	loadWorkspace,
	mergeCase,
	resolveGroup,
} from "../dtsim/core/config.ts";
import {
	planGroups,
	planText,
	regressionDir,
	runRegression,
} from "../dtsim/core/regression.ts";
import { resultsCommand } from "../dtsim/core/results.ts";
import { printCaseEnv, runSingle } from "../dtsim/core/single.ts";
import { formatRelease } from "./version.ts";

type CommonOpts = {
	config?: string;
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

const CONFIG_HELP =
	"dtsim.config.ts path (default: dt/config/ upward from CWD)";

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
		.option("--config <path>", CONFIG_HELP)
		.option("-s, --seed <seed>", "explicit random seed")
		.option("--seed-file <file>", "one seed per line")
		.option("--num-seeds <n>", "generate N seeds", (v) => Number(v))
		.option("-d, --label <label>", "output label under dt/simout/")
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

/** Attach the dtsim subcommands to `cmd` (autowire's `dtsim` or a bare program). */
function addDtsimCommands(cmd: Command): Command {
	addCommon(
		cmd.command("run <case>").description("compile and simulate one case"),
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
				const ws = await loadWorkspace({ config: opts.config });
				const controller = new AbortController();
				process.once("SIGINT", () => controller.abort());
				process.exitCode = await runSingle(ws, caseId, {
					...engineOpts(opts, opts.interactive),
					compileOnly: opts.compileOnly,
					simOnly: opts.simOnly,
					abort: controller.signal,
				});
			},
		);

	addCommon(
		cmd.command("regr [group]").description("run a regression group"),
	).action(async (group: string | undefined, opts: CommonOpts) => {
		const ws = await loadWorkspace({ config: opts.config });
		const controller = new AbortController();
		process.once("SIGINT", () => controller.abort());
		process.exitCode = await runRegression(ws, group ?? "all", {
			...engineOpts(opts, false),
			regression: true,
			abort: controller.signal,
		});
	});

	addCommon(
		cmd.command("plan [group]").description("print the compile-group plan"),
	).action(async (group: string | undefined, opts: CommonOpts) => {
		const ws = await loadWorkspace({ config: opts.config });
		const groups = planGroups(ws, group ?? "all", opts.label);
		console.log(planText(groups));
		const dir = regressionDir(ws, opts.label);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "regression.txt"), `${planText(groups)}\n`);
	});

	cmd
		.command("list")
		.description("list base testcases")
		.option("--config <path>", CONFIG_HELP)
		.action(async (opts: { config?: string }) => {
			const ws = await loadWorkspace({ config: opts.config });
			for (const [id] of [...ws.cases.entries()].sort()) {
				const c = mergeCase(ws, id);
				console.log(`${id}\t${c.uvm?.seq ?? ""}\t${c.owner}`);
			}
		});

	cmd
		.command("groups")
		.description("list regression groups")
		.option("--config <path>", CONFIG_HELP)
		.action(async (opts: { config?: string }) => {
			const ws = await loadWorkspace({ config: opts.config });
			for (const name of ["all", ...ws.groups.keys()]) {
				console.log(`${name}\t${resolveGroup(ws, name).length} cases`);
			}
		});

	cmd
		.command("results")
		.description("read or re-grade results under a directory")
		.requiredOption("--dir <dir>", "regression or case output directory")
		.option("--recheck", "re-grade from sim.log", false)
		.option("--csv", "machine-readable rows", false)
		.option("--config <path>", CONFIG_HELP)
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

	cmd
		.command("env")
		.description("show the environment a case would receive")
		.requiredOption("--case <id>", "case id")
		.option("--phase <phase>", "compile or sim", "sim")
		.option("--show-values", "print values, not just names", false)
		.option("--config <path>", CONFIG_HELP)
		.action(
			async (opts: {
				case: string;
				phase: string;
				showValues: boolean;
				config?: string;
			}) => {
				const ws = await loadWorkspace({ config: opts.config });
				printCaseEnv(
					ws,
					opts.case,
					opts.phase === "compile" ? "compile" : "sim",
					opts.showValues,
				);
			},
		);
	return cmd;
}

const DESCRIPTION =
	"Simulation runner: <project>/dt/ holds the testbench, dt/config/dtsim.config.ts the cases";

export function registerDtsim(program: Command): void {
	addDtsimCommands(program.command("dtsim").description(DESCRIPTION));
}

/** true when this process was started as `dtsim` (symlink or copy of autowire.js / autowire). */
export function invokedAsDtsim(): boolean {
	// Bun resolves symlinks in process.argv[1], so a `dtsim -> autowire.js`
	// link shows up as autowire.js there. Linux keeps the names as exec'd in
	// /proc/self/cmdline: [bun, ./dtsim, ...] for the script, [dtsim, ...] for
	// the compiled binary. Elsewhere only a copy named dtsim is detected.
	let raw: string[] = [];
	try {
		const [exe, script] = readFileSync("/proc/self/cmdline", "utf8").split(
			"\0",
		);
		// Under bun the entry is argv[1]; a compiled binary's argv[1] is
		// already the first CLI word (`autowire dtsim run` must not match).
		const viaBun = exe !== undefined && /^bun(\.exe)?$/i.test(basename(exe));
		raw = [(viaBun ? script : exe) ?? ""];
	} catch {
		// no procfs (Windows, macOS)
	}
	return [...raw, process.argv[1], process.argv0].some(
		(p) => p !== undefined && /^dtsim(\.js|\.exe)?$/i.test(basename(p)),
	);
}

/** Multi-call entry: `dtsim <subcommand>` parses exactly like `autowire dtsim <subcommand>`. */
export async function runDtsimMain(argv: readonly string[]): Promise<void> {
	const program = addDtsimCommands(
		new Command("dtsim").description(DESCRIPTION).version(formatRelease()),
	);
	try {
		await program.parseAsync([...argv]);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
