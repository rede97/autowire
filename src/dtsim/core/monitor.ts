// Live status of one `dtsim run` case on stderr. Each step (preCompile,
// compile, postCompile, preSim, sim, postSim, grade, onResult) gets a start
// line for compile / sim (log location and the submitted command) and an end
// line for every step (colored status, elapsed time, log size). In between, a
// spinner shows the running step, its elapsed time and, per log seen so far,
// the size and last line; "-" means the log is not on disk yet (or NFS has
// not caught up). Follow mode (`run -v` on a TTY) also prints the running
// step's new log lines above the panel. Not a TTY (--plain, pipes, LSF
// logs): the same start / end lines without the spinner.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";
import type logUpdate from "log-update";
import { createLogUpdate } from "log-update";
import type { CasePhase, PhaseObserver } from "./engine.ts";
import { fmtElapsed } from "./scripts.ts";
import { status as colour, fmtSize } from "./ui.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TAIL_BYTES = 4096;

type StartInfo = { log?: string; seed?: string; cmd?: readonly string[] };
type Current = { phase: CasePhase; seed?: string; log?: string; t0: number };
type Tail = { size?: number; line: string };

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

/** Size and last non-empty line, read from the last few KB only. */
async function tail(path: string): Promise<Tail> {
	const size = sizeOf(path);
	if (size === undefined) return { line: "" };
	const text = await Bun.file(path)
		.slice(Math.max(0, size - TAIL_BYTES), size)
		.text();
	const last = text.split(/\r?\n/).findLast((l) => l.trim().length > 0) ?? "";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: tool output may carry control bytes
	const clean = stripVTControlCharacters(last).replace(/[\x00-\x1f\x7f]/g, " ");
	return { size, line: clean };
}

/** `$ prog flags args`: program bold, options in yellow, the rest dim. */
function styleCmd(argv: readonly string[]): string {
	const [prog, ...rest] = argv;
	const args = rest.map((a) =>
		/^[-+]/.test(a) ? chalk.yellow(a) : chalk.dim(a),
	);
	return `  ${chalk.dim("$")} ${chalk.bold.cyan(prog ?? "")} ${args.join(" ")}`;
}

export class CaseMonitor implements PhaseObserver {
	private current?: Current;
	/** Log per step that writes one (compile, sim), in start order. */
	private readonly logs = new Map<CasePhase, string>();
	private readonly tails = new Map<CasePhase, Tail>();
	private frame = 0;
	private timers: Timer[] = [];
	private readonly live?: typeof logUpdate;
	/** Follow mode: the running step's log, read up to `offset` so far. */
	private followed?: {
		path: string;
		offset: number;
		rest: string;
		decoder: TextDecoder;
	};

	/** `follow` (TTY only): print the running step's log lines above the
	 *  panel as they land, like `tail -f`. */
	constructor(
		private readonly label: string,
		plain: boolean,
		private readonly follow = false,
	) {
		if (!plain && process.stderr.isTTY) {
			this.live = createLogUpdate(process.stderr, { showCursor: true });
		}
	}

	/** A step starts. A step still running before it ended normally. */
	start(phase: CasePhase, info: StartInfo): void {
		this.close("OK");
		if (this.live && this.timers.length === 0) {
			this.timers = [
				setInterval(() => this.render(), 100),
				setInterval(() => void this.refresh(), 250),
			];
		}
		this.current = {
			phase,
			t0: Date.now(),
			...(info.seed === undefined ? {} : { seed: info.seed }),
			...(info.log === undefined ? {} : { log: info.log }),
		};
		if (info.log) {
			this.logs.set(phase, info.log);
			this.tails.delete(phase);
			if (this.follow && this.live) {
				this.followed = {
					path: info.log,
					offset: 0,
					rest: "",
					decoder: new TextDecoder(),
				};
			}
			this.line(
				`${chalk.cyan("▶")} ${this.title(this.current)}  ${chalk.dim("log")} ${info.log}`,
			);
		}
		if (info.cmd?.length) this.line(styleCmd(info.cmd));
		this.render();
	}

