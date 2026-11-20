import { describe, expect, test, vi } from "bun:test";
import { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { LivePanel } from "../../src/dtsim/core/live.ts";

/** A stderr stand-in: settable size, recorded writes. */
class FakeTty extends EventEmitter {
	readonly out: string[] = [];
	constructor(
		public columns: number,
		public rows = 40,
	) {
		super();
	}
	write(s: string): boolean {
		this.out.push(s);
		return true;
	}
}

const panelOn = (tty: FakeTty) =>
	new LivePanel(tty as unknown as NodeJS.WriteStream);

describe("live panel", () => {
	test("frame lines are cut below the width, persisted lines are not", () => {
		const tty = new FakeTty(20);
		const panel = panelOn(tty);
		panel.render(`\x1b[1m${"x".repeat(40)}\x1b[22m\nshort`);
		const frame = stripVTControlCharacters(tty.out.join(""));
		expect(frame).toContain(`${"x".repeat(18)}…\nshort\n`);
		const long = `OK  00:01  compile build01_tb_top  ${"D:/dir/".repeat(10)}compile.log`;
		panel.persist(long);
		// Printed as given, after erasing the two-row frame.
		expect(tty.out.at(-1)).toContain(`\x1b[2A\x1b[J${long}\n`);
		panel.stop();
	});

	test("after a shrink the old frame is erased by its rewrapped height", () => {
		vi.useFakeTimers();
		const tty = new FakeTty(80);
		const panel = panelOn(tty);
		// Two 79-column lines: one row each at 80 columns.
		panel.render(`${"a".repeat(100)}\n${"b".repeat(100)}`);
		tty.columns = 40;
		tty.emit("resize");
		panel.render("next");
		// Drawing waits for the resize to settle.
		expect(tty.out.length).toBe(1);
		vi.advanceTimersByTime(150);
		// 79 columns rewrap to 2 rows each at 40: erase 4 rows, not 2.
		expect(tty.out.at(-1)).toContain("\x1b[4A\x1b[J");
		expect(tty.out.at(-1)).toContain("next\n");
		panel.stop();
		vi.useRealTimers();
	});
});
