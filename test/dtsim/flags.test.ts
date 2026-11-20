import { describe, expect, test } from "bun:test";
import { vcsBaseFlags, verilatorBaseFlags } from "../../src/dtsim/dsl/flags.ts";

describe("base flags", () => {
	test("vcsBaseFlags: portable baseline, options, and add overlay", () => {
		expect(vcsBaseFlags()).toEqual(["-full64", "-sverilog"]);
		expect(vcsBaseFlags({ timescale: "1ns/1ps", jobs: 8 })).toEqual([
			"-full64",
			"-sverilog",
			"-timescale=1ns/1ps",
			"-j8",
		]);
		// options override the defaults, add appends
		expect(vcsBaseFlags({ full64: false, sv: false, add: ["-x"] })).toEqual([
			"-x",
		]);
	});

	test("verilatorBaseFlags: baseline plus options", () => {
		expect(verilatorBaseFlags()).toEqual(["--sv"]);
		expect(
			verilatorBaseFlags({ timing: true, jobs: 4, timescale: "1ns/1ps" }),
		).toEqual(["--sv", "--timing", "--timescale", "1ns/1ps", "-j", "4"]);
	});
});
