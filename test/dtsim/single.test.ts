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
		const caseDir = join(ws.out, "test_hello_world");
		expect(await Bun.file(join(caseDir, "vcs.log")).exists()).toBe(true);
		// No --wave: no dump.tcl, simv runs without UCLI.
		expect(await Bun.file(join(caseDir, "dump.tcl")).exists()).toBe(false);
		// Filelists reach VCS untouched as -f, compiled from the project root.
		const vcsLog = await Bun.file(join(caseDir, "vcs.log")).text();
		// MSYS bash prints /tmp/... for C:/msys64/tmp/...: compare the tail.
		expect(vcsLog).toMatch(/\ncwd=\S*\/proj\n/);
		expect(vcsLog).toContain("dt/config/file.lst");
		expect(await Bun.file(join(caseDir, "filelist.f")).exists()).toBe(false);
		// run_compile records the compile command with its env.
		const runCompile = await Bun.file(join(caseDir, "run_compile")).text();
		expect(runCompile).toContain("'+define+NUM=1'");
		expect(runCompile).toContain("export DTSIM_PHASE='compile'");
		const seeds = await seedDirs(caseDir);
		expect(seeds.length).toBe(1);
		const seedDir = seeds[0] as string;
		expect(seedDir.endsWith("1234")).toBe(true);
		const log = await Bun.file(join(seedDir, "sim.log")).text();
		expect(log).toContain("TEST PASSED");
		expect(log).toContain("+user_seq_type=test_hello_world_seq");
		expect(log).toContain("+UVM_TIMEOUT=1,YES");
		const runSim = await Bun.file(join(seedDir, "run_sim")).text();
		expect(runSim).toContain("../simv");
		expect(runSim).toContain("+ntb_random_seed=$SEED");
		expect(runSim).toContain("export output_dir=");
		expect(await Bun.file(join(seedDir, ".result")).exists()).toBe(true);
	});

	test("explicit subcase: bareDefaults, then cosim args; env exported", async () => {
		const ws = await makeWorkspace();
		const result = await runDtsim(ws, [
			"run",
			"test_hello_world.cosim",
			"-s",
			"7",
		]);
		expect(result.code).toBe(0);
		const caseDir = join(ws.out, "test_hello_world.cosim");
		const seedDir = join(caseDir, "7");
		const vcsLog = await Bun.file(join(caseDir, "vcs.log")).text();
		expect(vcsLog).toContain("-ad=");
		expect(vcsLog).toContain("-debug_access+all");
		expect(vcsLog).toContain("+nospecify");
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
			join(ws.out, "test_bar_basic", "vcs.log"),
		).text();
		expect(vcsLog).toContain("BAR_CFG=basic");
		expect(vcsLog).toContain("SIM_TRACE=\n");
		expect(vcsLog).toContain("UNRELATED_SECRET=\n");
		expect(vcsLog).toContain("LD_PRELOAD=\n");
		const simLog = await Bun.file(
			join(ws.out, "test_bar_basic", "9", "sim.log"),
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
		const seeds = await seedDirs(join(ws.out, "test_hello_world"));
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
				join(ws.out, "test_hello_world", "55", "sim.log"),
			).exists(),
		).toBe(true);
	});

	test("sim failure: non-zero exit and error.txt with the fatal line", async () => {
		const ws = await makeWorkspace();
		const result = await runDtsim(ws, ["run", "test_hello_world", "-s", "3"], {
			DTSIM_MOCK_SIMV_FAIL: "1",
		});
		expect(result.code).toBe(1);
		const seedDir = join(ws.out, "test_hello_world", "3");
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
		const seedDir = join(ws.out, "test_hello_world", "4");
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

	test("onResult can symlink sim.log to <case>.log after the sim", async () => {
		const body = CASES_TS.replace(
			"\tgrader,",
			`\tgrader,
	hooks: {
		onResult: (ctx) => {
			const dest = ctx.dir + "/" + ctx.caseId + ".log";
			// Windows needs SeCreateSymbolicLinkPrivilege; fall back to a copy.
			try {
				symlinkSync("sim.log", dest);
			} catch {
				copyFileSync(ctx.dir + "/sim.log", dest);
			}
		},
	},`,
		).replace(
			'import { DefaultGrader, VcsTool } from "./.dtsim/dsl/index.ts";',
			'import { symlinkSync, copyFileSync } from "node:fs";\nimport { DefaultGrader, VcsTool } from "./.dtsim/dsl/index.ts";',
		);
		const ws = await makeWorkspace(body);
		const run = await runDtsim(ws, ["run", "test_hello_world", "-s", "1"]);
		expect(run.code).toBe(0);
		const link = join(ws.out, "test_hello_world", "1", "test_hello_world.log");
		expect(await Bun.file(link).exists()).toBe(true);
		expect(await Bun.file(link).text()).toContain("TEST PASSED");
	});
	test("workspace seeds drive a run when no -s is given", async () => {
		const body = CASES_TS.replace(
			"\tgrader,\n\tgroups: [base, cosim],",
			'\tseeds: ["0", "1"],\n\tgrader,\n\tgroups: [base, cosim],',
		);
		const ws = await makeWorkspace(body);
		const run = await runDtsim(ws, ["run", "test_bar_basic"]);
		expect(run.code).toBe(0);
		// both workspace seeds ran, each with its own passing sim.log
		for (const seed of ["0", "1"]) {
			const log = join(ws.out, "test_bar_basic", seed, "sim.log");
			expect(await Bun.file(log).text()).toContain("TEST PASSED");
			expect(await Bun.file(log).text()).toContain(`+ntb_random_seed=${seed}`);
		}
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
		const caseDir = join(ws.out, "test_hello_world");
		const rev = await Bun.file(join(caseDir, "git_rev")).text();
		const head = git(["rev-parse", "--short", "HEAD"]);
		expect(rev).toContain(head.stdout.toString().trim());
		expect(await Bun.file(join(caseDir, "61", "git_rev")).exists()).toBe(true);
	});

	test("waves are off by default; the wave option turns them on", async () => {
		const ws = await makeWorkspace();
		const off = await runDtsim(ws, ["run", "test_hello_world", "-s", "8"]);
		expect(off.code).toBe(0);
		const dir = join(ws.out, "test_hello_world");
		const offLog = await Bun.file(join(dir, "8", "sim.log")).text();
		expect(offLog).not.toContain("-ucli");
		expect(offLog).toContain("+TEST=test_hello_world");
		const on = await makeWorkspace(
			CASES_TS.replace(
				"tools: [VcsTool()],",
				"tools: [VcsTool({ wave: { depth: 2 } })],",
			),
		);
		const r = await runDtsim(on, ["run", "test_hello_world", "-s", "8"]);
		expect(r.code).toBe(0);
		const onDir = join(on.out, "test_hello_world");
		const tcl = await Bun.file(join(onDir, "dump.tcl")).text();
		expect(tcl).toContain('fsdbDumpvars 2 tb_top "+all"');
		expect(await Bun.file(join(onDir, "8", "sim.log")).text()).toContain(
			"-ucli -i",
		);
		// run_verdi is generated only when wave is on.
		expect(
			[...new Bun.Glob("**/run_verdi").scanSync(onDir)].length,
		).toBeGreaterThan(0);
	});
});

