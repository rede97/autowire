import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { excerptLines } from "../../src/dtsim/core/excerpt.ts";
import {
	DefaultGrader,
	type GradeContext,
	gradeLines,
	WaiveRule,
} from "../../src/dtsim/dsl/index.ts";

const KW = { pass: ["TEST PASSED"], error: ["Error:"], expect: ["Keyword"] };

describe("keywords", () => {
	test("clean pass", () => {
		expect(gradeLines(["Keyword", "TEST PASSED"], KW).status).toBe("PASS");
	});

	test("error keyword means PASS WITH ERRORS", () => {
		const r = gradeLines(["Keyword", "Error: x", "TEST PASSED"], KW);
		expect(r.status).toBe("PASS WITH ERRORS");
		expect(r.errorCounts["Error:"]).toBe(1);
	});

	test("missing expect keyword means PASS WITH ERRORS", () => {
		const r = gradeLines(["TEST PASSED"], KW);
		expect(r.status).toBe("PASS WITH ERRORS");
		expect(r.missingExpect).toEqual(["Keyword"]);
	});

	test("no pass marker means FAIL", () => {
		expect(gradeLines(["simulation ended"], KW).status).toBe("FAIL");
	});

	test("regex keywords; an invalid regex is a substring", () => {
		const r = gradeLines(
			["ERROR: x timing violation", "literal [unclosed text", "TEST PASSED"],
			{ error: ["re:ERROR:.*timing", "re:[unclosed"] },
		);
		expect(r.errorCounts).toEqual({
			"re:ERROR:.*timing": 1,
			"re:[unclosed": 1,
		});
	});

	test("pass keywords take re: too", () => {
		expect(
			gradeLines(["  TEST PASS  "], { pass: ["re:^TEST PASS$"] }).status,
		).toBe("FAIL");
		expect(gradeLines(["TEST PASS"], { pass: ["re:^TEST PASS$"] }).status).toBe(
			"PASS",
		);
	});
});

describe("log files", () => {
	test("CRLF lines match anchored keywords; an unfinished run says why", async () => {
		const dir = await mkdtemp(join(tmpdir(), "dtsim-grade-"));
		const log = join(dir, "sim.log");
		await writeFile(log, "Error: boom\r\nTEST PASS\r\n");
		const g = DefaultGrader({
			pass: ["re:^TEST PASS$"],
			error: ["re:^Error: boom$"],
		});
		const out = await g.grade({ log } as GradeContext);
		expect(typeof out === "object" && out.status).toBe("PASS WITH ERRORS");
		await writeFile(log, "simulation ended\r\n");
		const failed = await g.grade({ log } as GradeContext);
		if (typeof failed !== "object") throw new Error("expected a report");
		expect(failed.status).toBe("FAIL");
		expect(failed.note).toBe("not finished");
		expect(failed.details).toContainEqual([
			"Finished",
			"no line matched re:^TEST PASS$",
		]);
	});
});

describe("waive", () => {
	test("region waives only matching lines; markers never count", () => {
		const r = gradeLines(
			[
				"DSIM_WAIVE_BEGIN re:tRL_I",
				"Error: tRL_I violation",
				"Error: unrelated",
				"DSIM_WAIVE_END",
				"Error: outside",
				"TEST PASSED",
			],
			{ error: ["Error:"] },
		);
		expect(r.waived).toBe(1);
		expect(r.hits).toEqual(["Error: unrelated", "Error: outside"]);
	});

	test("empty pattern waives everything; unclosed extends to EOF", () => {
		const r = gradeLines(["TEST PASSED", "DSIM_WAIVE_BEGIN", "Error: a"], {
			error: ["Error:"],
		});
		expect(r.status).toBe("PASS");
		expect(r.waived).toBe(1);
		expect(r.unclosed).toBe(true);
	});

	test("named rules switch on and off, unknown names collected", () => {
		const r = gradeLines(
			[
				"DSIM_WAIVE_ON boot ghost",
				"Error: timeout in boot phase",
				"DSIM_WAIVE_OFF",
				"Error: timeout in boot phase",
				"TEST PASSED",
			],
			{ error: ["Error:"], waive: [WaiveRule("boot", "Error: timeout")] },
		);
		expect(r.waived).toBe(1);
		expect(r.errorCounts["Error:"]).toBe(1);
		expect(r.unknown).toEqual(["ghost"]);
	});
});

