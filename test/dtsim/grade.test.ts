import { describe, expect, test } from "bun:test";
import { excerptLines } from "../../src/dtsim/core/excerpt.ts";
import {
	applyWaiveRegions,
	gradeLines,
	kwMatchLine,
} from "../../src/dtsim/core/grade.ts";

const SPEC = {
	pass: ["TEST PASSED"],
	error: ["Error:"],
	expect: ["Keyword"],
};

describe("keyword matching", () => {
	test("substring, regex, and invalid regex fallback", () => {
		expect(kwMatchLine("Error:", "Error: boom")).toBe(true);
		expect(kwMatchLine("re:ERROR:.*timing", "ERROR: x timing violation")).toBe(
			true,
		);
		expect(kwMatchLine("re:ERROR:.*timing", "all good")).toBe(false);
		expect(kwMatchLine("re:[unclosed", "literal [unclosed text")).toBe(true);
	});
});

describe("waive regions", () => {
	test("region waives only matching lines; markers never kept", () => {
		const lines = [
			"DSIM_WAIVE_BEGIN re:tRL_I",
			"Error: tRL_I violation",
			"Error: unrelated",
			"DSIM_WAIVE_END",
			"Error: outside",
		];
		const out = applyWaiveRegions(lines, {});
		expect(out.waived).toBe(1);
		expect(out.kept).toEqual(["Error: unrelated", "Error: outside"]);
	});

	test("empty pattern waives everything; unclosed extends to EOF", () => {
		const out = applyWaiveRegions(
			["DSIM_WAIVE_BEGIN", "Error: a", "Error: b"],
			{},
		);
		expect(out.waived).toBe(2);
		expect(out.kept).toEqual([]);
		expect(out.unclosed).toBe(true);
	});

	test("named rules switch on and off, unknown names collected", () => {
		const rules = { boot: "Error: timeout" };
		const out = applyWaiveRegions(
			[
				"DSIM_WAIVE_ON boot ghost",
				"Error: timeout in boot phase",
				"DSIM_WAIVE_OFF",
				"Error: timeout in boot phase",
			],
			rules,
		);
		expect(out.waived).toBe(1);
		expect(out.kept).toEqual(["Error: timeout in boot phase"]);
		expect(out.unknown).toEqual(["ghost"]);
	});
});

describe("grading", () => {
	test("clean pass", () => {
		const r = gradeLines(["Keyword", "TEST PASSED"], SPEC, {});
		expect(r.status).toBe("PASS");
	});

	test("error keyword means PASS WITH ERRORS, exit status stays passing", () => {
		const r = gradeLines(["Keyword", "Error: x", "TEST PASSED"], SPEC, {});
		expect(r.status).toBe("PASS WITH ERRORS");
		expect(r.errorCounts["Error:"]).toBe(1);
	});

	test("missing expect keyword means PASS WITH ERRORS", () => {
		const r = gradeLines(["TEST PASSED"], SPEC, {});
		expect(r.status).toBe("PASS WITH ERRORS");
		expect(r.missingExpect).toEqual(["Keyword"]);
	});

	test("no pass marker means FAIL", () => {
		const r = gradeLines(["UVM_FATAL @ 1ns"], SPEC, {});
		expect(r.status).toBe("FAIL");
	});

	test("waived-only errors still PASS but are counted", () => {
		const r = gradeLines(
			[
				"DSIM_WAIVE_BEGIN",
				"Error: benign",
				"DSIM_WAIVE_END",
				"Keyword",
				"TEST PASSED",
			],
			SPEC,
			{},
		);
		expect(r.status).toBe("PASS");
		expect(r.waived).toBe(1);
	});
});

describe("error excerpts", () => {
	test("tool error lines come first, tail fills up, cap is 40 lines", () => {
		const lines = Array.from({ length: 200 }, (_, i) => `noise ${i}`);
		lines[120] = "UVM_FATAL @ 1200ns: boom";
		const out = excerptLines({
			lines,
			kept: lines,
			toolErrors: [/UVM_FATAL/],
			errorKeywords: [],
		});
		expect(out[0]).toContain("UVM_FATAL");
		expect(out.length).toBeLessThanOrEqual(41);
	});
});
