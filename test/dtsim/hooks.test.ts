import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CASES_TS, makeWorkspace, runDtsim } from "./helpers.ts";

/** CASES_TS with `decl` added after the imports and `hooks: { ... }` set. */
const withHooks = (decl: string, hooks: string) =>
	CASES_TS.replace(
		'import { Case, Group, WaiveRule, Workspace } from "./.dtsim/dsl/index.ts";',
		`import { Case, Group, WaiveRule, Workspace } from "./.dtsim/dsl/index.ts";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
${decl}`,
	).replace("waive: [", `hooks: { ${hooks} },\n\twaive: [`);

describe("hooks", () => {
	test("every stage runs in order with one context shape", async () => {
		const ws = await makeWorkspace(
			withHooks(
				`const trace = (ctx) => appendFileSync(process.env.DTSIM_TEST_TRACE, JSON.stringify({
	stage: ctx.stage, caseId: ctx.caseId, seed: ctx.seed, status: ctx.status,
	log: ctx.log.split(/[\\\\/]/).at(-1), dirIsOutput: ctx.dir === ctx.env.output_dir,
	defines: ctx.caseOpts.defines, bar: ctx.caseOpts.env.BAR_CFG,
	expanded: ctx.expand("\${case}@\${tool}"),
}) + "\\n");`,
				["preCompile", "postCompile", "preSim", "postSim", "onResult"]
					.map((s) => `${s}: trace`)
					.join(", "),
			),
		);
		const trace = join(ws.dir, "trace.jsonl");
		// The hook runs in the dtsim process, so it sees dtsim's own env.
		const result = await runDtsim(ws, ["run", "test_bar_basic", "-s", "9"], {
			DTSIM_TEST_TRACE: trace,
		});
		expect(result.code).toBe(0);
		const seen = (await Bun.file(trace).text())
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(seen.map((s) => s.stage)).toEqual([
			"preCompile",
			"postCompile",
			"preSim",
			"postSim",
			"onResult",
		]);
		expect(
			seen.every((s) => s.dirIsOutput && s.caseId === "test_bar_basic"),
		).toBe(true);
		expect(seen[0]).toMatchObject({
			log: "vcs.log",
			defines: ["NUM=1"],
			bar: "basic",
		});
		expect(seen[0].seed).toBeUndefined();
		expect(seen[2]).toMatchObject({ seed: "9", log: "sim.log" });
		expect(seen[4]).toMatchObject({ status: "PASS" });
		expect(seen[0].expanded).toBe("test_bar_basic@vcs");
	});

	test("preCompile runs before the tool; a throw stops the compile", async () => {
		const ws = await makeWorkspace(
			withHooks(
				'function brokenDeck() { throw new Error("deck missing"); }',
				"preCompile: [brokenDeck]",
			),
		);
		const result = await runDtsim(ws, ["run", "test_hello_world", "-s", "1"]);
		expect(result.code).toBe(1);
		const caseDir = join(ws.out, "test_hello_world");
		expect(existsSync(join(caseDir, "vcs.log"))).toBe(false);
		const error = await Bun.file(join(caseDir, "error.txt")).text();
		expect(error).toContain("phase: hook");
		expect(error).toContain("preCompile hook #1 (brokenDeck) threw");
		expect(error).toContain("deck missing");
	});

	test("ctx.sh logs output and a non-zero exit fails the seed", async () => {
		const ws = await makeWorkspace(
			withHooks(
				'const fw = async (ctx) => { await ctx.sh("echo building $DTSIM_CASE"); await ctx.sh("echo late-err >&2; exit 3"); };',
				"preSim: fw",
			),
		);
		const result = await runDtsim(ws, ["run", "test_hello_world", "-s", "31"]);
		expect(result.code).toBe(1);
		const seedDir = join(ws.out, "test_hello_world", "31");
		const log = await Bun.file(join(seedDir, "hook-preSim.log")).text();
		expect(log).toContain("building test_hello_world");
		expect(log).toContain("late-err");
		expect(log).toContain("sh exited 3");
		expect(await Bun.file(join(seedDir, "error.txt")).text()).toContain(
			"phase: hook",
		);
		expect(result.stderr).not.toContain("write after end");
	});

	test("onGrade replaces keyword grading; onResult cannot change the result", async () => {
		const ws = await makeWorkspace(
			withHooks(
				'const grade = (ctx) => (ctx.seed === "32" ? "PASS" : "FAIL");\nconst boom = () => { throw new Error("db down"); };',
				"onGrade: grade, onResult: boom",
			),
		);
		// The sim log has no TEST PASSED, but the hook's verdict wins.
		const result = await runDtsim(ws, ["run", "test_hello_world", "-s", "32"], {
			DTSIM_MOCK_SIMV_FAIL: "1",
		});
		expect(result.code).toBe(0);
		const seedDir = join(ws.out, "test_hello_world", "32");
		expect(existsSync(join(seedDir, "PASS"))).toBe(true);
		expect(await Bun.file(join(seedDir, "hook-onResult.log")).text()).toContain(
			"db down",
		);
		// results --recheck grades with the same hook, not with keywords.
		const recheck = await runDtsim(ws, [
			"results",
			"--dir",
			join(ws.out, "test_hello_world"),
			"--recheck",
		]);
		expect(recheck.code).toBe(0);
		expect(recheck.stdout).toContain("PASS=1");
	});
});
