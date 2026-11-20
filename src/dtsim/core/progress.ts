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
import type logUpdate from "log-update";
import { createLogUpdate } from "log-update";
import type { PhaseObserver } from "./engine.ts";
import { fmtElapsed } from "./scripts.ts";
import { status as colour, fmtSize, persistAbove } from "./ui.ts";

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

function elapsed(n: TaskNode): string {
	if (n.t0 === undefined) return "--:--";
	return fmtElapsed(((n.t1 ?? Date.now()) - n.t0) / 1000);
}

const BAR_MIN = 10;
const BAR_MAX = 60;

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

/** Regression bar in two layers. Each build owns 1/N of the width; each of
 *  its k sims 1/(N·k). The compile layer, left to right: built, build
 *  failed, building, waiting. Finished sims of built builds cover it from
 *  the left: PASS, PASS WITH ERRORS, then any other status. Sims skipped by
 *  a failed compile are not drawn; their segment stays build-failed. */
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
	const layers: Array<Array<[Cell, number]>> = [
		[
			[CELL.pass, pass],
			[CELL.passWithErrors, warn],
			[CELL.fail, bad],
		],
		[
			[CELL.built, built],
			[CELL.buildFailed, failed],
			[CELL.building, building],
		],
	];
	const pick = (x: number): Cell => {
		for (const layer of layers) {
			let edge = 0;
			for (const [cell, w] of layer) {
				edge += w;
				if (x < edge) return cell;
			}
		}
		return CELL.waiting;
	};
	let out = "";
	let run: Cell | undefined;
	let len = 0;
	for (let i = 0; i < width; i++) {
		// Sample each cell at its centre: cumulative rounding, fixed width.
		const cell = pick((i + 0.5) / width);
		if (cell !== run) {
			if (run) out += run.paint(run.ch.repeat(len));
			run = cell;
			len = 0;
		}
		len += 1;
	}
	if (run) out += run.paint(run.ch.repeat(len));
	return out;
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
	private frame = 0;
	private timer?: Timer;
	private readonly live?: typeof logUpdate;

	constructor(plan: readonly PlannedBuild[], plain: boolean) {
		this.builds = plan.map((b) => ({
			label: `compile ${b.name}`,
			state: "waiting",
			sims: b.sims.map((s) => ({ label: `sim ${s}`, state: "waiting" })),
		}));
		if (!plain && process.stderr.isTTY) {
			this.live = createLogUpdate(process.stderr, { showCursor: true });
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
		const head = `${pad(colour(status), STATUS_W)} ${elapsed(node)}  ${chalk.bold(node.label)}`;
		this.line(where ? `${head}  ${where}` : head);
	}

	stop(): void {
		clearInterval(this.timer);
		this.timer = undefined;
		this.live?.clear();
		this.live?.done();
	}

	private line(text: string): void {
		if (this.live) {
			persistAbove(this.live, text);
			this.render();
		} else {
			process.stderr.write(`${stripVTControlCharacters(text)}\n`);
		}
	}

	private row(first: string, n: TaskNode, labelWidth: number): string {
		return `${pad(first, STATUS_W)} ${elapsed(n)}  ${chalk.bold(pad(n.label, labelWidth))} ${logCol(n.log)}`.trimEnd();
	}

	private render(): void {
		if (!this.live) return;
		this.frame = (this.frame + 1) % FRAMES.length;
		const spin = chalk.cyan(FRAMES[this.frame] ?? "");
		const sims = this.builds.flatMap((b) => b.sims);
		const count = (list: readonly TaskNode[], s: State) =>
			list.filter((n) => n.state === s).length;
		const running = count(this.builds, "running") + count(sims, "running");
		const counts = `${chalk.bold("compile")} ${count(this.builds, "done")}/${this.builds.length}  ${chalk.bold("sim")} ${count(sims, "done")}/${sims.length}  ${chalk.dim(`running ${running}  ${fmtElapsed((Date.now() - this.t0) / 1000)}`)}`;
		const room =
			(process.stderr.columns || 80) -
			stripVTControlCharacters(counts).length -
			2;
		const bar = progressBar(
			this.builds,
			Math.min(BAR_MAX, Math.max(BAR_MIN, room)),
		);
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
		lines.push(`${bar}  ${counts}`);
		this.live(lines.join("\n"));
	}
}
