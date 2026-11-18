import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	compileKey,
	loadWorkspace,
	mergeCase,
	resolveGroup,
} from "../../src/dtsim/core/config.ts";
import { buildChildEnv } from "../../src/dtsim/core/env.ts";
import { planGroups } from "../../src/dtsim/core/regression.ts";
import { DSL_FILES } from "../../src/dtsim/dsl/embedded.generated.ts";
import type { DefaultGraderDef } from "../../src/dtsim/dsl/index.ts";
import { VcsTool } from "../../src/dtsim/dsl/index.ts";
import { CASES_TS, makeWorkspace, runDtsim } from "./helpers.ts";

describe("dsl merge", () => {
	test("bare case gets bareDefaults, explicit subcase does not", async () => {
		const ws = await loadWorkspace({ config: (await makeWorkspace()).config });
		const bare = mergeCase(ws, "test_hello_world");
		expect(bare.compileArgs).toEqual(["+nospecify", "+notimingcheck"]);
		expect(bare.defines).toEqual(["NUM=1"]);
		expect(bare.random).toBe(false);

		const cosim = mergeCase(ws, "test_hello_world.cosim");
		expect(cosim.compileArgs).toEqual([
			// biome-ignore lint/suspicious/noTemplateCurlyInString: dtsim placeholder, expanded at run time
			"-ad=${verify}/abc",
			"-debug_access+all",
		]);
		expect(cosim.defines).toEqual(["NUM=1"]);
		expect(cosim.env.INPUT).toBe("input.spf");
	});

	test("a derived case's extended grader keeps the base keywords", async () => {
		const ws = await loadWorkspace({ config: (await makeWorkspace()).config });
		const timing = mergeCase(ws, "test_hello_world.timing");
		const opts = (timing.grader as DefaultGraderDef).opts;
		expect(opts.error).toEqual(["Error:", "re:ERROR:.*timing violation"]);
		expect(opts.waive?.length).toBe(2);
		// Bare cases without their own grader get the workspace one.
		expect(mergeCase(ws, "test_quick_smoke").grader).toBe(ws.grader);
	});

	test("subcase env merges with base env, sim scope kept", async () => {
		const ws = await loadWorkspace({ config: (await makeWorkspace()).config });
		const c = mergeCase(ws, "test_bar_basic.cosim");
		expect(c.env.BAR_CFG).toBe("basic");
		expect(c.env.INPUT).toBe("input.spf");
		expect(c.env.SIM_TRACE).toEqual({ value: "1", scope: "sim" });
	});

	test("unknown case and unknown suffix fail", async () => {
		const ws = await loadWorkspace({ config: (await makeWorkspace()).config });
		expect(() => mergeCase(ws, "nope")).toThrow("not found");
		expect(() => mergeCase(ws, "test_hello_world.nope")).toThrow("not found");
		expect(() => resolveGroup(ws, "nope")).toThrow("unknown group");
	});

	test("compile key ignores sim-only env and sim args", async () => {
		const ws = await loadWorkspace({ config: (await makeWorkspace()).config });
		const bare = mergeCase(ws, "test_hello_world");
		const same = mergeCase(ws, "test_hello_world");
		same.simArgs.push("+OTHER=1");
		same.env.SIM_TRACE = { value: "9", scope: "sim" };
		expect(compileKey(same, ws.tool)).toBe(compileKey(bare, ws.tool));
		same.env.OTHER = "1";
		expect(compileKey(same, ws.tool)).not.toBe(compileKey(bare, ws.tool));
	});

	test("compile key keeps compileArgs order", async () => {
		const ws = await loadWorkspace({ config: (await makeWorkspace()).config });
		const a = mergeCase(ws, "test_hello_world");
		const b = mergeCase(ws, "test_hello_world");
		a.compileArgs = ["-CFLAGS", "-O2", "-LDFLAGS", "-pthread"];
		b.compileArgs = ["-CFLAGS", "-pthread", "-LDFLAGS", "-O2"];
		expect(compileKey(a, ws.tool)).not.toBe(compileKey(b, ws.tool));
	});

	test("regression groups split on compile env, keep group order", async () => {
		const ws = await loadWorkspace({ config: (await makeWorkspace()).config });
		const groups = planGroups(ws, "cosim");
		expect(groups.length).toBe(2);
		for (const g of groups) expect(g.cases.length).toBe(1);
	});

	test("a backend compileKey decides which cases share a build", async () => {
		// This backend compiles nothing from defines or env: one build for all.
		const body = CASES_TS.replace(
			'import { Case, Group, WaiveRule, Workspace } from "./.dtsim/dsl/index.ts";',
			`import { Case, Group, WaiveRule, Workspace, defineTool } from "./.dtsim/dsl/index.ts";
const shared = defineTool({
	name: "shared-sim", passthrough: [],
	compileErrors: [], simErrors: [],
	compileKey: (c) => JSON.stringify(c.toolOptions),
	compile: (ctx) => ({ argv: ["true"], cwd: ctx.dir, log: ctx.dir + "/c.log", logMode: "tee" }),
	simulate: (ctx) => ({ argv: ["true"], cwd: ctx.dir, log: ctx.dir + "/s.log", logMode: "tee" }),
});`,
		).replace("tool: VcsTool(),", "tool: shared,");
		const ws = await makeWorkspace(body);
		const vcsPlan = await runDtsim(await makeWorkspace(), ["plan", "base"]);
		expect(vcsPlan.stdout).toContain("in 3 compile groups");
		const plan = await runDtsim(ws, ["plan", "base"]);
		expect(plan.code).toBe(0);
		expect(plan.stdout).toContain("in 1 compile group\n");
	});

	test("deny list rejects a case assignment when that case is used", async () => {
		const body = CASES_TS.replace(
			'BAR_CFG: "basic",',
			'BAR_CFG: "basic", LD_PRELOAD: "evil.so",',
		);
		const ws = await loadWorkspace({
			config: (await makeWorkspace(body)).config,
		});
		expect(() => mergeCase(ws, "test_hello_world")).not.toThrow();
		expect(() => mergeCase(ws, "test_bar_basic")).toThrow("deny list");
		// Derived cases inherit the assignment and fail the same way.
		expect(() => mergeCase(ws, "test_bar_basic.cosim")).toThrow("deny list");
	});
});

