import { describe, expect, test } from "bun:test";
import { CASES_TS, makeWorkspace, runDtsim } from "./helpers.ts";

// A Workspace factory computes the options from the mode: it defaults
// DTSIM_WAVE (which the VCS backend reads at invocation — dump.tcl is written
// only when wave is on) and computes maxSlots, which lands in the regression
// header. The registry is the first argument ([] here).
const withFactory = CASES_TS.replace(
	"export default Workspace({",
	`export default Workspace([], (mode) => {
	if (process.env.DTSIM_WAVE === undefined)
		process.env.DTSIM_WAVE = mode === "run" ? "1" : "0";
	return {`,
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
		const r = await runDtsim(ws, ["run", "test_hello_world", "-s", "1"], {});
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
});
