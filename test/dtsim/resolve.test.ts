import { describe, expect, test } from "bun:test";
import { CASES_TS, makeWorkspace, runDtsim } from "./helpers.ts";

// onResolve runs after the tool and launcher are resolved: it mutates
// process.env (DTSIM_WAVE here, from the mode) which the VCS backend reads at
// invocation (dump.tcl is written only when wave is on), and returns a slot
// override that lands in the regression header.
const withOnResolve = CASES_TS.replace(
	"task: { maxSlots: 4, maxCompiles: 2 },",
	`task: { maxSlots: 4, maxCompiles: 2 },
	onResolve: ({ mode }) => {
		process.env.DTSIM_WAVE = mode === "run" ? "1" : "0";
		return { maxSlots: mode === "regr" ? 7 : 3 };
	},`,
);

describe("Workspace.onResolve", () => {
	test("run mode defaults wave on, so the VCS backend writes dump.tcl", async () => {
		const ws = await makeWorkspace(withOnResolve);
		const r = await runDtsim(ws, ["run", "test_hello_world", "-s", "1"], {});
		expect(r.code).toBe(0);
		expect(
			[...new Bun.Glob("**/dump.tcl").scanSync(ws.dir)].length,
		).toBeGreaterThan(0);
	});

	test("regr mode defaults wave off and overrides maxSlots", async () => {
		const ws = await makeWorkspace(withOnResolve);
		const r = await runDtsim(ws, ["regr", "base", "--plain"], {});
		expect(r.code).toBe(0);
		expect([...new Bun.Glob("**/dump.tcl").scanSync(ws.dir)]).toHaveLength(0);
		// the returned maxSlots (7) reaches the Regression header
		expect(r.stdout).toContain("7 (compile 2)");
	});
});
