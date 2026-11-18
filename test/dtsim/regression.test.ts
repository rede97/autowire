import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CASES_TS, makeWorkspace, runDtsim, seedDirs } from "./helpers.ts";

describe("regression", () => {
	test("plan writes regression.txt without results", async () => {
		const ws = await makeWorkspace();
		const result = await runDtsim(ws, ["plan"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Compile groups");
		const regDir = join(ws.out, "regression");
		expect(await Bun.file(join(regDir, "regression.txt")).exists()).toBe(true);
		expect(await Bun.file(join(regDir, "result.txt")).exists()).toBe(false);
	});

	test("execute: shared compile groups, absolute simv, result tree", async () => {
		const ws = await makeWorkspace();
		const result = await runDtsim(ws, ["regr", "base"]);
		expect(result.code).toBe(0);
		const regDir = join(ws.out, "regression");
		expect(await Bun.file(join(regDir, "compile_g1", "simv")).exists()).toBe(
			true,
		);
		expect(await Bun.file(join(regDir, "result.txt")).exists()).toBe(true);
		expect(result.stdout).toContain("Results");
		// smoke has no defines; hello and bar share NUM=1 but bar adds env.
		const groups = (
			await Bun.file(join(regDir, "regression.txt")).text()
		).match(/Group \d+/g);
		expect(groups?.length).toBe(3);
		const helloSeeds = await seedDirs(join(regDir, "test_hello_world"));
		expect(helloSeeds.length).toBe(1);
		const runSim = await Bun.file(
			join(helloSeeds[0] as string, "run_sim"),
		).text();
		expect(runSim).toContain(join(regDir, "compile_g"));
		expect(runSim).not.toContain("../simv");
		const barSeeds = await seedDirs(join(regDir, "test_bar_basic"));
		const barLog = await Bun.file(
			join(barSeeds[0] as string, "sim.log"),
		).text();
		expect(barLog).toContain("BAR_CFG=basic");
		expect(await Bun.file(join(regDir, "dresults")).exists()).toBe(true);
	});

	test("named group and unknown group", async () => {
		const ws = await makeWorkspace();
		const ok = await runDtsim(ws, ["plan", "cosim"]);
		expect(ok.code).toBe(0);
		expect(ok.stdout).toContain("test_hello_world.cosim");
		const bad = await runDtsim(ws, ["plan", "nope"]);
		expect(bad.code).toBe(1);
		expect(bad.stderr).toContain("unknown group");
	});

	test("seed file: shared seeds, random=false still runs once", async () => {
		const ws = await makeWorkspace();
		const seedFile = join(ws.dir, "seeds.txt");
		await Bun.write(seedFile, "111\n222\n");
		const result = await runDtsim(ws, [
			"regr",
			"base",
			"--seed-file",
			seedFile,
		]);
		expect(result.code).toBe(0);
		const regDir = join(ws.out, "regression");
		expect((await seedDirs(join(regDir, "test_hello_world"))).length).toBe(1);
		expect((await seedDirs(join(regDir, "test_bar_basic"))).length).toBe(2);
		expect((await seedDirs(join(regDir, "test_quick_smoke"))).length).toBe(2);
	});

	test("compile failure skips dependent sims and fails the run", async () => {
		const ws = await makeWorkspace();
		const result = await runDtsim(ws, ["regr", "base"], {
			DTSIM_MOCK_VCS_FAIL: "1",
		});
		expect(result.code).toBe(1);
		const regDir = join(ws.out, "regression");
		const seeds = await seedDirs(join(regDir, "test_hello_world"));
		expect(seeds.length).toBe(1);
		const link = await Bun.file(join(seeds[0] as string, ".result")).exists();
		expect(link).toBe(true);
		expect(result.stdout).toContain("compile failed");
		expect(
			await Bun.file(join(regDir, "compile_g1", "error.txt")).text(),
		).toContain("Error-[COMPFAIL]");
	});

	test("coverage: per-group urg merge, dcov script, failure propagates", async () => {
		const ws = await makeWorkspace();
		const result = await runDtsim(ws, ["regr", "base", "--cov"]);
		expect(result.code).toBe(0);
		const regDir = join(ws.out, "regression");
		expect(
			await Bun.file(
				join(regDir, "compile_g1", "urgReport", "dashboard.html"),
			).exists(),
		).toBe(true);
		expect(existsSync(join(regDir, "compile_g1", "merge.vdb"))).toBe(true);
		expect(await Bun.file(join(regDir, "dcov")).exists()).toBe(true);
		const helloSeeds = await seedDirs(join(regDir, "test_hello_world"));
		const runSim = await Bun.file(
			join(helloSeeds[0] as string, "run_sim"),
		).text();
		expect(runSim).toContain("'-cm_name'");
		expect(runSim).toContain("'test_hello_world_");
		expect(runSim).toContain("-cm_dir");

		const ws2 = await makeWorkspace();
		const failed = await runDtsim(ws2, ["regr", "base", "--cov"], {
			DTSIM_MOCK_URG_FAIL: "1",
		});
		expect(failed.code).toBe(1);
	});

	test("results command reads markers and rechecks logs", async () => {
		const ws = await makeWorkspace();
		await runDtsim(ws, ["regr", "base"]);
		const regDir = join(ws.out, "regression");
		const read = await runDtsim(ws, ["results", "--dir", regDir]);
		expect(read.code).toBe(0);
		expect(read.stdout).toContain("PASS=3");
		const recheck = await runDtsim(ws, [
			"results",
			"--dir",
			regDir,
			"--recheck",
		]);
		expect(recheck.code).toBe(0);
		expect(recheck.stdout).toContain("PASS=3");
	});

	test("label moves the output tree", async () => {
		const ws = await makeWorkspace();
		const result = await runDtsim(ws, ["regr", "base", "-d", "nightly"]);
		expect(result.code).toBe(0);
		expect(
			await Bun.file(
				join(ws.out, "nightly", "regression", "result.txt"),
			).exists(),
		).toBe(true);
	});
});

describe("user hooks", () => {
	test("a failing preSim hook fails the seed and captures its log", async () => {
		const body = CASES_TS.replace(
			"waive: [",
			'hooks: { preSim: Hook("fail_hook.sh") },\n\twaive: [',
		).replace(
			"import { Case, Group, WaiveRule, Workspace }",
			"import { Case, Group, Hook, WaiveRule, Workspace }",
		);
		const ws = await makeWorkspace(body);
		await Bun.write(
			join(ws.verify, "fail_hook.sh"),
			"#!/bin/bash\necho hook exploded\nexit 3\n",
		);
		const result = await runDtsim(ws, ["run", "test_hello_world", "-s", "31"]);
		expect(result.code).toBe(1);
		const seedDir = join(ws.out, "test_hello_world", "31");
		const err = await Bun.file(join(seedDir, "error.txt")).text();
		expect(err).toContain("phase: hook");
		expect(err).toContain("hook exploded");
	});

	test("onGrade replaces the built-in keyword grader", async () => {
		const body = CASES_TS.replace(
			"waive: [",
			'hooks: { onGrade: Hook("grade.sh") },\n\twaive: [',
		).replace(
			"import { Case, Group, WaiveRule, Workspace }",
			"import { Case, Group, Hook, WaiveRule, Workspace }",
		);
		const ws = await makeWorkspace(body);
		await Bun.write(
			join(ws.verify, "grade.sh"),
			"#!/bin/bash\necho PASS\necho detail line\n",
		);
		const result = await runDtsim(ws, ["run", "test_hello_world", "-s", "32"], {
			DTSIM_MOCK_SIMV_FAIL: "1",
		});
		// The sim log has no TEST PASSED, but the hook's verdict wins.
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Result");
	});
});
