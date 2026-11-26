import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	buildDirOf,
	CASES_TS,
	makeWorkspace,
	mockEnv,
	runDtsim,
	seedDirs,
} from "./helpers.ts";

describe("regression", () => {
	test("plan writes regression.txt without results", async () => {
		const ws = await makeWorkspace();
		const result = await runDtsim(ws, ["plan"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("compile groups");
		const regDir = join(ws.out, "regression");
		expect(await Bun.file(join(regDir, "regression.txt")).exists()).toBe(true);
		expect(await Bun.file(join(regDir, "result.txt")).exists()).toBe(false);
	});

	test("execute: shared compile groups, absolute simv, result tree", async () => {
		const ws = await makeWorkspace();
		const result = await runDtsim(ws, ["regr", "base"]);
		expect(result.code).toBe(0);
		const regDir = join(ws.out, "regression");
		// Builds are named build<NN>_<top>, never after one of their cases.
		const helloBuild = await buildDirOf(regDir, "test_hello_world");
		expect(helloBuild).toMatch(/compile_build0[1-3]_tb_top$/);
		expect(await Bun.file(join(helloBuild, "simv")).exists()).toBe(true);
		expect(await Bun.file(join(regDir, "result.txt")).exists()).toBe(true);
		expect(result.stdout).toContain("Results");
		// smoke has no defines; hello and bar share NUM=1 but bar adds env.
		const groups = (
			await Bun.file(join(regDir, "regression.txt")).text()
		).match(/^compile /gm);
		expect(groups?.length).toBe(3);
		const helloSeeds = await seedDirs(join(regDir, "test_hello_world"));
		expect(helloSeeds.length).toBe(1);
		const runSim = await Bun.file(
			join(helloSeeds[0] as string, "run_sim"),
		).text();
		expect(runSim).toContain(helloBuild);
		expect(runSim).not.toContain("../simv");
		const barSeeds = await seedDirs(join(regDir, "test_bar_basic"));
		const barLog = await Bun.file(
			join(barSeeds[0] as string, "sim.log"),
		).text();
		expect(barLog).toContain("BAR_CFG=basic");
		const dresults = Bun.spawnSync(["bash", join(regDir, "dresults")], {
			cwd: ws.root,
		});
		expect(dresults.exitCode).toBe(0);
		expect(dresults.stdout.toString()).toContain("PASS=");
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

	test("workspace seeds: shared seeds, random=false still runs once", async () => {
		const ws = await makeWorkspace();
		const result = await runDtsim(ws, ["regr", "base"], {
			DTSIM_TEST_SEEDS: "111,222",
		});
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
			await Bun.file(
				join(await buildDirOf(regDir, "test_hello_world"), "error.txt"),
			).text(),
		).toContain("Error-[COMPFAIL]");
	});

	test("coverage: config cov, scripts written and reported, nothing merged", async () => {
		const ws = await makeWorkspace(
			CASES_TS.replace(
				"tools: [VcsTool()],",
				"tools: [VcsTool()],\n\tcov: true,",
			),
		);
		const result = await runDtsim(ws, ["regr", "base"]);
		expect(result.code).toBe(0);
		const regDir = join(ws.out, "regression");
		const helloBuild = await buildDirOf(regDir, "test_hello_world");
		// dtsim merges nothing; the user runs the scripts.
		expect(existsSync(join(helloBuild, "merge.vdb"))).toBe(false);
		expect(await Bun.file(join(helloBuild, "run_cov_merge")).text()).toContain(
			"'urg' '-dir'",
		);
		expect(existsSync(join(helloBuild, "run_verdi_cov"))).toBe(true);
		// One urg over every build's simv.vdb; extra arguments pass on.
		const all = await Bun.file(join(regDir, "run_cov_merge_all")).text();
		expect(all.match(/'-dir'/g)?.length).toBe(3);
		expect(all).toContain('"$@"');
		// The Coverage lines name each build's database (whole paths, no
		// table wrapping) and the merge scripts.
		const name = helloBuild
			.split(/[\\/]/)
			.pop()
			?.replace(/^compile_/, "");
		expect(result.stdout).toContain("Coverage (not merged by dtsim");
		expect(result.stdout).toContain(
			`  ${name}  ${join(helloBuild, "simv.vdb")}`,
		);
		expect(result.stdout).toContain("run_cov_merge_all");
		const helloSeeds = await seedDirs(join(regDir, "test_hello_world"));
		const runSim = await Bun.file(
			join(helloSeeds[0] as string, "run_sim"),
		).text();
		expect(runSim).toContain("'-cm_name'");
		expect(runSim).toContain("'test_hello_world_");
		expect(runSim).toContain("-cm_dir");
		// Running the written script merges.
		const merge = Bun.spawnSync(["bash", join(helloBuild, "run_cov_merge")], {
			env: mockEnv(),
		});
		expect(merge.exitCode).toBe(0);
		expect(existsSync(join(helloBuild, "merge.vdb"))).toBe(true);
		// run_verdi_cov opens the merged build database once it exists.
		const viewBuild = Bun.spawnSync(
			["bash", join(helloBuild, "run_verdi_cov")],
			{ env: mockEnv() },
		);
		expect(viewBuild.stdout.toString()).toMatch(/-covdir \S*merge\.vdb/);
		// run_verdi_cov_all refuses until run_cov_merge_all has run, then
		// opens the regression-wide merge.
		const early = Bun.spawnSync(["bash", join(regDir, "run_verdi_cov_all")], {
			env: mockEnv(),
		});
		expect(early.exitCode).toBe(1);
		expect(early.stderr.toString()).toContain("run run_cov_merge_all first");
		expect(
			Bun.spawnSync(["bash", join(regDir, "run_cov_merge_all")], {
				env: mockEnv(),
			}).exitCode,
		).toBe(0);
		const viewAll = Bun.spawnSync(["bash", join(regDir, "run_verdi_cov_all")], {
			env: mockEnv(),
		});
		expect(viewAll.exitCode).toBe(0);
		expect(viewAll.stdout.toString()).toMatch(
			/-covdir \S*regression[\\/]merge\.vdb/,
		);
		expect(result.stdout).toContain("run_verdi_cov_all");

		// The DTSIM_COV environment variable is no longer read.
		const ignored = await makeWorkspace();
		const off = await runDtsim(ignored, ["regr", "base"], { DTSIM_COV: "1" });
		expect(off.code).toBe(0);
		expect(off.stdout).not.toContain("run_cov_merge");
		expect(
			existsSync(join(ignored.out, "regression", "run_cov_merge_all")),
		).toBe(false);
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
