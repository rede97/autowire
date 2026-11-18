import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadWorkspace, resolvePath } from "../../src/dtsim/core/config.ts";
import { CASES_TS, makeWorkspace, runDtsim } from "./helpers.ts";

const vars = { verify: "/p/dt/config", workspace: "/p" };

describe("resolvePath", () => {
	test("dtsim variables, shell variables, relative to dt/config", () => {
		process.env.DTSIM_TEST_SCRATCH = "/scratch/u";
		try {
			// biome-ignore lint/suspicious/noTemplateCurlyInString: dtsim placeholder
			expect(resolvePath("${workspace}/temp/output", vars)).toBe(
				resolve("/p/temp/output"),
			);
			// biome-ignore lint/suspicious/noTemplateCurlyInString: dtsim placeholder
			expect(resolvePath("${DTSIM_TEST_SCRATCH}/run", vars)).toBe(
				resolve("/scratch/u/run"),
			);
			expect(resolvePath("cases/a.ts", vars)).toBe(
				resolve("/p/dt/config/cases/a.ts"),
			);
		} finally {
			delete process.env.DTSIM_TEST_SCRATCH;
		}
	});

	test("bare $name, unknown names and per-case names fail", () => {
		expect(() => resolvePath("$workspace/x", vars)).toThrow(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: dtsim placeholder
			"write ${workspace} instead of $workspace",
		);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: dtsim placeholder
		expect(() => resolvePath("${DTSIM_TEST_UNSET_X}/x", vars)).toThrow(
			"neither a dtsim variable nor set in the environment",
		);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: dtsim placeholder
		expect(() => resolvePath("${output_dir}/x", vars)).toThrow(
			"only per-case paths",
		);
	});
});

describe("workspace output", () => {
	test("output moves every run under the resolved directory", async () => {
		const ws = await makeWorkspace(
			CASES_TS.replace(
				'filelist: "file.lst",',
				// biome-ignore lint/suspicious/noTemplateCurlyInString: dtsim placeholder
				'filelist: "file.lst", output: "${workspace}/temp/output",',
			),
		);
		const loaded = await loadWorkspace({ config: ws.config });
		expect(loaded.out).toBe(join(ws.root, "temp", "output"));
		const result = await runDtsim(ws, ["run", "test_hello_world", "-s", "3"]);
		expect(result.code).toBe(0);
		expect(
			existsSync(
				join(ws.root, "temp", "output", "test_hello_world", "3", "sim.log"),
			),
		).toBe(true);
		expect(existsSync(ws.out)).toBe(false);
	});
});
