// Live status of one `dtsim run` case on stderr. Each step (preCompile,
// compile, postCompile, preSim, sim, postSim, grade, onResult) gets a start
// line for compile / sim (log location and the submitted command) and an end
// line for every step (colored status, elapsed time, log size). In between, a
// spinner shows the running step, its elapsed time and log size ("-" while
// the log is not on disk). The compile / sim output comes straight from the
// child (a pseudo-terminal on POSIX, pipes on Windows), never from the log
// file: the last `liveLines` lines show between rules titled with the step,
// above the spinner row, and a failed step leaves them on screen
// (liveLines 0: only the last line, under the spinner row). Follow mode
// (`run -v` on a TTY) also prints every line above the panel. Not a TTY
// (--plain, pipes, LSF logs): the same start / end lines without the panel.
import { statSync } from "node:fs";
import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";
import type { CasePhase, PhaseObserver } from "./engine.ts";
import { LivePanel } from "./live.ts";
import { fmtClock } from "./scripts.ts";
import { status as colour, fmtSize, titledFrame, titledRules } from "./ui.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Steps that always get an end line; hook steps only on a TTY or a failure. */
const MAIN: ReadonlySet<CasePhase> = new Set(["compile", "sim", "grade"]);
/** Results that close a step without leaving its output window behind. */
const PASSED: Record<string, true> = {
	OK: true,
	PASS: true,
	"PASS WITH ERRORS": true,
};
/** Column widths: status (or spinner), phase, log name, log size. */
const STATUS_W = 6;
const PHASE_W = 22;
const LOG_W = 12;
const SIZE_W = 10;
/** Where the phase column starts: status, space, hhh:mm:ss, two spaces. */
const INDENT = " ".repeat(STATUS_W + 1 + 9 + 2);

type StartInfo = { log?: string; seed?: string; cmd?: readonly string[] };
type Current = { phase: CasePhase; log?: string; t0: number };

/** Size of a log, or undefined while it is not visible on disk. */
function sizeOf(path: string): number | undefined {
	try {
		return statSync(path).size;
	} catch {
		return undefined;
	}
}

function showSize(size: number | undefined): string {
	return size === undefined ? "-" : fmtSize(size);
}

/** Pad coloured text to `width` visible columns. */
function pad(text: string, width: number): string {
	return (
		text +
		" ".repeat(Math.max(0, width - stripVTControlCharacters(text).length))
	);
}

/** `compile.log    3.0 KiB` (size "-" while the log is not on disk). */
function logCol(log: string | undefined, size: number | undefined): string {
	if (!log) return "";
	return `${chalk.dim(basename(log).padEnd(LOG_W))} ${chalk.bold(showSize(size).padStart(SIZE_W))}`;
}

/** The submitted command between two full-width rules titled `cmd` (no side
 *  borders, so it copies cleanly): program bold cyan, options yellow, the rest
 *  dim. */
function cmdRule(argv: readonly string[]): string {
	const width = process.stderr.columns || 100;
	return titledRules("cmd", argv, width, (piece, i) =>
		i === 0
			? chalk.bold.cyan(piece)
			: /^[-+]/.test(argv[i] ?? "")
				? chalk.yellow(piece)
				: chalk.dim(piece),
	);
}

export class CaseMonitor implements PhaseObserver {
	private current?: Current;
	/** The running step's last output lines (at most max(liveLines, 1)). */
	private recent: string[] = [];
	private frame = 0;
	private timer?: Timer;
	/** The last sim's output window, for a grade that fails afterwards. */
	private lastWindow?: string;
	private readonly live?: LivePanel;
	/** Child output for the panel; set only on a TTY, so elsewhere the
	 *  engine leaves the child's streams alone. */
	readonly output?: (line: string) => void;
	/** POSIX TTY: the child runs on a pseudo-terminal (line-buffered). */
	readonly pty: boolean;

	/** `follow` (TTY only): print every output line above the panel too.
	 *  `liveLines`: height of the output window (0: last line only). */
	constructor(
		plain: boolean,
		private readonly follow = false,
		private readonly liveLines = 10,
	) {
		const tty = !plain && Boolean(process.stderr.isTTY);
		this.pty = tty;
		if (tty) {
			this.live = new LivePanel();
			this.output = (line) => {
				if (this.follow) this.live?.persist(line);
				this.recent.push(line);
				const keep = Math.max(1, this.liveLines);
				if (this.recent.length > keep)
					this.recent.splice(0, this.recent.length - keep);
			};
		}
	}

