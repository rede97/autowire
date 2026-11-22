import { describe, expect, test } from "bun:test";
import {
	loadWorkspace,
	mergeCase,
	resolveGroup,
} from "../../src/dtsim/core/config.ts";
import { makeWorkspace, runDtsim } from "./helpers.ts";

const BODY = `
import { Case, DefaultGrader, Group, VcsTool, Workspace } from "./.dtsim/dsl/index.ts";

// Abstract base: derivation only, never run. Its options are inherited; the
// flag itself is not.
const blk = Case("blk", { abstract: true, random: false, defines: ["COMMON=1"] });
const a = blk.SubCase("a", { defines: ["CASE=a"] });
a.SubCase("x", { defines: ["SUB=x"] });
blk.SubCase("b", { defines: ["CASE=b"] });
export const blkCase = blk;

export default Workspace({
	tools: [VcsTool()],
	filelists: ["file.lst"],
	grader: DefaultGrader(),
	groups: [
		Group("blk", ["blk.*"]),
		Group("direct", ["blk"]),
	],
});
`;

describe("abstract base case", () => {
	test('"*" and a bare base expand to the concrete cases, never the base', async () => {
		const ws = await loadWorkspace({
			config: (await makeWorkspace(BODY)).config,
		});
		// "*" is the former `all`: top-level cases, abstract bases expanded.
		expect(resolveGroup(ws, "*")).toEqual(["blk.a", "blk.b"]);
		// A named group whose member is the bare base expands the same way.
		expect(resolveGroup(ws, "direct")).toEqual(["blk.a", "blk.b"]);
		// A pattern under the base selects the leaves directly.
		expect(resolveGroup(ws, "blk")).toEqual(["blk.a", "blk.b"]);
	});

	test("the flag is node-level: inherited options, not the abstract bit", async () => {
		const ws = await loadWorkspace({
			config: (await makeWorkspace(BODY)).config,
		});
		expect(mergeCase(ws, "blk").abstract).toBe(true);
		const a = mergeCase(ws, "blk.a");
		expect(a.abstract).toBe(false);
		expect(a.defines).toEqual(["COMMON=1", "CASE=a"]);
	});

	test("running the base is refused; list marks it abstract", async () => {
		const ws = await makeWorkspace(BODY);
		const run = await runDtsim(ws, ["run", "blk"]);
		expect(run.code).not.toBe(0);
		expect(run.stderr).toContain("abstract base case");

		const list = await runDtsim(ws, ["list"]);
		expect(list.code).toBe(0);
		expect(list.stdout).toContain("abstract");
	});

	test('there is no reserved "all" group', async () => {
		const ws = await loadWorkspace({
			config: (await makeWorkspace(BODY)).config,
		});
		expect(() => resolveGroup(ws, "all")).toThrow("unknown group");
	});
});

describe("list depth", () => {
	test("default shows 2 levels; --all shows every level; a case scopes", async () => {
		const ws = await makeWorkspace(BODY);
		const def = await runDtsim(ws, ["list"]);
		expect(def.stdout).toContain("blk.a");
		expect(def.stdout).toContain("blk.b");
		// blk.a.x is level 3: hidden by the default depth of 2.
		expect(def.stdout).not.toContain("blk.a.x");

		const all = await runDtsim(ws, ["list", "--all"]);
		expect(all.stdout).toContain("blk.a.x");

		const scoped = await runDtsim(ws, ["list", "blk.a", "--all"]);
		expect(scoped.stdout).toContain("blk.a.x");
		expect(scoped.stdout).not.toContain("blk.b");
	});
});
