// `autowire dtsim ...` and the `dtsim` multi-call name (ln -s autowire.js dtsim).
// The subcommands are the same either way; only the program name differs.
// Config: autowire.toml's [dtsim] config (default dt/config/dtsim.config.ts),
// else dt/config/dtsim.config.ts found upward from CWD.

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import chalk from "chalk";
import { Command, Option } from "commander";
import type { WorkspaceEnv } from "../dtsim/core/config.ts";
import {
	findCase,
	loadWorkspace,
	loadWorkspaceEnv,
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
import type { CaseDef, EnvVarDoc } from "../dtsim/dsl/index.ts";
import { formatRelease } from "./version.ts";

type CommonOpts = {
	label?: string;
	verbose: boolean;
	plain: boolean;
};

const DESCRIPTION =
	"Simulation runner: <project>/dt/ holds the testbench, [dtsim] config in autowire.toml selects the cases";

const NO_CONFIG: WorkspaceEnv = { configPath: "", vars: [] };

function engineOpts(opts: CommonOpts, interactive: boolean) {
	return {
		verbose: opts.verbose,
		interactive,
		plain: opts.plain,
		regression: false,
		...(opts.label === undefined ? {} : { label: opts.label }),
	};
}

/** Register the config's EnvVarDoc flags on `cmd`, after its built-in
 *  options so a clash names the config entry. Before the action (and so
 *  before the Workspace factory) a flag given on the command line sets its
 *  variable; an unset negatable flag's default (true) does not. */
function addConfigOptions(cmd: Command, env: WorkspaceEnv): Command {
	const registered: { env: EnvVarDoc; attribute: string }[] = [];
	for (const v of env.vars) {
		if (!v.flags) continue;
		try {
			const option = new Option(
				v.flags,
				v.desc ?? `config option for ${v.name}`,
			);
			cmd.addOption(option);
			registered.push({ env: v, attribute: option.attributeName() });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`dtsim: ${env.configPath}: env var ${v.name}: ${message}`,
			);
		}
	}
	cmd.hook("preAction", () => {
		for (const { env: v, attribute } of registered) {
			if (cmd.getOptionValueSource(attribute) !== "cli") continue;
			const value: unknown = cmd.getOptionValue(attribute);
			const raw = typeof value === "boolean" ? value : String(value);
			const out = v.set ? v.set(raw) : raw === true ? "1" : String(raw);
			if (out !== undefined) process.env[v.name] = out;
		}
	});
	return cmd;
}

function addCommon(cmd: Command): Command {
	return cmd
		.option("-d, --label <label>", "output label under dt/simout/")
		.option(
			"-v, --verbose",
			"show child logs (on a TTY: printed above the live status)",
			false,
		)
		.option("--plain", "no dashboard; one line per task", false);
}