	/** A step starts. A step still running before it ended normally. */
	start(phase: CasePhase, info: StartInfo): void {
		this.close("OK");
		if (this.live && this.timer === undefined) {
			this.timer = setInterval(() => this.render(), 100);
		}
		this.current = {
			phase,
			t0: Date.now(),
			...(info.log === undefined ? {} : { log: info.log }),
		};
		this.recent = [];
		if (phase === "compile" || phase === "sim") this.lastWindow = undefined;
		if (info.log) {
			this.line(
				`${chalk.cyan(pad("▶", STATUS_W))} ${chalk.dim("start")}  ${chalk.bold(pad(this.name(this.current), PHASE_W))} ${chalk.dim(info.log)}`,
			);
		}
		// TTY: the command between titled rules. Otherwise one plain line.
		if (info.cmd?.length) {
			this.line(this.live ? cmdRule(info.cmd) : `$ ${info.cmd.join(" ")}`);
		}
		this.render();
	}

	/** `phase` finished with `result` ("OK", "FAIL", "exit 3", a status). */
	end(phase: CasePhase, result: string): void {
		if (this.current?.phase === phase) this.close(result);
		this.render();
	}

	/** Remove the panel so stdout can print; the step still running ends
	 *  normally. The next start() brings the panel back. */
	stop(): void {
		this.close("OK");
		clearInterval(this.timer);
		this.timer = undefined;
		this.live?.clear();
	}

	/** The step name only: the seed is in the Run / Summary blocks. */
	private name(c: Current): string {
		return c.phase;
	}

	/** `<first col> hhh:mm:ss  <phase>  <log> <size>`, columns aligned. */
	private row(first: string, c: Current): string {
		const elapsed = fmtClock((Date.now() - c.t0) / 1000);
		const size = c.log ? sizeOf(c.log) : undefined;
		return `${pad(first, STATUS_W)} ${elapsed}  ${chalk.bold(pad(this.name(c), PHASE_W))} ${logCol(c.log, size)}`.trimEnd();
	}

	/** The output window: the last lines between rules titled with the step. */
	private window(c: Current): string {
		const width = (process.stderr.columns || 100) - 1;
		return titledFrame(
			c.phase,
			this.recent.map((l) => chalk.dim(l)),
			width,
		);
	}

	/** A permanent line above the panel (or a plain line). */
	private line(text: string): void {
		if (this.live) this.live.persist(text);
		else process.stderr.write(`${stripVTControlCharacters(text)}\n`);
	}

	private close(result: string): void {
		const c = this.current;
		this.current = undefined;
		if (!c) return;
		// Without a TTY keep it short: hook steps only show when they fail.
		if (!this.live && !MAIN.has(c.phase) && result === "OK") return;
		const window =
			this.live && this.liveLines > 0 && this.recent.length > 0
				? this.window(c)
				: undefined;
		this.recent = [];
		// A failed step keeps its last output on screen, above its end line.
		// A sim that exited 0 but grades FAIL shows its output above the
		// grade line instead.
		const shown = window ?? (c.phase === "grade" ? this.lastWindow : undefined);
		if (shown && !PASSED[result]) this.line(shown);
		if (window && c.phase === "sim") this.lastWindow = window;
		this.line(this.row(colour(result), c));
	}

	private render(): void {
		if (!this.live) return;
		const c = this.current;
		if (!c) {
			this.live.clear();
			return;
		}
		this.frame = (this.frame + 1) % FRAMES.length;
		const head = this.row(chalk.cyan(FRAMES[this.frame] ?? ""), c);
		if (this.liveLines > 0 && this.recent.length > 0) {
			this.live.render(`${this.window(c)}\n${head}`);
			return;
		}
		// No window: the last line under the phase column (the panel cuts it
		// to the terminal width).
		const last = this.recent.at(-1);
		this.live.render(last ? `${head}\n${INDENT}${chalk.dim(last)}` : head);
	}
}