describe("vcs options", () => {
	test("top sets -top and the default wave scope", async () => {
		const ws = await makeWorkspace(
			CASES_TS.replace(
				"tools: [VcsTool()],",
				'tools: [VcsTool({ top: "tb_x", wave: true })],',
			),
		);
		const run = await runDtsim(ws, ["run", "test_hello_world", "-s", "1"]);
		expect(run.code).toBe(0);
		const dir = join(ws.out, "test_hello_world");
		expect(await Bun.file(join(dir, "vcs.log")).text()).toContain("-top tb_x");
		expect(await Bun.file(join(dir, "dump.tcl")).text()).toContain(
			'fsdbDumpvars 0 tb_x "+all"',
		);
	});

	test("run_verdi runs in its own dir, exports the env, defaults -top", async () => {
		const ws = await makeWorkspace(
			CASES_TS.replace(
				"tools: [VcsTool()],",
				'tools: [VcsTool({ top: "tb_x", wave: true })],',
			),
		);
		const run = await runDtsim(ws, ["run", "test_hello_world", "-s", "1"]);
		expect(run.code).toBe(0);
		const script = [
			...new Bun.Glob("**/run_verdi").scanSync(
				join(ws.out, "test_hello_world"),
			),
		][0] as string;
		const text = await Bun.file(
			join(ws.out, "test_hello_world", script),
		).text();
		expect(text).toContain('cd "$(dirname "$0")"');
		expect(text).toContain("-top tb_x");
		expect(text).toContain("export DTSIM_CASE=");
		expect(text).toContain("-dbdir");
		expect(text).toContain("simv.daidir");
	});

	test("casePlusarg renames or drops the case plusarg", async () => {
		const renamed = await makeWorkspace(
			CASES_TS.replace(
				"tools: [VcsTool()],",
				'tools: [VcsTool({ casePlusarg: "DTSIM_TEST" })],',
			),
		);
		expect(
			(await runDtsim(renamed, ["run", "test_hello_world", "-s", "1"])).code,
		).toBe(0);
		const log = await Bun.file(
			join(renamed.out, "test_hello_world", "1", "sim.log"),
		).text();
		expect(log).toContain("+DTSIM_TEST=test_hello_world");
		expect(log).not.toContain("+TEST=");
		const none = await makeWorkspace(
			CASES_TS.replace(
				"tools: [VcsTool()],",
				"tools: [VcsTool({ casePlusarg: false })],",
			),
		);
		expect(
			(await runDtsim(none, ["run", "test_hello_world", "-s", "1"])).code,
		).toBe(0);
		expect(
			await Bun.file(join(none.out, "test_hello_world", "1", "sim.log")).text(),
		).not.toContain("TEST=test_hello_world");
	});

	test("case filelists append to the workspace's; a missing one fails early", async () => {
		const ws = await makeWorkspace(
			CASES_TS.replace(
				'export const smoke = Case("test_quick_smoke", {',
				'export const smoke = Case("test_quick_smoke", {\n\tfilelists: ["extra.f"],',
			),
		);
		const missing = await runDtsim(ws, ["run", "test_quick_smoke", "-s", "1"]);
		expect(missing.code).not.toBe(0);
		expect(missing.stderr).toContain("filelist not found");
		await Bun.write(join(ws.verify, "extra.f"), "rtl/extra.sv\n");
		expect(
			(await runDtsim(ws, ["run", "test_quick_smoke", "-s", "1"])).code,
		).toBe(0);
		const vcsLog = await Bun.file(
			join(ws.out, "test_quick_smoke", "vcs.log"),
		).text();
		expect(vcsLog).toMatch(
			/-f \S*dt\/config\/file\.lst -f \S*dt\/config\/extra\.f/,
		);
	});
});