	/** `phase` finished with `result` ("OK", "FAIL", "exit 3", a status). */
	end(phase: CasePhase, result: string): void {
		if (this.current?.phase === phase) this.close(result);
		this.render();
	}

	/** Remove the panel so stdout can print; the step still running ends
	 *  normally. The next start() brings the panel back with its logs. */
	stop(): void {
		this.close("OK");
		for (const t of this.timers) clearInterval(t);
		this.timers = [];
		this.live?.clear();
		this.live?.done();
	}

	private title(c: Current): string {
		const seed = c.seed === undefined ? "" : ` seed ${c.seed}`;
		return `${chalk.bold(this.label)} ${c.phase}${seed}`;
	}

	/** A permanent line above the panel (or a plain line). */
	private line(text: string): void {
		if (this.live) this.live.persist(text);
		else process.stderr.write(`${stripVTControlCharacters(text)}\n`);
	}

	private close(result: string): void {
		this.drain(true);
		const c = this.current;
		this.current = undefined;
		if (!c) return;
		const ok = result === "OK" || result.startsWith("PASS");
		const log = c.log
			? `  ${chalk.dim(`${basename(c.log)} ${showSize(sizeOf(c.log))}`)}`
			: "";
		this.line(
			`${ok ? chalk.green("✓") : chalk.red("✗")} ${this.title(c)}  ${colour(result)}  ${fmtElapsed((Date.now() - c.t0) / 1000)}${log}`,
		);
	}

	private async refresh(): Promise<void> {
		for (const [phase, log] of this.logs)
			this.tails.set(phase, await tail(log));
		this.drain(false);
	}

	/** Follow mode: print what the log gained since the last call, 1 MB at a
	 *  time; `final` reads to the end and prints a trailing partial line. */
	private drain(final: boolean): void {
		const f = this.followed;
		if (!f || !this.live) return;
		for (;;) {
			const size = sizeOf(f.path);
			if (size === undefined || size <= f.offset) break;
			const n = Math.min(size - f.offset, 1024 * 1024);
			const buf = Buffer.alloc(n);
			const fd = openSync(f.path, "r");
			let got = 0;
			try {
				got = readSync(fd, buf, 0, n, f.offset);
			} finally {
				closeSync(fd);
			}
			if (got === 0) break;
			f.offset += got;
			const text = f.decoder.decode(buf.subarray(0, got), { stream: true });
			const lines = (f.rest + text).split(/\r?\n/);
			f.rest = lines.pop() ?? "";
			if (lines.length > 0) this.live.persist(lines.join("\n"));
			if (!final) break;
		}
		if (final) {
			if (f.rest) this.live.persist(f.rest);
			this.followed = undefined;
		}
	}

	private render(): void {
		if (!this.live) return;
		const c = this.current;
		if (!c) {
			this.live.clear();
			return;
		}
		this.frame = (this.frame + 1) % FRAMES.length;
		const width = (process.stderr.columns || 100) - 1;
		const own = c.log ? `  ${showSize(this.tails.get(c.phase)?.size)}` : "";
		const head = `${chalk.cyan(FRAMES[this.frame])} ${this.title(c)}  ${fmtElapsed((Date.now() - c.t0) / 1000)}${chalk.dim(own)}`;
		const rows = [...this.logs].map(([phase, log]) => {
			const t = this.tails.get(phase) ?? { line: "" };
			const lead = `  ${basename(log).padEnd(12)} ${showSize(t.size).padStart(6)}  `;
			const room = Math.max(0, width - lead.length);
			const text =
				t.line.length > room
					? `${t.line.slice(0, Math.max(0, room - 1))}…`
					: t.line;
			return `${lead}${chalk.dim(text)}`;
		});
		this.live([head, ...rows].join("\n"));
	}
}
