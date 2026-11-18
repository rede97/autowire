import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	compileFingerprint,
	loadWorkspace,
	mergeCase,
	resolveGroup,
} from "../dtsim/core/config.ts";
import { buildChildEnv } from "../dtsim/core/env.ts";
import { registerTool } from "../dtsim/core/registry.ts";
import { planGroups } from "../dtsim/core/regression.ts";
import { vcsTool } from "../dtsim/tools/vcs.ts";
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

	test("grade keywords append across base and subcase", async () => {
		const ws = await loadWorkspace({ config: (await makeWorkspace()).config });
		const timing = mergeCase(ws, "test_hello_world.timing");
		expect(timing.grade.error).toEqual([
			"Error:",
			"re:ERROR:.*timing violation",
		]);
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

	test("fingerprint ignores sim-only env and sim args", async () => {
		const ws = await loadWorkspace({ config: (await makeWorkspace()).config });
		const bare = mergeCase(ws, "test_hello_world");
		const same = mergeCase(ws, "test_hello_world");
		same.simArgs.push("+OTHER=1");
		same.env.SIM_TRACE = { value: "9", scope: "sim" };
		expect(compileFingerprint(same, ws.toolId)).toBe(
			compileFingerprint(bare, ws.toolId),
		);
		same.env.OTHER = "1";
		expect(compileFingerprint(same, ws.toolId)).not.toBe(
			compileFingerprint(bare, ws.toolId),
		);
	});

	test("regression groups split on compile env, keep group order", async () => {
		const ws = await loadWorkspace({ config: (await makeWorkspace()).config });
		const groups = planGroups(ws, "cosim");
		expect(groups.length).toBe(2);
		for (const g of groups) expect(g.cases.length).toBe(1);
	});

	test("deny list rejects a case assignment at load time", async () => {
		const body = CASES_TS.replace(
			'BAR_CFG: "basic",',
			'BAR_CFG: "basic", LD_PRELOAD: "evil.so",',
		);
		const ws = await makeWorkspace(body);
		await expect(loadWorkspace({ config: ws.config })).rejects.toThrow(
			"deny list",
		);
	});

	test("unknown tool id fails before any run", async () => {
		const body = CASES_TS.replace('tool: "vcs"', 'tool: "xcelium"');
		const ws = await makeWorkspace(body);
		await expect(loadWorkspace({ config: ws.config })).rejects.toThrow(
			"unknown tool",
		);
	});

	test("user tools cannot shadow a built-in id", () => {
		expect(() => registerTool(vcsTool)).toThrow("already registered");
	});
});

describe("environment isolation", () => {
	test("unlisted parent variables never reach the child", async () => {
		const ws = await loadWorkspace({ config: (await makeWorkspace()).config });
		const c = mergeCase(ws, "test_bar_basic.cosim");
		const built = buildChildEnv({
			phase: "sim",
			tool: vcsTool,
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
			tool: vcsTool,
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
		expect(result.stdout).toContain("case    INPUT");
		expect(result.stdout).toContain("inject  output_dir");
		expect(result.stdout).toContain("plugin  PATH");
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

	test("embedded dsl matches the source file", async () => {
		const { DSL_SOURCE } = await import("../dtsim/dsl/embedded.generated.ts");
		const source = await Bun.file(
			join(import.meta.dir, "..", "dtsim", "dsl", "index.ts"),
		).text();
		expect(DSL_SOURCE).toBe(source);
	});
});
