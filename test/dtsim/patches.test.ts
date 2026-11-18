import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CASES_TS, makeWorkspace, runDtsim } from "./helpers.ts";

const withPatches = (decl: string, list: string) =>
	CASES_TS.replace(
		'import { Case, Group, Subcase, WaiveRule, Workspace } from "./.dtsim/dsl/index.ts";',
		`import { Case, Group, Subcase, WaiveRule, Workspace } from "./.dtsim/dsl/index.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
${decl}`,
	).replace(
		'filelist: "file.lst",',
		`filelist: "file.lst", patches: [${list}],`,
	);

describe("patch callbacks", () => {
	test("each compile calls the patches with case options and child env", async () => {
		const ws = await makeWorkspace(
			withPatches(
				`const record = (ctx) => writeFileSync(join(ctx.dir, "patch.json"), JSON.stringify({
	caseId: ctx.caseId, defines: ctx.caseOpts.defines, bar: ctx.caseOpts.env.BAR_CFG,
	envOutput: ctx.env.output_dir, dirIsOutput: ctx.dir === ctx.env.output_dir,
	expanded: ctx.expand("\${case}@\${tool}"), resolved: ctx.resolvePath("\${workspace}/x"),
}));`,
				"record",
			),
		);
		const result = await runDtsim(ws, ["run", "test_bar_basic", "-s", "1"]);
		expect(result.code).toBe(0);
		const seen = JSON.parse(
			await Bun.file(join(ws.out, "test_bar_basic", "patch.json")).text(),
		);
		expect(seen.caseId).toBe("test_bar_basic");
		expect(seen.defines).toEqual(["NUM=1"]);
		expect(seen.bar).toBe("basic");
		expect(seen.dirIsOutput).toBe(true);
		expect(seen.expanded).toBe("test_bar_basic@vcs");
		expect(seen.resolved).toBe(join(ws.root, "x"));
	});

	test("a throwing patch fails the compile before the tool runs", async () => {
		const ws = await makeWorkspace(
			withPatches(
				'function brokenDeck() { throw new Error("deck missing"); }',
				"brokenDeck",
			),
		);
		const result = await runDtsim(ws, ["run", "test_hello_world", "-s", "1"]);
		expect(result.code).toBe(1);
		const caseDir = join(ws.out, "test_hello_world");
		expect(existsSync(join(caseDir, "vcs.log"))).toBe(false);
		const error = await Bun.file(join(caseDir, "error.txt")).text();
		expect(error).toContain("phase: patch");
		expect(error).toContain("patch #1 (brokenDeck) threw");
		expect(error).toContain("deck missing");
	});
});
