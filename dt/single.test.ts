import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CASES_TS, makeWorkspace, runDtsim, seedDirs } from "./helpers.ts";

describe("single case", () => {
	test("compile and simulate: quiet logs, artifacts, summary", async () => {
		const ws = await makeWorkspace();
		const result = await runDtsim(ws, [
			"run",
			"test_hello_world",
			"-s",
			"1234",
		]);
		expect(result.code).toBe(0);
		// Quiet by default: the sim log body never reaches the terminal.
		expect(result.stdout).not.toContain("TEST PASSED");
		expect(result.stdout).toContain("Result");
		expect(result.stdout).toContain("PASS");
		const caseDir = join(ws.root, "simout", "test_hello_world");
		expect(await Bun.file(join(caseDir, "vcs.log")).exists()).toBe(true);
		expect(await Bun.file(join(caseDir, "dump.tcl")).exists()).toBe(true);
		const seeds = await seedDirs(caseDir);
		expect(seeds.length).toBe(1);
		const seedDir = seeds[0] as string;
		expect(seedDir.endsWith("1234")).toBe(true);
		const log = await Bun.file(join(seedDir, "sim.log")).text();
		expect(log).toContain("TEST PASSED");
		expect(log).toContain("+user_seq_type=test_hello_world_seq");
		expect(log).toContain('+UVM_TIMEOUT="1ns,YES"');
		const runSim = await Bun.file(join(seedDir, "run_sim")).text();
		expect(runSim).toContain("../simv");
		expect(runSim).toContain("+ntb_random_seed=$SEED");
		expect(runSim).toContain("export output_dir=");
		expect(await Bun.file(join(seedDir, "check_result.js")).exists()).toBe(
			true,
		);
		expect(await Bun.file(join(seedDir, ".result")).exists()).toBe(true);
	});

	test("explicit subcase: cosim args without bareDefaults, env exported", async () => {
		const ws = await makeWorkspace();
		const result = await runDtsim(ws, [
			"run",
			"test_hello_world.cosim",
			"-s",
			"7",
		]);
		expect(result.code).toBe(0);
		const caseDir = join(ws.root, "simout", "test_hello_world.cosim");
		const seedDir = join(caseDir, "7");
		const vcsLog = await Bun.file(join(caseDir, "vcs.log")).text();
		expect(vcsLog).toContain("-ad=");
		expect(vcsLog).toContain("-debug_access+all");
		expect(vcsLog).not.toContain("+nospecify");
		const runSim = await Bun.file(join(seedDir, "run_sim")).text();
		expect(runSim).toContain("export INPUT='input.spf'");
		expect(runSim).toContain("+fsdb+glitch=0");
	});

	test("sim-only env reaches sim but not compile; secrets stay out", async () => {
		const ws = await makeWorkspace();
		const result = await runDtsim(ws, ["run", "test_bar_basic", "-s", "9"], {
			UNRELATED_SECRET: "should-not-leak",
			LD_PRELOAD: "evil.so",
		});
		expect(result.code).toBe(0);
		const vcsLog = await Bun.file(
			join(ws.root, "simout", "test_bar_basic", "vcs.log"),
		).text();
		expect(vcsLog).toContain("BAR_CFG=basic");
		expect(vcsLog).toContain("SIM_TRACE=\n");
		expect(vcsLog).toContain("UNRELATED_SECRET=\n");
		expect(vcsLog).toContain("LD_PRELOAD=\n");
		const simLog = await Bun.file(
			join(ws.root, "simout", "test_bar_basic", "9", "sim.log"),
		).text();
		expect(simLog).toContain("SIM_TRACE=1");
		expect(simLog).toContain("UNRELATED_SECRET=\n");
		expect(simLog).toContain("LD_PRELOAD=\n");
		expect(simLog).toContain("DTSIM_TASK_TYPE=\n");
	});

	test("random=false runs one seed out of many", async () => {
		const ws = await makeWorkspace();
		const result = await runDtsim(ws, [
			"run",
			"test_hello_world",
			"--num-seeds",
			"3",
		]);
		expect(result.code).toBe(0);
		const seeds = await seedDirs(join(ws.root, "simout", "test_hello_world"));
		expect(seeds.length).toBe(1);
	});

	test("compile-only then sim-only", async () => {
		const ws = await makeWorkspace();
		const c = await runDtsim(ws, ["run", "test_hello_world", "--compile-only"]);
		expect(c.code).toBe(0);
		expect(c.stdout).toContain("COMPILE ONLY");
		const s = await runDtsim(ws, [
			"run",
			"test_hello_world",
			"--sim-only",
			"-s",
			"55",
		]);
		expect(s.code).toBe(0);
		expect(
			await Bun.file(
				join(ws.root, "simout", "test_hello_world", "55", "sim.log"),
			).exists(),
		).toBe(true);
	});

	test("sim failure: non-zero exit and error.txt with the fatal line", async () => {
		const ws = await makeWorkspace();
		const result = await runDtsim(ws, ["run", "test_hello_world", "-s", "3"], {
			DTSIM_MOCK_SIMV_FAIL: "1",
		});
		expect(result.code).toBe(1);
		const seedDir = join(ws.root, "simout", "test_hello_world", "3");
		const err = await Bun.file(join(seedDir, "error.txt")).text();
		expect(err).toContain("status: FAIL");
		expect(err).toContain("UVM_FATAL @ 1200ns");
		expect(err.split("\n").length).toBeLessThan(60);
	});

	test("error keyword still exits 0 and reports PASS WITH ERRORS", async () => {
		const ws = await makeWorkspace();
		const result = await runDtsim(ws, ["run", "test_hello_world", "-s", "4"], {
			DTSIM_MOCK_SIMV_ERROR: "1",
		});
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("PASS WITH ERRORS");
		expect(result.stdout).toContain("Error: (1)");
		const seedDir = join(ws.root, "simout", "test_hello_world", "4");
		expect(await Bun.file(join(seedDir, "error.txt")).exists()).toBe(true);
	});

	test("waived error passes and the waived count is shown", async () => {
		const ws = await makeWorkspace();
		const result = await runDtsim(ws, ["run", "test_hello_world", "-s", "5"], {
			DTSIM_MOCK_SIMV_WAIVE: "1",
		});
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Waived errs");
	});

	test("unknown case exits 1", async () => {
		const ws = await makeWorkspace();
		const result = await runDtsim(ws, ["run", "no_such_case"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("not found");
	});

	test("git_rev records the TB revision when verify is a git repo", async () => {
		const ws = await makeWorkspace();
		const git = (args: string[]) =>
			Bun.spawnSync({ cmd: ["git", ...args], cwd: ws.verify });
		git(["init", "-q"]);
		git(["config", "user.email", "dt@example.com"]);
		git(["config", "user.name", "dt"]);
		git(["add", "."]);
		git(["commit", "-qm", "fixture"]);
		const result = await runDtsim(ws, ["run", "test_hello_world", "-s", "61"]);
		expect(result.code).toBe(0);
		const caseDir = join(ws.root, "simout", "test_hello_world");
		const rev = await Bun.file(join(caseDir, "git_rev")).text();
		const head = git(["rev-parse", "--short", "HEAD"]);
		expect(rev).toContain(head.stdout.toString().trim());
		expect(await Bun.file(join(caseDir, "61", "git_rev")).exists()).toBe(true);
	});

	test("no-wave keeps the command shape and disables dump", async () => {
		const ws = await makeWorkspace();
		const result = await runDtsim(ws, [
			"run",
			"test_hello_world",
			"--no-wave",
			"-s",
			"8",
		]);
		expect(result.code).toBe(0);
		const tcl = await Bun.file(
			join(ws.root, "simout", "test_hello_world", "dump.tcl"),
		).text();
		expect(tcl).toContain("set dump_enable 0");
		const runSim = await Bun.file(
			join(ws.root, "simout", "test_hello_world", "8", "run_sim"),
		).text();
		expect(runSim).toContain("-ucli");
		expect(runSim).not.toContain("+DUMP_FSDB");
	});
});

describe("verilator backend", () => {
	test("compile produces an executable, sim grades its stdout log", async () => {
		const body = CASES_TS.replace('tool: "vcs"', 'tool: "verilator"').replace(
			'filelist: "file.lst",',
			'filelist: "file.lst", toolOptions: { top: "tb_top" },',
		);
		const ws = await makeWorkspace(body);
		const result = await runDtsim(ws, ["run", "test_hello_world", "-s", "11"]);
		expect(result.code).toBe(0);
		const caseDir = join(ws.root, "simout", "test_hello_world");
		expect(await Bun.file(join(caseDir, "obj_dir", "Vtb_top")).exists()).toBe(
			true,
		);
		const log = await Bun.file(join(caseDir, "11", "sim.log")).text();
		expect(log).toContain("mock verilator sim");
		expect(log).toContain("TEST PASSED");
		expect(log).toContain("+ntb_random_seed=11");
		expect(log).toContain("SIM_TRACE=");
		expect(log).toContain("UNRELATED_SECRET=");
		expect(log).not.toContain("+UVM_TESTNAME");
	});
});

describe("user-registered backend", () => {
	test("a workspace can ship its own simulator plugin", async () => {
		const body = CASES_TS.replace(
			'import { Case, Group, Subcase, WaiveRule, Workspace } from "./.dtsim/dsl/index.ts";',
			`import { Case, Group, Subcase, WaiveRule, Workspace, defineTool } from "./.dtsim/dsl/index.ts";
const echoTool = defineTool({
	kind: "dtsim-tool",
	id: "echo-sim",
	passthrough: ["PATH"],
	interactive: false,
	compileErrors: [/Error/],
	simErrors: [/Error/],
	compile(ctx) {
		return { argv: ["bash", "-c", "echo built > built.txt"], cwd: ctx.dir, log: ctx.dir + "/compile.log", logMode: "tee", executable: ctx.dir + "/built.txt" };
	},
	simulate(ctx) {
		return { argv: ["bash", "-c", "echo TEST PASSED"], cwd: ctx.dir, log: ctx.dir + "/sim.log", logMode: "tee" };
	},
});`,
		).replace('tool: "vcs"', 'tool: "echo-sim", tools: [echoTool]');
		const ws = await makeWorkspace(body);
		const result = await runDtsim(ws, ["run", "test_hello_world", "-s", "21"]);
		expect(result.code).toBe(0);
		const caseDir = join(ws.root, "simout", "test_hello_world");
		expect(await Bun.file(join(caseDir, "built.txt")).exists()).toBe(true);
		expect(await Bun.file(join(caseDir, "21", "sim.log")).text()).toContain(
			"TEST PASSED",
		);
	});
});