describe("verilator backend", () => {
	test("default top is tb_top", async () => {
		const body = CASES_TS.replace(
			"tools: [VcsTool()],",
			"tools: [VerilatorTool()],",
		).replace(
			'import { DefaultGrader, VcsTool } from "./.dtsim/dsl/index.ts";',
			'import { DefaultGrader, VerilatorTool } from "./.dtsim/dsl/index.ts";',
		);
		const ws = await makeWorkspace(body);
		const run = await runDtsim(ws, ["run", "test_hello_world", "-s", "2"]);
		expect(run.code).toBe(0);
		const dir = join(ws.out, "test_hello_world");
		expect(await Bun.file(join(dir, "obj_dir", "Vtb_top")).exists()).toBe(true);
		expect(await Bun.file(join(dir, "run_compile")).text()).toContain(
			"'--top-module' 'tb_top'",
		);
	});

	test("wave uses the default tb_top bind target", async () => {
		const body = CASES_TS.replace(
			"tools: [VcsTool()],",
			"tools: [VerilatorTool({ wave: true })],",
		).replace(
			'import { DefaultGrader, VcsTool } from "./.dtsim/dsl/index.ts";',
			'import { DefaultGrader, VerilatorTool } from "./.dtsim/dsl/index.ts";',
		);
		const ws = await makeWorkspace(body);
		const wave = await runDtsim(ws, ["run", "test_hello_world"]);
		expect(wave.code).toBe(0);
		expect(
			await Bun.file(join(ws.out, "test_hello_world", "dtsim_wave.sv")).text(),
		).toContain("bind tb_top");
	});

	test("compile produces an executable, sim grades its stdout log", async () => {
		const body = CASES_TS.replace(
			"tools: [VcsTool()],",
			'tools: [VerilatorTool({ top: "tb_top" })],',
		).replace(
			'import { DefaultGrader, VcsTool } from "./.dtsim/dsl/index.ts";',
			'import { DefaultGrader, VerilatorTool } from "./.dtsim/dsl/index.ts";',
		);
		const ws = await makeWorkspace(body);
		const result = await runDtsim(ws, ["run", "test_hello_world", "-s", "11"]);
		expect(result.code).toBe(0);
		const caseDir = join(ws.out, "test_hello_world");
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

describe("several tools", () => {
	const body = CASES_TS.replace(
		'import { DefaultGrader, VcsTool } from "./.dtsim/dsl/index.ts";',
		'import { DefaultGrader, VcsTool, VerilatorTool } from "./.dtsim/dsl/index.ts";',
	)
		.replace(
			"tools: [VcsTool()],",
			'tools: [VcsTool(), VerilatorTool({ top: "tb_top", wave: true })],',
		)
		.replace(
			"export default Workspace({",
			`export const vcsOnly = Case("vcs_only", { tools: ["vcs"] });
export const split = Case("split", {
	simArgs: ["+both"],
	byTool: { verilator: { simArgs: ["+vl_only"] } },
});
export default Workspace([], (mode) => {
	const opts = {`,
		)
		.replace(
			"\tgroups: [base, cosim],\n});",
			`\tgroups: [base, cosim],
	};
	// Tool forcing is config-owned: put the requested backend first so the
	// auto-fallback picks it.
	if (process.env.SIM_TOOL) {
		const i = opts.tools.findIndex((t) => t.name === process.env.SIM_TOOL);
		if (i > 0) opts.tools = [opts.tools[i], ...opts.tools.filter((_, j) => j !== i)];
	}
	return opts;
});`,
		);

	test("the factory picks the backend, byTool adds its options, outputs split per tool", async () => {
		const ws = await makeWorkspace(body);
		const vcs = await runDtsim(ws, ["run", "split", "-s", "3"]);
		expect(vcs.code).toBe(0);
		const vcsLog = await Bun.file(
			join(ws.out, "vcs", "split", "3", "sim.log"),
		).text();
		expect(vcsLog).toContain("mock simv");
		expect(vcsLog).toContain("+both");
		expect(vcsLog).not.toContain("+vl_only");

		const vl = await runDtsim(ws, ["run", "split", "-s", "3"], {
			SIM_TOOL: "verilator",
		});
		expect(vl.code).toBe(0);
		const dir = join(ws.out, "verilator", "split");
		const vlLog = await Bun.file(join(dir, "3", "sim.log")).text();
		expect(vlLog).toContain("mock verilator sim");
		expect(vlLog).toContain("+both");
		expect(vlLog).toContain("+vl_only");
		// --wave on Verilator: --trace-fst plus a dump module bound into the top.
		expect(await Bun.file(join(dir, "run_compile")).text()).toContain(
			"--trace-fst",
		);
		const dump = await Bun.file(join(dir, "dtsim_wave.sv")).text();
		expect(dump).toContain("$dumpvars(0, tb_top)");
		expect(dump).toContain("bind tb_top dtsim_wave");
	});

	test("a case limited by tools is refused by run and skipped by plan", async () => {
		const ws = await makeWorkspace(body);
		const run = await runDtsim(ws, ["run", "vcs_only"], {
			SIM_TOOL: "verilator",
		});
		expect(run.code).not.toBe(0);
		expect(run.stderr).toContain("vcs_only does not run on verilator");
		const plan = await runDtsim(ws, ["plan", "*"], {
			SIM_TOOL: "verilator",
		});
		expect(plan.code).toBe(0);
		expect(plan.stdout).toContain("Skipped (not for verilator): vcs_only");
		// An unrecognized tool name is ignored by the config, so the
		// auto-fallback (vcs) is used and the command still works.
		const bad = await runDtsim(ws, ["list"], { SIM_TOOL: "xcelium" });
		expect(bad.code).toBe(0);
	});
});

describe("user-registered backend", () => {
	test("a workspace can ship its own simulator plugin", async () => {
		const body = CASES_TS.replace(
			'import { Case, Group, WaiveRule, Workspace } from "./.dtsim/dsl/index.ts";',
			`import { Case, Group, WaiveRule, Workspace, defineTool } from "./.dtsim/dsl/index.ts";
const echoTool = defineTool({
	name: "echo-sim",
	passthrough: ["PATH"],
	compileErrors: [/Error/],
	simErrors: [/Error/],
	compile(ctx) {
		return { argv: ["bash", "-c", "echo built > built.txt"], cwd: ctx.dir, log: ctx.dir + "/compile.log", logMode: "tee", executable: ctx.dir + "/built.txt" };
	},
	simulate(ctx) {
		return { argv: ["bash", "-c", "echo TEST PASSED"], cwd: ctx.dir, log: ctx.dir + "/sim.log", logMode: "tee" };
	},
});`,
		).replace("tools: [VcsTool()],", "tools: [echoTool],");
		const ws = await makeWorkspace(body);
		const result = await runDtsim(ws, ["run", "test_hello_world", "-s", "21"]);
		expect(result.code).toBe(0);
		const caseDir = join(ws.out, "test_hello_world");
		expect(await Bun.file(join(caseDir, "built.txt")).exists()).toBe(true);
		expect(await Bun.file(join(caseDir, "21", "sim.log")).text()).toContain(
			"TEST PASSED",
		);
	});
});
