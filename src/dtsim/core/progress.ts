// Regression progress on stderr as trees: one per compile group still in
// flight (compile node, then its running sims and a count of the rest), so
// several builds show side by side, with a layered progress bar and counts
// on the last line. Each finished compile or sim also leaves a line with its
// status, time and log path (size). Not a TTY (--plain, pipes, LSF logs):
// only those lines.
import { statSync } from "node:fs";
import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";
import type { PhaseObserver } from "./engine.ts";
import { LivePanel } from "./live.ts";
import { fmtElapsed } from "./scripts.ts";
import { status as colour, fmtSize } from "./ui.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Column widths: status (or spinner), task label, log name, log size. */
const STATUS_W = 6;
const LABEL_W = 34;
const LOG_W = 12;
const SIZE_W = 10;

type State = "waiting" | "running" | "done";

/** One compile or sim task as the display tracks it. */
export type TaskNode = {
	/** "compile <name>" or "sim <case>". */
	label: string;
	state: State;
	status?: string;
	t0?: number;
	t1?: number;
	log?: string;
};

export type BuildNode = TaskNode & { sims: TaskNode[] };

/** What the display needs from the plan: builds and their sims, in order. */
export type PlannedBuild = { name: string; sims: readonly string[] };

function sizeOf(path: string | undefined): number | undefined {
	if (!path) return undefined;
	try {
		return statSync(path).size;
	} catch {
		return undefined;
	}
}

function pad(text: string, width: number): string {
	const n = stripVTControlCharacters(text).length;
	return text + " ".repeat(Math.max(0, width - n));
}

/** `mm:ss`, `h:mm:ss` once past an hour; right-aligned to `width` so the
 *  rows of one regression keep their columns. */
function elapsed(n: TaskNode, width: number): string {
	if (n.t0 === undefined) return "--:--".padStart(width);
	return fmtElapsed(((n.t1 ?? Date.now()) - n.t0) / 1000).padStart(width);
}

/** Narrower than this, the bar line is text only. */
const BAR_MIN = 10;
/** `hhh:mm:ss`: the bar line's clock field. */
const CLOCK_W = 9;

/** One bar cell: glyph and paint; runs of equal cells are merged. */
type Cell = { ch: string; paint: (s: string) => string };
const CELL = {
	pass: { ch: "█", paint: chalk.green },
	passWithErrors: { ch: "█", paint: chalk.yellow },
	fail: { ch: "█", paint: chalk.red },
	built: { ch: "█", paint: chalk.blue },
	buildFailed: { ch: "█", paint: chalk.gray },
	building: { ch: "░", paint: (s: string) => s },
	waiting: { ch: "░", paint: chalk.gray },
} satisfies Record<string, Cell>;

/** Regression bar, left to right: finished sims of built builds (PASS, PASS
 *  WITH ERRORS, any other status), the rest of the built builds, failed
 *  builds, building, waiting. Each build owns 1/N of the width and each of
 *  its k sims 1/(N·k); sims skipped by a failed compile are not drawn (their
 *  segment stays build-failed). Cells are whole: the largest remainders get
 *  the leftover cells, and a status with at least one finished sim always
 *  keeps a cell, so a single FAIL never rounds away (a cell is taken from
 *  the widest segment). */