describe("uvm", () => {
	const summary = [
		"--- UVM Report Summary ---",
		"UVM_INFO :   12",
		"UVM_ERROR :    0",
		"UVM_FATAL :    0",
	];

	test("a clean report summary passes without a pass keyword", () => {
		expect(gradeLines(summary, {}).status).toBe("PASS");
	});

	test("an error message fails; summary count lines are not messages", () => {
		const r = gradeLines(
			["UVM_ERROR tb.sv(12) @ 10ns: [CHK] mismatch", ...summary],
			{},
		);
		expect(r.status).toBe("FAIL");
		expect(r.uvmErrors).toBe(1);
		expect(r.uvmFatals).toBe(0);
	});

	test("a waived UVM_ERROR does not fail; uvm: false ignores UVM", () => {
		const waived = [
			"DSIM_WAIVE_BEGIN",
			"UVM_ERROR tb.sv(12) @ 10ns: known",
			"DSIM_WAIVE_END",
			...summary,
		];
		expect(gradeLines(waived, {}).status).toBe("PASS");
		const fatal = ["UVM_FATAL @ 1ns: boom", "TEST PASSED"];
		expect(gradeLines(fatal, {}).status).toBe("FAIL");
		expect(gradeLines(fatal, { uvm: false }).status).toBe("PASS");
	});
});

describe("DefaultGrader", () => {
	test("extend appends lists and waive rules", () => {
		const base = DefaultGrader({
			error: ["Error:"],
			waive: [WaiveRule("a", "x")],
		});
		const derived = base.extend({
			error: ["FAIL:"],
			pass: ["DONE"],
			waive: [WaiveRule("b", "y")],
		});
		expect(derived.opts.error).toEqual(["Error:", "FAIL:"]);
		expect(derived.opts.pass).toEqual(["DONE"]);
		expect(derived.opts.waive?.map((r) => r.name)).toEqual(["a", "b"]);
		expect(base.opts.error).toEqual(["Error:"]);
	});

	test("grades a large log in a worker with bounded highlights", async () => {
		const dir = await mkdtemp(join(tmpdir(), "dtsim-grade-"));
		const log = join(dir, "sim.log");
		const noise = "x".repeat(100);
		const lines = Array.from({ length: 200_000 }, (_, i) =>
			i % 1000 === 0 ? `Error: e${i}` : noise,
		);
		await writeFile(log, `${lines.join("\n")}\nTEST PASSED\n`);
		const out = await DefaultGrader({ error: ["Error:"] }).grade({
			log,
		} as GradeContext);
		expect(typeof out === "object" && out.status).toBe("PASS WITH ERRORS");
		if (typeof out !== "object") return;
		expect(out.details).toContainEqual(["Error kws", "Error: (200)"]);
		expect(out.highlight?.length).toBe(40);
	});
});

describe("error excerpts", () => {
	test("tool errors and highlights in log order, tail fills a short one", async () => {
		const dir = await mkdtemp(join(tmpdir(), "dtsim-excerpt-"));
		const log = join(dir, "sim.log");
		const lines = Array.from({ length: 200 }, (_, i) => `noise ${i}`);
		lines[120] = "UVM_FATAL @ 1200ns: boom";
		lines[50] = "Error: picked by the grader";
		await writeFile(log, lines.join("\n"));
		const out = await excerptLines(log, [/UVM_FATAL/], [lines[50] as string]);
		expect(out[0]).toBe("Error: picked by the grader");
		expect(out[1]).toContain("UVM_FATAL");
		expect(out.at(-1)).toBe("noise 199");
		expect(out.length).toBe(17);
	});
});
