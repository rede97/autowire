// `autowire dtsim ...` and the `dtsim` multi-call name (ln -s autowire.js dtsim).
// The subcommands are the same either way; only the program name differs.
// Config: <project>/dt/config/dtsim.config.ts, found upward from CWD.

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import chalk from "chalk";
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
	skippedCases,
} from "../dtsim/core/regression.ts";
import { resultsCommand } from "../dtsim/core/results.ts";
import {
	printCaseEnv,
	readSeeds,
	runSingle,
	seedsFor,
} from "../dtsim/core/single.ts";
import { plain, type TreeNode, table, tree } from "../dtsim/core/ui.ts";
import type { CaseDef } from "../dtsim/dsl/index.ts";
import { formatRelease } from "./version.ts";

type CommonOpts = {
	config?: string;
	tool?: string;
	seed?: string;
	seedFile?: string;
	numSeeds?: number;
	label?: string;
	verbose: boolean;
	plain: boolean;
	cov?: boolean;
	covMetrics?: string;
	covMerge: boolean;
	wave?: boolean;
	waveDepth?: string;
	waveTop?: string;
};

const CONFIG_HELP =
	"dtsim.config.ts path (default: dt/config/ upward from CWD)";
const TOOL_HELP =
	"Workspace tool by name ($DTSIM_TOOL; default: the first in tools)";

/** Run switches are environment variables: set them before the config is
 *  imported, so backends read them when constructed and children inherit
 *  them. A flag left out keeps whatever the shell already exported. */
function applySwitches(opts: Partial<CommonOpts>): void {
	const set = (name: string, value: string | undefined) => {
		if (value !== undefined) process.env[name] = value;
	};
	set("DTSIM_TOOL", opts.tool);
	set("DTSIM_WAVE", opts.wave ? "1" : undefined);
	set("DTSIM_WAVE_DEPTH", opts.waveDepth);
	set("DTSIM_WAVE_TOP", opts.waveTop);
	set("DTSIM_COV", opts.cov ? "1" : undefined);
	set("DTSIM_COV_METRICS", opts.covMetrics);
	set("DTSIM_COV_MERGE", opts.covMerge === false ? "0" : undefined);
}

function load(opts: Partial<CommonOpts>) {
	applySwitches(opts);
	return loadWorkspace({ config: opts.config });
}

function engineOpts(opts: CommonOpts, interactive: boolean) {
	return {
		verbose: opts.verbose,
		interactive,
		plain: opts.plain,
		regression: false,
		...(opts.seed === undefined ? {} : { seed: opts.seed }),
		...(opts.seedFile === undefined ? {} : { seedFile: opts.seedFile }),
		...(opts.numSeeds === undefined ? {} : { numSeeds: opts.numSeeds }),
		...(opts.label === undefined ? {} : { label: opts.label }),
	};
}

function addCommon(cmd: Command): Command {
	return cmd
		.option("--config <path>", CONFIG_HELP)
		.option("--tool <name>", TOOL_HELP)
		.option("-s, --seed <seed>", "explicit random seed")
		.option("--seed-file <file>", "one seed per line")
		.option("--num-seeds <n>", "generate N seeds", (v) => Number(v))
		.option("-d, --label <label>", "output label under dt/simout/")
		.option(
			"-v, --verbose",
			"show child logs (on a TTY: printed above the live status)",
			false,
		)
		.option("--plain", "no dashboard; one line per task", false)
		.option("--wave", "dump waveforms ($DTSIM_WAVE=1)")
		.option(
			"--wave-depth <n>",
			"dump depth, 0 = all levels ($DTSIM_WAVE_DEPTH)",
		)
		.option(
			"--wave-top <scope>",
			"dump scope (default: the tool's top; $DTSIM_WAVE_TOP)",
		)
		.option("--cov", "collect coverage ($DTSIM_COV=1)")
		.option("--cov-metrics <metrics>", "coverage metrics ($DTSIM_COV_METRICS)")
		.option("--no-cov-merge", "skip per-group urg merge ($DTSIM_COV_MERGE=0)");
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
				const ws = await load(opts);
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
		cmd
			.command("regr [group]")
			.description("run a regression group or pattern (default: *)"),
	).action(async (group: string | undefined, opts: CommonOpts) => {
		const ws = await load(opts);
		const controller = new AbortController();
		process.once("SIGINT", () => controller.abort());
		process.exitCode = await runRegression(ws, group ?? "*", {
			...engineOpts(opts, false),
			regression: true,
			abort: controller.signal,
		});
	});

	addCommon(
		cmd.command("plan [group]").description("print the compile-group plan"),
	).action(async (group: string | undefined, opts: CommonOpts) => {
		const ws = await load(opts);
		const groups = planGroups(ws, group ?? "*", opts.label);
		const seeds = await readSeeds(opts);
		const text = planText(groups, (c) => seedsFor(c, seeds), {
			tool: ws.tool.name,
			ids: skippedCases(ws, group ?? "*"),
		});
		console.log(text);
		const dir = regressionDir(ws, opts.label);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "regression.txt"), `${plain(text)}\n`);
	});

	cmd
		.command("list")
		.description("list testcases as trees of derived cases")
		.option("--config <path>", CONFIG_HELP)
		.option("--tool <name>", TOOL_HELP)
		.action(async (opts: { config?: string; tool?: string }) => {
			const ws = await load(opts);
			// Top-level cases show seq, owner and a `tools` limit; derived ids are
			// listed without evaluating their (possibly lazy) options.
			const nodes = (node: CaseDef): TreeNode[] =>
				node.children.map((c) => ({ label: c.id, children: nodes(c) }));
			for (const [id, node] of [...ws.cases.entries()].sort()) {
				const c = mergeCase(ws, id);
				const info = [
					node.abstract ? "abstract" : "",
					c.uvm?.seq,
					c.owner,
					c.tools ? `tools ${c.tools.join(",")}` : "",
				]
					.filter(Boolean)
					.join(" · ");
				console.log(`${chalk.bold(id)}${info ? `  ${chalk.dim(info)}` : ""}`);
				for (const line of tree(nodes(node))) console.log(line);
			}
		});

	cmd
		.command("groups")
		.description("list regression groups")
		.option("--config <path>", CONFIG_HELP)
		.option("--tool <name>", TOOL_HELP)
		.action(async (opts: { config?: string; tool?: string }) => {
			const ws = await load(opts);
			// Cases the selected tool runs; the rest are counted as skipped.
			const rows = ["*", ...ws.groups.keys()].map((name) => {
				const all = resolveGroup(ws, name).length;
				const skipped = skippedCases(ws, name).length;
				return [
					name,
					String(all - skipped),
					skipped ? chalk.dim(String(skipped)) : "",
				];
			});
			console.log(table(rows, ["Group", `Cases (${ws.tool.name})`, "Skipped"]));
		});

	cmd
		.command("results")
		.description("read or re-grade results under a directory")
		.requiredOption("--dir <dir>", "regression or case output directory")
		.option("--recheck", "re-grade from sim.log", false)
		.option("--csv", "machine-readable rows", false)
		.option("--config <path>", CONFIG_HELP)
		.option("--tool <name>", "tool whose graders --recheck uses ($DTSIM_TOOL)")
		.action(
			async (opts: {
				dir: string;
				recheck: boolean;
				csv: boolean;
				config?: string;
				tool?: string;
			}) => {
				applySwitches(opts);
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
		.option("--tool <name>", TOOL_HELP)
		.action(
			async (opts: {
				case: string;
				phase: string;
				showValues: boolean;
				config?: string;
				tool?: string;
			}) => {
				const ws = await load(opts);
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
