import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CASES_TS, makeWorkspace, runDtsim } from "./helpers.ts";

const withHooks = (hooks: string) =>
	CASES_TS.replace(
		"import { Case, Group, WaiveRule, Workspace }",
		"import { Case, Group, Hook, WaiveRule, Workspace }",
	).replace("waive: [", `hooks: { ${hooks} },\n\twaive: [`);

describe("hooks", () => {
	test("every stage runs in order with its phase, case, seed and status", async () => {
		const stages = [
			"preCompile",
			"postCompile",
			"preSim",
			"postSim",
			"onResult",
		];
		const ws = await makeWorkspace(
			withHooks(stages.map((s) => `${s}: Hook("trace.sh")`).join(", ")),
		);
		const trace = join(ws.dir, "trace.log");
		await writeFile(
			join(ws.verify, "trace.sh"),
			`echo "$DTSIM_HOOK $*" >> "${trace.replaceAll("\\", "/")}"\n`,
		);
		const result = await runDtsim(ws, ["run", "test_hello_world", "-s", "9"]);
		expect(result.code).toBe(0);
		const lines = (await Bun.file(trace).text()).trim().split("\n");
		expect(lines.map((l) => l.split(" ")[0])).toEqual(stages);
		expect(lines[2]).toContain("--case test_hello_world --seed 9");
		expect(lines[4]).toContain("--status PASS");
	});

	test("a hook writing stderr after closing stdout fails cleanly", async () => {
		const ws = await makeWorkspace(withHooks('postCompile: Hook("late.sh")'));
		await writeFile(
			join(ws.verify, "late.sh"),
			"echo out\nexec 1>&-\nsleep 0.2\necho late-err >&2\nexit 1\n",
		);
		const result = await runDtsim(ws, ["run", "test_hello_world", "-s", "1"]);
		expect(result.code).toBe(1);
		expect(result.stderr).not.toContain("write after end");
		const log = await Bun.file(
			join(ws.out, "test_hello_world", "hook-postCompile.log"),
		).text();
		expect(log).toContain("late-err");
	});
});
