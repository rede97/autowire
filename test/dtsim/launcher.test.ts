import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CASES_TS, makeWorkspace, runDtsim } from "./helpers.ts";

// Launchers run through the demo/dtsim fake bsub / srun, which log their argv
// to $DTSIM_MOCK_LAUNCH_LOG and then exec the wrapped command.
const withTask = (task: string) =>
	CASES_TS.replace(
		'task: { type: "local", maxSlots: 4, maxCompiles: 2 },',
		`task: ${task},`,
	);

describe("launchers", () => {
	test("lsf wraps compile and sim in bsub with queue and options.args", async () => {
		const ws = await makeWorkspace(
			withTask(
				'{ type: "lsf", queue: "normal", maxSlots: 2, maxCompiles: 1, options: { args: ["-R", "rusage[mem=4000]"] } }',
			),
		);
		const log = join(ws.dir, "launch.log");
		const result = await runDtsim(ws, ["run", "test_hello_world", "-s", "5"], {
			DTSIM_TASK_TYPE: "lsf",
			DTSIM_MOCK_LAUNCH_LOG: log,
		});
		expect(result.code).toBe(0);
		const lines = (await Bun.file(log).text()).trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toStartWith(
			"bsub -I -J compile_test_hello_world -q normal -R rusage[mem=4000] vcs ",
		);
		expect(lines[1]).toStartWith(
			"bsub -I -J test_hello_world_5 -q normal -R rusage[mem=4000] bash ",
		);
	});

	test("DTSIM_TASK_TYPE switches to slurm; DTSIM_TASK_QUEUE overrides the queue", async () => {
		const ws = await makeWorkspace(
			withTask('{ type: "lsf", queue: "normal", maxSlots: 2, maxCompiles: 1 }'),
		);
		const log = join(ws.dir, "launch.log");
		const result = await runDtsim(ws, ["regr", "base", "--plain"], {
			DTSIM_TASK_TYPE: "slurm",
			DTSIM_TASK_QUEUE: "high",
			DTSIM_MOCK_LAUNCH_LOG: log,
		});
		expect(result.code).toBe(0);
		const lines = (await Bun.file(log).text()).trim().split("\n");
		expect(
			lines.every((l) => l.startsWith("srun --pty --qos high --job-name ")),
		).toBe(true);
		// base: three compile groups (different defines / compile env), three sims
		expect(lines.filter((l) => / compile_\S+ vcs /.test(l))).toHaveLength(3);
		expect(lines.filter((l) => / bash /.test(l))).toHaveLength(3);
	});

	test("a workspace can ship its own launcher; its passthrough reaches the child", async () => {
		const body = withTask(
			'{ type: "tagged", maxSlots: 1, maxCompiles: 1, options: { tag: "T42" } }',
		)
			.replace(
				'import { Case, Group, WaiveRule, Workspace } from "./.dtsim/dsl/index.ts";',
				`import { Case, Group, WaiveRule, Workspace, defineLauncher } from "./.dtsim/dsl/index.ts";
const tagged = defineLauncher({
	kind: "dtsim-launcher",
	id: "tagged",
	passthrough: ["SITE_GRID_*"],
	wrap: (argv, ctx) => [
		"bash", "-c",
		'echo "$0 $SITE_GRID_TOKEN" >> "$DTSIM_MOCK_LAUNCH_LOG"; shift; exec "$@"',
		ctx.phase + ":" + ctx.jobName + ":" + ctx.options.tag,
		"_", ...argv,
	],
});`,
			)
			.replace('tool: "vcs"', 'tool: "vcs", launchers: [tagged]');
		const ws = await makeWorkspace(body);
		const log = join(ws.dir, "launch.log");
		const result = await runDtsim(ws, ["run", "test_hello_world", "-s", "7"], {
			DTSIM_TASK_TYPE: "tagged",
			DTSIM_MOCK_LAUNCH_LOG: log,
			SITE_GRID_TOKEN: "tok",
		});
		expect(result.code).toBe(0);
		expect((await Bun.file(log).text()).trim().split("\n")).toEqual([
			"compile:compile_test_hello_world:T42 tok",
			"sim:test_hello_world_7:T42 tok",
		]);
	});

	test("unknown task type fails before any output is written", async () => {
		const ws = await makeWorkspace();
		const result = await runDtsim(ws, ["run", "test_hello_world"], {
			DTSIM_TASK_TYPE: "pbs",
		});
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('unknown task type "pbs"');
		expect(existsSync(ws.out)).toBe(false);
	});
});