// Shared with the generated config below, which records lazy evaluations here.
declare global {
	var dtsimTreeCalls: string[] | undefined;
}

describe("case tree", () => {
	const TREE = `
import { Case, VcsTool, Workspace } from "./.dtsim/dsl/index.ts";
const calls = (globalThis.dtsimTreeCalls ??= []);
export const top = Case("t", { defines: ["A"], simArgs: ["+a"], env: { X: "1" } });
const fast = top.SubCase("fast", { defines: ["FAST"], env: { Y: "2" } });
fast.SubCase("ss", (parent) => {
	calls.push("ss");
	return { simArgs: [\`+n=\${parent.defines?.length}\`], env: { X: "3" } };
});
top.SubCase("slow", () => {
	calls.push("slow");
	throw new Error("slow opts should never be evaluated");
});
export default Workspace({ tool: VcsTool() });
`;

	test("multi-level SubCase merges every level; only the root is exported", async () => {
		const ws = await loadWorkspace({
			config: (await makeWorkspace(TREE)).config,
		});
		expect([...ws.cases.keys()]).toEqual(["t"]);
		const c = mergeCase(ws, "t.fast.ss");
		expect(c.base).toBe("t");
		expect(c.suffix).toBe("ss");
		expect(c.defines).toEqual(["A", "FAST"]);
		expect(c.simArgs).toEqual(["+a", "+n=2"]);
		expect(c.env).toEqual({ X: "3", Y: "2" });
		expect(() => mergeCase(ws, "t.ss")).toThrow("not found");
	});

	test("descendants walks the tree without evaluating options", async () => {
		globalThis.dtsimTreeCalls = [];
		const ws = await loadWorkspace({
			config: (await makeWorkspace(TREE)).config,
		});
		const top = ws.cases.get("t");
		expect(top?.descendants().map((c) => c.id)).toEqual([
			"t.fast",
			"t.fast.ss",
			"t.slow",
		]);
		expect(globalThis.dtsimTreeCalls).toEqual([]);
	});

	test("groups take case objects and id patterns, in member order", async () => {
		const body = TREE.replace(
			'import { Case, VcsTool, Workspace } from "./.dtsim/dsl/index.ts";',
			'import { Case, Group, VcsTool, Workspace } from "./.dtsim/dsl/index.ts";',
		)
			.replace(
				'throw new Error("slow opts should never be evaluated");',
				"return {};",
			)
			.replace(
				"export default Workspace({ tool: VcsTool() });",
				`const extra = top.SubCase("extra");
export default Workspace({ tool: VcsTool(), groups: [
	Group("objs", [extra, fast]),
	Group("one", ["t.*"]),
	Group("deep", ["t.**", "t.fast"]),
	Group("none", ["t.*.nope"]),
	Group("stray", [Case("not_exported")]),
] });`,
			);
		const ws = await loadWorkspace({
			config: (await makeWorkspace(body)).config,
		});
		expect(resolveGroup(ws, "objs")).toEqual(["t.extra", "t.fast"]);
		// `*` stays inside one segment, `**` crosses; tree order, no duplicates.
		expect(resolveGroup(ws, "one")).toEqual(["t.fast", "t.slow", "t.extra"]);
		expect(resolveGroup(ws, "deep")).toEqual([
			"t.fast",
			"t.fast.ss",
			"t.slow",
			"t.extra",
		]);
		expect(() => resolveGroup(ws, "none")).toThrow(
			'pattern "t.*.nope" matches no case',
		);
		expect(() => resolveGroup(ws, "stray")).toThrow(
			"not part of an exported case tree",
		);
	});

	test("function options run only for the case being used, once", async () => {
		globalThis.dtsimTreeCalls = [];
		const ws = await loadWorkspace({
			config: (await makeWorkspace(TREE)).config,
		});
		expect(globalThis.dtsimTreeCalls).toEqual([]);
		mergeCase(ws, "t.fast.ss");
		mergeCase(ws, "t.fast.ss");
		expect(globalThis.dtsimTreeCalls).toEqual(["ss"]);
		expect(() => mergeCase(ws, "t.slow")).toThrow("never be evaluated");
		expect(globalThis.dtsimTreeCalls).toEqual(["ss", "slow"]);
	});

	test("duplicate suffix under one parent fails at definition", async () => {
		const body = TREE.replace(
			"export default",
			'top.SubCase("fast");\nexport default',
		);
		const ws = await makeWorkspace(body);
		await expect(loadWorkspace({ config: ws.config })).rejects.toThrow(
			'already has subcase "fast"',
		);
	});

	test("dtsim list prints derived ids under their parent", async () => {
		const result = await runDtsim(await makeWorkspace(TREE), ["list"]);
		expect(result.code).toBe(0);
		expect(result.stdout.split("\n").slice(0, 4)).toEqual([
			"t",
			"├─ t.fast",
			"│  └─ t.fast.ss",
			"└─ t.slow",
		]);
	});

	test("a tool option that is not a tool fails at load", async () => {
		const body = CASES_TS.replace("tool: VcsTool(),", 'tool: "xcelium",');
		const ws = await makeWorkspace(body);
		await expect(loadWorkspace({ config: ws.config })).rejects.toThrow(
			"must be a tool",
		);
	});
});