export function progressBar(
	builds: readonly BuildNode[],
	width: number,
): string {
	const n = builds.length || 1;
	let built = 0;
	let failed = 0;
	let building = 0;
	let pass = 0;
	let warn = 0;
	let bad = 0;
	for (const b of builds) {
		if (b.state === "running") building += 1 / n;
		if (b.state !== "done") continue;
		if (b.status !== "OK") {
			failed += 1 / n;
			continue;
		}
		built += 1 / n;
		const each = 1 / (n * (b.sims.length || 1));
		for (const s of b.sims) {
			if (s.state !== "done") continue;
			if (s.status === "PASS") pass += each;
			else if (s.status === "PASS WITH ERRORS") warn += each;
			else bad += each;
		}
	}
	const segments: Array<[Cell, number]> = [
		[CELL.pass, pass],
		[CELL.passWithErrors, warn],
		[CELL.fail, bad],
		[CELL.built, Math.max(0, built - pass - warn - bad)],
		[CELL.buildFailed, failed],
		[CELL.building, building],
	];
	const used = segments.reduce((s, [, f]) => s + f, 0);
	segments.push([CELL.waiting, Math.max(0, 1 - used)]);
	const cells = segments.map(([, f]) => Math.floor(f * width));
	const order = segments
		.map(([, f], i) => ({ i, rem: f * width - Math.floor(f * width) }))
		.sort((a, b) => b.rem - a.rem);
	let left = width - cells.reduce((s, c) => s + c, 0);
	for (const { i } of order) {
		if (left <= 0) break;
		cells[i] = (cells[i] as number) + 1;
		left -= 1;
	}
	// PASS / PASS WITH ERRORS / FAIL: present means visible.
	for (const i of [0, 1, 2]) {
		if ((segments[i]?.[1] ?? 0) <= 0 || (cells[i] ?? 0) > 0) continue;
		let donor = -1;
		for (const [j, c] of cells.entries()) {
			const keep = j <= 2 && (segments[j]?.[1] ?? 0) > 0 ? 1 : 0;
			if (c - keep > 0 && (donor < 0 || c > (cells[donor] ?? 0))) donor = j;
		}
		if (donor < 0) continue;
		cells[donor] = (cells[donor] as number) - 1;
		cells[i] = 1;
	}
	return segments
		.map(([cell], i) =>
			(cells[i] ?? 0) > 0 ? cell.paint(cell.ch.repeat(cells[i] ?? 0)) : "",
		)
		.join("");
}

/** `sim.log    3.0 KiB` ("-" while the log is not on disk). */
function logCol(log: string | undefined): string {
	if (!log) return "";
	const size = sizeOf(log);
	const shown = size === undefined ? "-" : fmtSize(size);
	return `${chalk.dim(basename(log).padEnd(LOG_W))} ${chalk.bold(shown.padStart(SIZE_W))}`;
}

export class Progress {
	readonly builds: BuildNode[];
	private readonly t0 = Date.now();
	/** Width of the `running` count: at most maxSlots tasks run at once. */
	private readonly slotsWidth: number;
	private frame = 0;
	private timer?: Timer;
	private readonly live?: LivePanel;

	constructor(plan: readonly PlannedBuild[], plain: boolean, maxSlots: number) {
		this.slotsWidth = String(maxSlots).length;
		this.builds = plan.map((b) => ({
			label: `compile ${b.name}`,
			state: "waiting",
			sims: b.sims.map((s) => ({ label: `sim ${s}`, state: "waiting" })),
		}));
		if (!plain && process.stderr.isTTY) {
			this.live = new LivePanel();
			this.timer = setInterval(() => this.render(), 100);
		}
	}

	/** Engine observer for one task: remembers the log its step writes. */
	observer(node: TaskNode): PhaseObserver {
		return {
			start: (phase, info) => {
				if (info.log && (phase === "compile" || phase === "sim")) {
					node.log = info.log;
				}
			},
			end: () => {},
		};
	}

	begin(node: TaskNode): void {
		node.state = "running";
		node.t0 = Date.now();
		this.render();
	}

	/** A task ended: one plain line `<status> <elapsed> <label> <log> (size)`
	 *  (or a note in place of the log). The log path is printed inline and the
	 *  terminal wraps it; dtsim does not lay it out on a fixed-width branch. */
	finish(node: TaskNode, status: string, log?: string, note?: string): void {
		node.state = "done";
		node.status = status;
		node.t1 = Date.now();
		if (log && !node.log) node.log = log;
		const size = sizeOf(node.log);
		const where = note
			? chalk.dim(note)
			: node.log
				? `${chalk.dim(node.log)} ${chalk.bold(`(${size === undefined ? "-" : fmtSize(size)})`)}`
				: "";
		const head = `${pad(colour(status), STATUS_W)} ${elapsed(node, this.clockWidth())}  ${chalk.bold(node.label)}`;
		this.line(where ? `${head}  ${where}` : head);
	}

