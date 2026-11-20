import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CASES_TS, makeWorkspace, runDtsim } from "./helpers.ts";

// A Workspace factory computes the options from the mode: it enables the wave
// option on the VCS backend for a single run (dump.tcl is written only when
// wave is on) and computes maxSlots, which lands in the regression header.
// The registry is the first argument ([] here).
const withFactory = CASES_TS.replace(
	"export default Workspace({",
	"export default Workspace([], (mode) => {\n\treturn {",
)
	.replace(
		"\ttools: [VcsTool()],",
		'\ttools: [VcsTool({ wave: mode === "run" })],',
	)
	.replace(
		"\ttask: { maxSlots: 4, maxCompiles: 2 },",
		"\ttask: { maxSlots: mode === 'regr' ? 7 : 3, maxCompiles: 2 },",
	)
	.replace(
		"\tgroups: [base, cosim],\n});",
		"\tgroups: [base, cosim],\n\t};\n});",
	);

describe("Workspace factory", () => {
	test("run mode defaults wave on, so the VCS backend writes dump.tcl", async () => {
		const ws = await makeWorkspace(withFactory);
		const r = await runDtsim(ws, ["run", "test_hello_world"], {});
		expect(r.code).toBe(0);
		expect(
			[...new Bun.Glob("**/dump.tcl").scanSync(ws.dir)].length,
		).toBeGreaterThan(0);
	});

	test("regr mode defaults wave off and computes maxSlots", async () => {
		const ws = await makeWorkspace(withFactory);
		const r = await runDtsim(ws, ["regr", "base", "--plain"], {});
		expect(r.code).toBe(0);
		expect([...new Bun.Glob("**/dump.tcl").scanSync(ws.dir)]).toHaveLength(0);
		// the factory's maxSlots (7) reaches the Regression header
		expect(r.stdout).toContain("7 (compile 2)");
	});

	test("maxSlots as a callback is evaluated from the resolved launcher", async () => {
		const body = CASES_TS.replace(
			"task: { maxSlots: 4, maxCompiles: 2 },",
			'task: { maxSlots: ({ launcher }) => (launcher === "local" ? 7 : 2), maxCompiles: 2 },',
		);
		const ws = await makeWorkspace(body);
		// mockEnv forces DTSIM_TASK_TYPE=local, so the callback yields 7.
		const r = await runDtsim(ws, ["regr", "base", "--plain"], {});
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("7 (compile 2)");
	});
	test("a registered wave option is parsed before the workspace factory", async () => {
		const body = CASES_TS.replace(
			"export default Workspace({",
			`export default Workspace(
	[{ name: "WAVE", flags: "--wave", set: (v) => (v ? "1" : undefined) }],
	(mode) => ({`,
		)
			.replace(
				"tools: [VcsTool()],",
				'tools: [VcsTool({ wave: process.env.WAVE === "1" })],',
			)
			.replace(
				"\tgroups: [base, cosim],\n});",
				"\tgroups: [base, cosim],\n\t})\n);",
			);
		const ws = await makeWorkspace(body);
		const on = await runDtsim(ws, ["run", "test_hello_world", "--wave"]);
		expect(on.code).toBe(0);
		expect(
			await Bun.file(join(ws.out, "test_hello_world", "dump.tcl")).exists(),
		).toBe(true);
	});
});
