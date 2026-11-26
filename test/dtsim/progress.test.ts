import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";
import { type BuildNode, progressBar } from "../../src/dtsim/core/progress.ts";

const done = (status: string) => ({
	label: "sim x",
	state: "done" as const,
	status,
});
const waiting = { label: "sim x", state: "waiting" as const };

/** Cells per colour, read from the ANSI the bar is painted with. */
function colours(bar: string): Record<string, number> {
	const out: Record<string, number> = {};
	const paints: Array<[string, (s: string) => string]> = [
		["green", chalk.green],
		["yellow", chalk.yellow],
		["red", chalk.red],
		["blue", chalk.blue],
	];
	for (const [name, paint] of paints) {
		const open = paint("x").split("x")[0] as string;
		let n = 0;
		for (const part of bar.split(open).slice(1)) {
			n += stripVTControlCharacters(part.split("\x1b[")[0] ?? "").length;
		}
		out[name] = n;
	}
	return out;
}

describe("progress bar", () => {
	chalk.level = 1;

	test("one FAIL or PASS WITH ERRORS among many PASS keeps a cell", () => {
		const sims = [
			...Array.from({ length: 98 }, () => done("PASS")),
			done("FAIL"),
			done("PASS WITH ERRORS"),
		];
		const builds: BuildNode[] = [
			{ label: "compile b", state: "done", status: "OK", sims },
		];
		for (const width of [10, 23, 37, 60]) {
			const bar = progressBar(builds, width);
			expect(stripVTControlCharacters(bar).length).toBe(width);
			const c = colours(bar);
			expect(c.red).toBe(1);
			expect(c.yellow).toBe(1);
			expect(c.green).toBe(width - 2);
		}
	});

	test("an early FAIL stays visible while the rest of the sims run", () => {
		for (let finished = 1; finished <= 200; finished++) {
			const sims = [
				done("FAIL"),
				...Array.from({ length: finished - 1 }, () => done("PASS")),
				...Array.from({ length: 200 - finished }, () => waiting),
			];
			const bar = progressBar(
				[{ label: "compile b", state: "done", status: "OK", sims }],
				40,
			);
			expect(stripVTControlCharacters(bar).length).toBe(40);
			expect(colours(bar).red).toBeGreaterThanOrEqual(1);
		}
	});
});
