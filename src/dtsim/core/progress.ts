// Regression progress on stderr; stdout stays clean for plans and results.
// A TTY gets a live dashboard (log-update) above which finished tasks are
// printed; anything else (--plain, pipes, LSF logs) gets one line per event.
import chalk from "chalk";
import type logUpdate from "log-update";
import { createLogUpdate } from "log-update";
import { fmtElapsed } from "./scripts.ts";
import { status as colour, table } from "./ui.ts";

export type TaskKind = "compile" | "sim";

type Running = { kind: TaskKind; label: string; log: string; t0: number };

export class Progress {
	private running = new Map<string, Running>();
	private counts = { compileDone: 0, compileTotal: 0, simDone: 0, simTotal: 0 };
	private timer?: Timer;
	private readonly live?: typeof logUpdate;

	constructor(plain: boolean) {
		if (!plain && process.stderr.isTTY) {
			this.live = createLogUpdate(process.stderr, { showCursor: true });
		}
	}

	plan(compiles: number, sims: number): void {
		this.counts.compileTotal = compiles;
		this.counts.simTotal = sims;
		if (this.live && !this.timer) {
			this.timer = setInterval(() => this.render(), 250);
		}
	}

	start(kind: TaskKind, label: string, log: string): void {
		this.running.set(`${kind}:${label}`, { kind, label, log, t0: Date.now() });
		if (!this.live) process.stderr.write(`${kind} ${label} started\n`);
	}

	done(kind: TaskKind, label: string, status: string, log: string): void {
		const key = `${kind}:${label}`;
		const task = this.running.get(key);
		this.running.delete(key);
		if (kind === "compile") this.counts.compileDone += 1;
		else this.counts.simDone += 1;
		const elapsed = task ? fmtElapsed((Date.now() - task.t0) / 1000) : "--:--";
		this.line(
			`${kind} ${label} ${colour(status)} ${elapsed} ${chalk.dim(`${log} (${logSize(log)})`)}`,
		);
	}

	note(text: string): void {
		this.line(text);
	}

	stop(): void {
		clearInterval(this.timer);
		this.timer = undefined;
		this.live?.clear();
		this.live?.done();
	}

	/** A permanent line: persisted above the dashboard, which is then redrawn. */
	private line(text: string): void {
		if (!this.live) {
			process.stderr.write(`${text}\n`);
			return;
		}
		this.live.persist(text);
		this.render();
	}

	private render(): void {
		if (!this.live) return;
		const c = this.counts;
		const head = `compile ${c.compileDone}/${c.compileTotal}  sim ${c.simDone}/${c.simTotal}  running ${this.running.size}`;
		const rows = [...this.running.values()].map((t) => [
			t.kind,
			t.label,
			fmtElapsed((Date.now() - t.t0) / 1000),
			logSize(t.log),
		]);
		this.live(
			rows.length ? `${chalk.bold(head)}\n${table(rows)}` : chalk.bold(head),
		);
	}
}

function logSize(path: string): string {
	try {
		const size = Bun.file(path).size;
		return size > 1024 * 1024
			? `${(size / 1024 / 1024).toFixed(1)}M`
			: `${Math.round(size / 1024)}K`;
	} catch {
		return "0K";
	}
}
