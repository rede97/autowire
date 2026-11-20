import { describe, expect, test } from "bun:test";
import { VcsTool } from "../../src/dtsim/dsl/index.ts";

describe("workspace-wide top", () => {
	test("VcsTool defaults to tb_top and ignores case toolOptions.top", () => {
		const tool = VcsTool();
		const key = tool.compileKey?.(
			{ id: "x", toolOptions: { top: "other" } } as never,
			"base",
		);
		expect(key).not.toContain("other");
	});
});

import { vcsBaseFlags, verilatorBaseFlags } from "../../src/dtsim/dsl/flags.ts";

describe("base flags", () => {
	test("vcsBaseFlags: -full64 -sverilog -kdb always; options and add overlay", () => {
		expect(vcsBaseFlags()).toEqual(["-full64", "-sverilog", "-kdb"]);
		expect(vcsBaseFlags({ timescale: "1ns/1ps", jobs: 8 })).toEqual([
			"-full64",
			"-sverilog",
			"-kdb",
			"-timescale=1ns/1ps",
			"-j8",
		]);
		// kdb can be turned off; add appends project flags
		expect(vcsBaseFlags({ kdb: false, add: ["-x"] })).toEqual([
			"-full64",
			"-sverilog",
			"-x",
		]);
	});

	test("vcsBaseFlags: debugaccess is an optional string enum", () => {
		expect(vcsBaseFlags({ debugaccess: "all" })).toContain("-debug_access+all");
		expect(vcsBaseFlags({ debugaccess: "pp" })).toContain("-debug_access+pp");
	});

	test("verilatorBaseFlags: --sv always, plus options", () => {
		expect(verilatorBaseFlags()).toEqual(["--sv"]);
		expect(
			verilatorBaseFlags({ timing: true, jobs: 4, timescale: "1ns/1ps" }),
		).toEqual(["--sv", "--timing", "--timescale", "1ns/1ps", "-j", "4"]);
	});
});