/** Attach the dtsim subcommands to `cmd` (autowire's `dtsim` or a bare program). */
function addDtsimCommands(cmd: Command, env: WorkspaceEnv): Command {
	const run = addCommon(
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
				const ws = await loadWorkspace({});
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

	const regr = addCommon(
		cmd
			.command("regr [group]")
			.description("run a regression group or pattern (default: *)"),
	).action(async (group: string | undefined, opts: CommonOpts) => {
		const ws = await loadWorkspace({ mode: "regr" });
		const controller = new AbortController();
		process.once("SIGINT", () => controller.abort());
		process.exitCode = await runRegression(ws, group ?? "*", {
			...engineOpts(opts, false),
			regression: true,
			abort: controller.signal,
		});
	});

	const plan = addCommon(
		cmd.command("plan [group]").description("print the compile-group plan"),
	).action(async (group: string | undefined, opts: CommonOpts) => {
		// The plan of a regression: the factory sees the same mode regr does.
		const ws = await loadWorkspace({ mode: "regr" });
		const groups = planGroups(ws, group ?? "*", opts.label);
		const seeds = readSeeds(ws.seeds);
		const text = planText(groups, (c) => seedsFor(c, seeds), {
			tool: ws.tool.name,
			ids: skippedCases(ws, group ?? "*"),
		});
		console.log(text);
		const dir = regressionDir(ws, opts.label);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "regression.txt"), `${plain(text)}\n`);
	});

	const list = cmd
		.command("list [case]")
		.description(
			"list testcases as trees (default 2 levels; a case limits to its subtree)",
		)
		.option("-L, --depth <n>", "levels to expand (root is 1; default 2)", (v) =>
			Number(v),
		)
		.option("-a, --all", "expand every level")
		.action(
			async (
				caseId: string | undefined,
				opts: {
					depth?: number;
					all?: boolean;
				},
			) => {
				if (
					opts.depth !== undefined &&
					(!Number.isInteger(opts.depth) || opts.depth < 1)
				) {
					throw new Error("dtsim: --depth must be a positive integer");
				}
				const ws = await loadWorkspace({});
				const limit = opts.all ? Number.POSITIVE_INFINITY : (opts.depth ?? 2);
				let roots: CaseDef[];
				if (caseId === undefined) {
					roots = [...ws.cases.values()];
				} else {
					const node = findCase(ws, caseId);
					if (!node) throw new Error(`dtsim: testcase "${caseId}" not found`);
					roots = [node];
				}
				roots.sort((a, b) => a.id.localeCompare(b.id));
				// Root is level 1; stop expanding children past `limit` levels.
				const nodes = (node: CaseDef, lvl: number): TreeNode[] =>
					lvl >= limit
						? []
						: node.children.map((c) => ({
								label: c.id,
								children: nodes(c, lvl + 1),
							}));
				for (const node of roots) {
					const c = mergeCase(ws, node.id);
					const info = [
						node.abstract ? "abstract" : "",
						c.uvm?.seq,
						c.owner,
						c.tools ? `tools ${c.tools.join(",")}` : "",
					]
						.filter(Boolean)
						.join(" · ");
					console.log(
						`${chalk.bold(node.id)}${info ? `  ${chalk.dim(info)}` : ""}`,
					);
					for (const line of tree(nodes(node, 1))) console.log(line);
				}
			},
		);

	const groups = cmd
		.command("groups")
		.description("list regression groups")
		.action(async () => {
			const ws = await loadWorkspace({});
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
		.addOption(
			// dresults passes the regression's tool so --recheck grades with it.
			new Option(
				"--tool <name>",
				"re-grade with this configured tool",
			).hideHelp(),
		)
		.action(
			async (opts: {
				dir: string;
				recheck: boolean;
				csv: boolean;
				tool?: string;
			}) => {
				process.exitCode = await resultsCommand(opts);
			},
		);

	const envCmd = cmd
		.command("env")
		.description("show the environment a case would receive")
		.requiredOption("--case <id>", "case id")
		.option("--phase <phase>", "compile or sim", "sim")
		.option("--show-values", "print values, not just names", false)
		.action(
			async (opts: { case: string; phase: string; showValues: boolean }) => {
				const ws = await loadWorkspace({});
				printCaseEnv(
					ws,
					opts.case,
					opts.phase === "compile" ? "compile" : "sim",
					opts.showValues,
				);
				if (ws.vars.length > 0) {
					console.log(chalk.bold("Config environment variables"));
					console.log(
						table(
							ws.vars.map((v) => [
								v.name,
								v.values ?? "",
								v.default ?? "",
								v.desc ?? "",
							]),
							["Name", "Values", "Default", "Description"],
						),
					);
				}
			},
		);
	// Config flags last: a clash with a built-in option then names the
	// config entry. list/groups/env evaluate the factory too.
	for (const c of [run, regr, plan, list, groups, envCmd])
		addConfigOptions(c, env);
	return cmd;
}

/** Help, version and `results` without `--recheck` need no config. */
function configFree(args: readonly string[]): boolean {
	if (args.some((a) => ["-h", "--help", "-V", "--version"].includes(a)))
		return true;
	const sub = args.find((a) => !a.startsWith("-"));
	return (
		sub === undefined ||
		sub === "help" ||
		(sub === "results" && !args.includes("--recheck"))
	);
}

/** The config registry for the dtsim arguments `args`. A command that needs
 *  no config still registers (empty registry) when the config cannot load. */
async function configEnv(args: readonly string[]): Promise<WorkspaceEnv> {
	try {
		return await loadWorkspaceEnv();
	} catch (error) {
		if (configFree(args)) return NO_CONFIG;
		throw error;
	}
}

export async function registerDtsim(program: Command): Promise<void> {
	// Only `autowire dtsim ...` reads the config: other commands must not
	// import it or write dt/config/.dtsim/.
	const args = process.argv.slice(2);
	const env = args[0] === "dtsim" ? await configEnv(args.slice(1)) : NO_CONFIG;
	addDtsimCommands(program.command("dtsim").description(DESCRIPTION), env);
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
	try {
		const env = await configEnv(argv.slice(2));
		const program = addDtsimCommands(
			new Command("dtsim").description(DESCRIPTION).version(formatRelease()),
			env,
		);
		await program.parseAsync([...argv]);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