describe("environment isolation", () => {
	test("unlisted parent variables never reach the child", async () => {
		const ws = await loadWorkspace({ config: (await makeWorkspace()).config });
		const c = mergeCase(ws, "test_bar_basic.cosim");
		const built = buildChildEnv({
			phase: "sim",
			tool: VcsTool(),
			passthrough: ws.passthrough,
			deny: ws.deny,
			caseEnv: c.env,
			injected: { output_dir: "/tmp/x" },
			expand: (v) => v,
			parent: {
				PATH: "/bin",
				UNRELATED_SECRET: "1",
				LD_PRELOAD: "evil.so",
				DTSIM_MOCK_SIMV_FAIL: "1",
				DTSIM_TASK_TYPE: "local",
			},
		});
		expect(built.env.PATH).toBe("/bin");
		expect(built.env.UNRELATED_SECRET).toBeUndefined();
		expect(built.env.LD_PRELOAD).toBeUndefined();
		expect(built.env.DTSIM_TASK_TYPE).toBeUndefined();
		expect(built.env.DTSIM_MOCK_SIMV_FAIL).toBe("1");
		expect(built.env.INPUT).toBe("input.spf");
		expect(built.env.SIM_TRACE).toBe("1");
		expect(built.env.output_dir).toBe("/tmp/x");
	});

	test("compile phase drops sim-scoped variables", async () => {
		const ws = await loadWorkspace({ config: (await makeWorkspace()).config });
		const c = mergeCase(ws, "test_bar_basic");
		const built = buildChildEnv({
			phase: "compile",
			tool: VcsTool(),
			passthrough: [],
			deny: [],
			caseEnv: c.env,
			injected: {},
			expand: (v) => v,
			parent: {},
		});
		expect(built.env.BAR_CFG).toBe("basic");
		expect(built.env.SIM_TRACE).toBeUndefined();
	});

	test("dtsim env CLI lists sources without running a simulator", async () => {
		const ws = await makeWorkspace();
		const result = await runDtsim(ws, [
			"env",
			"--case",
			"test_bar_basic.cosim",
		]);
		expect(result.code).toBe(0);
		expect(result.stdout).toMatch(/│ case\s+│ INPUT\s/);
		expect(result.stdout).toMatch(/│ inject\s+│ output_dir\s/);
		expect(result.stdout).toMatch(/│ plugin\s+│ PATH\s/);
	});
});

describe("materialized dsl", () => {
	test("config can import .dtsim/dsl/index.ts after load", async () => {
		const ws = await makeWorkspace();
		await loadWorkspace({ config: ws.config });
		const dsl = join(ws.verify, ".dtsim", "dsl", "index.ts");
		expect(await Bun.file(dsl).exists()).toBe(true);
		const mod = await import(dsl);
		const c = mod.Case("x_case", {});
		expect(c.kind).toBe("dtsim-case");
	});

	test("embedded dsl matches the source files", async () => {
		const dir = join(import.meta.dir, "..", "..", "src", "dtsim", "dsl");
		const sources: Record<string, string> = {};
		for (const rel of new Bun.Glob("**/*.ts").scanSync(dir)) {
			const path = rel.replaceAll("\\", "/");
			if (path !== "embedded.generated.ts") {
				sources[path] = await Bun.file(join(dir, rel)).text();
			}
		}
		expect(DSL_FILES).toEqual(sources);
	});
});
