// Progress is a stream of events; the terminal is one subscriber. Tests can
// subscribe to the same events without a pty. stderr is the only progress
// stream; stdout stays clean for plans and result trees.
import { fmtElapsed } from "./scripts.ts";

export type TaskKind = "compile" | "sim";

type Running = { kind: TaskKind; label: string; log: string; t0: number };

export class Progress {
	private running = new Map<string, Running>();
	private counts = { compileDone: 0, compileTotal: 0, simDone: 0, simTotal: 0 };
	private renderedLines = 0;
	private timer?: Timer;
	private readonly tty: boolean;

	constructor(plain: boolean) {
		this.tty = !plain && Boolean(process.stderr.isTTY);
	}

	plan(compiles: number, sims: number): void {
		this.counts.compileTotal = compiles;
		this.counts.simTotal = sims;
		if (this.tty && !this.timer) {
			this.timer = setInterval(() => this.render(), 250);
		}
	}

	start(kind: TaskKind, label: string, log: string): void {
		const key = `${kind}:${label}`;
		this.running.set(key, { kind, label, log, t0: Date.now() });
		if (!this.tty) {
			process.stderr.write(`[dtsim] ${kind} start: ${label}\n`);
		}
	}

	done(kind: TaskKind, label: string, status: string, log: string): void {
		const key = `${kind}:${label}`;
		const task = this.running.get(key);
		this.running.delete(key);
		if (kind === "compile") this.counts.compileDone += 1;
		else this.counts.simDone += 1;
		const elapsed = task ? fmtElapsed((Date.now() - task.t0) / 1000) : "--:--";
		const size = logSize(log);
		this.clearDashboard();
		process.stderr.write(
			`[dtsim] ${kind} done: ${label} ${status} ${elapsed} log ${log} (${size})\n`,
		);
		this.render();
	}

	note(line: string): void {
		this.clearDashboard();
		process.stderr.write(`[dtsim] ${line}\n`);
		this.render();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.clearDashboard();
	}

	private clearDashboard(): void {
		if (!this.tty || this.renderedLines === 0) return;
		process.stderr.write(`\x1b[${this.renderedLines}F\x1b[0J`);
		this.renderedLines = 0;
	}

	private render(): void {
		if (!this.tty) return;
		const c = this.counts;
		const lines = [
			`compile ${c.compileDone}/${c.compileTotal}  sim ${c.simDone}/${c.simTotal}  slots ${this.running.size}`,
		];
		for (const task of this.running.values()) {
			const elapsed = fmtElapsed((Date.now() - task.t0) / 1000);
			lines.push(
				`  ${task.kind} ${task.label} ${elapsed} ${logSize(task.log)}`,
			);
		}
		this.renderedLines = lines.length;
		process.stderr.write(`${lines.join("\n")}\n`);
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
