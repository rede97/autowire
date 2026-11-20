import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLauncher } from "../../src/dtsim/core/launch.ts";
import {
	LocalLauncher,
	LsfLauncher,
	SlurmLauncher,
} from "../../src/dtsim/dsl/launchers.ts";
import { CASES_TS, makeWorkspace, runDtsim } from "./helpers.ts";

// Launchers run through the demo/dtsim fake bsub / srun, which log their argv
// to $DTSIM_MOCK_LAUNCH_LOG and then exec the wrapped command.
const withTask = (task: string) =>
	CASES_TS.replace(
		"task: { maxSlots: 4, maxCompiles: 2 },",
		`task: ${task},`,
	).replace(
		'import { DefaultGrader, VcsTool } from "./.dtsim/dsl/index.ts";',
		'import { DefaultGrader, VcsTool, LsfLauncher, defineLauncher } from "./.dtsim/dsl/index.ts";',
	);

describe("launchers", () => {
	test("lsf wraps compile and sim in bsub with queue and args", async () => {
		const ws = await makeWorkspace(
			withTask(
				'{ launcher: LsfLauncher({ queue: "normal", args: ["-R", "rusage[mem=4000]"] }), maxSlots: 2, maxCompiles: 1 }',
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
			withTask(
				'{ launcher: LsfLauncher({ queue: "normal" }), maxSlots: 2, maxCompiles: 1 }',
			),
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
			"{ launcher: tagged, maxSlots: 1, maxCompiles: 1 }",
		).replace(
			"\n// Only top-level cases",
			`
const tag = "T42";
const tagged = defineLauncher({
	name: "tagged",
	passthrough: ["SITE_GRID_*"],
	wrap: (argv, ctx) => [
		"bash", "-c",
		'echo "$0 $SITE_GRID_TOKEN" >> "$DTSIM_MOCK_LAUNCH_LOG"; shift; exec "$@"',
		ctx.phase + ":" + ctx.jobName + ":" + tag,
		"_", ...argv,
	],
});
// Only top-level cases`,
		);
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

	test("lsf writes bjob_ submit wrappers next to the run scripts", async () => {
		const ws = await makeWorkspace(
			withTask(
				'{ launcher: LsfLauncher({ queue: "normal" }), maxSlots: 2, maxCompiles: 1 }',
			).replace("tools: [VcsTool()],", "tools: [VcsTool({ wave: true })],"),
		);
		const result = await runDtsim(ws, ["run", "test_hello_world", "-s", "5"], {
			DTSIM_TASK_TYPE: "lsf",
			DTSIM_MOCK_LAUNCH_LOG: join(ws.dir, "launch.log"),
		});
		expect(result.code).toBe(0);
		const found = [...new Bun.Glob("**/bjob_*").scanSync(ws.dir)];
		expect(found.some((f) => f.endsWith("bjob_compile"))).toBe(true);
		expect(found.some((f) => f.endsWith("bjob_sim"))).toBe(true);
		expect(found.some((f) => f.endsWith("bjob_verdi"))).toBe(true);
		const sim = found.find((f) => f.endsWith("bjob_sim")) as string;
		const text = await Bun.file(join(ws.dir, sim)).text();
		expect(text).toContain(
			"exec 'bsub' '-I' '-J' 'test_hello_world_5' '-q' 'normal' 'bash' '",
		);
		// the submitted run script is an absolute path, not the bare name
		expect(text).toMatch(/'bash' '[^']*\/run_sim'/);
	});

	test("local bypasses the wrapper scripts", async () => {
		const ws = await makeWorkspace();
		const result = await runDtsim(
			ws,
			["run", "test_hello_world", "-s", "5"],
			{},
		);
		expect(result.code).toBe(0);
		const wrappers = [
			...new Bun.Glob("**/bjob_*").scanSync(ws.dir),
			...new Bun.Glob("**/srun_*").scanSync(ws.dir),
		];
		expect(wrappers).toHaveLength(0);
	});
});

describe("launcher probe", () => {
	test("a probe list falls back when the submit tool is absent, else picks it", async () => {
		const savedPath = process.env.PATH;
		const savedType = process.env.DTSIM_TASK_TYPE;
		delete process.env.DTSIM_TASK_TYPE;
		try {
			const dir = mkdtempSync(join(tmpdir(), "dtsim-probe-"));
			process.env.PATH = dir;
			// No bsub/srun on this PATH: the list falls back to local.
			expect(
				(
					await resolveLauncher([
						LsfLauncher(),
						SlurmLauncher(),
						LocalLauncher(),
					])
				).name,
			).toBe("local");
			// A single launcher is an explicit choice, not probed.
			expect((await resolveLauncher(LsfLauncher())).name).toBe("lsf");
			// With bsub on PATH the list now picks lsf first.
			writeFileSync(join(dir, "bsub"), "#!/bin/sh\n", { mode: 0o755 });
			expect(
				(await resolveLauncher([LsfLauncher(), LocalLauncher()])).name,
			).toBe("lsf");
		} finally {
			process.env.PATH = savedPath;
			if (savedType === undefined) delete process.env.DTSIM_TASK_TYPE;
			else process.env.DTSIM_TASK_TYPE = savedType;
		}
	});

	test("DTSIM_TASK_TYPE forces a launcher and skips the probe", async () => {
		const saved = process.env.DTSIM_TASK_TYPE;
		process.env.DTSIM_TASK_TYPE = "slurm";
		try {
			expect(
				(await resolveLauncher([LsfLauncher(), LocalLauncher()])).name,
			).toBe("slurm");
		} finally {
			if (saved === undefined) delete process.env.DTSIM_TASK_TYPE;
			else process.env.DTSIM_TASK_TYPE = saved;
		}
	});
});