	/** Remove the live trees. On a TTY returns the final bar line, which the
	 *  caller prints under the results so the PASS / FAIL proportion stays
	 *  visible after the run. */
	stop(): string | undefined {
		clearInterval(this.timer);
		this.timer = undefined;
		if (!this.live) return undefined;
		const bar = this.barLine();
		this.live.stop();
		return bar;
	}

	/** The run's own elapsed time is the longest, so its width fits every
	 *  row: the hour column appears for all of them at once. */
	private clockWidth(): number {
		return fmtElapsed((Date.now() - this.t0) / 1000).length;
	}

	/** `running n     mm:ss <bar> compile x/N sim y/M`: the clock is
	 *  right-aligned to `hhh:mm:ss` (room for the hours left blank) and each
	 *  count to the digits of its limit (maxSlots, the builds, the sims),
	 *  like `%*d`, so the line does not shift while it runs. The bar
	 *  takes what the terminal leaves (the panel keeps one column free);
	 *  below BAR_MIN cells it is left out and only the text shows. */
	private barLine(): string {
		const sims = this.builds.flatMap((b) => b.sims);
		const count = (list: readonly TaskNode[], s: State) =>
			list.filter((n) => n.state === s).length;
		const of = (list: readonly TaskNode[]) =>
			`${String(count(list, "done")).padStart(String(list.length).length)}/${list.length}`;
		const running = count(this.builds, "running") + count(sims, "running");
		const head = chalk.dim(
			`running ${String(running).padStart(this.slotsWidth)} ${fmtElapsed((Date.now() - this.t0) / 1000).padStart(CLOCK_W)}`,
		);
		const tail = `${chalk.bold("compile")} ${of(this.builds)} ${chalk.bold("sim")} ${of(sims)}`;
		const text = stripVTControlCharacters(`${head} ${tail}`).length;
		// Beyond that text: one more space.
		const room = (process.stderr.columns || 80) - 1 - text - 1;
		if (room < BAR_MIN) return `${head} ${tail}`;
		return `${head} ${progressBar(this.builds, room)} ${tail}`;
	}

	private line(text: string): void {
		if (this.live) {
			this.live.persist(text);
			this.render();
		} else {
			process.stderr.write(`${stripVTControlCharacters(text)}\n`);
		}
	}

	private row(first: string, n: TaskNode, labelWidth: number): string {
		return `${pad(first, STATUS_W)} ${elapsed(n, this.clockWidth())}  ${chalk.bold(pad(n.label, labelWidth))} ${logCol(n.log)}`.trimEnd();
	}

	private render(): void {
		if (!this.live) return;
		this.frame = (this.frame + 1) % FRAMES.length;
		const spin = chalk.cyan(FRAMES[this.frame] ?? "");
		const count = (list: readonly TaskNode[], s: State) =>
			list.filter((n) => n.state === s).length;
		const lines: string[] = [];
		// One row stays free for the bar line below the trees.
		const max = Math.max(4, (process.stderr.rows || 40) - 3);
		// Trees for builds still in flight: compiling, or with sims left.
		const active = this.builds.filter(
			(b) =>
				b.state === "running" ||
				(b.state === "done" && b.sims.some((s) => s.state !== "done")),
		);
		let shown = 0;
		for (const b of active) {
			const tree = [
				this.row(
					b.state === "running" ? spin : colour(b.status ?? ""),
					b,
					LABEL_W,
				),
			];
			const kids = b.sims.filter((s) => s.state === "running");
			const waiting = count(b.sims, "waiting");
			const done = count(b.sims, "done");
			const rest = [
				...(waiting ? [`${waiting} waiting`] : []),
				...(done ? [`${done} done`] : []),
			].join(", ");
			const children = [
				...kids.map((s) => this.row(spin, s, LABEL_W - 3)),
				...(rest ? [chalk.dim(`… ${rest}`)] : []),
			];
			children.forEach((text, i) => {
				tree.push(`${i === children.length - 1 ? "└─" : "├─"} ${text}`);
			});
			if (lines.length + tree.length > max) break;
			lines.push(...tree);
			shown += 1;
		}
		if (shown < active.length) {
			lines.push(chalk.dim(`… ${active.length - shown} more builds in flight`));
		}
		lines.push(this.barLine());
		this.live.render(lines.join("\n"));
	}
}
