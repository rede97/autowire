// Subprocess execution. Logs go to files by default; the terminal only sees
// them with --verbose. Regression children always get stdin = /dev/null and
// are killed through the scheduler's AbortSignal, never per-child SIGINT
// listeners (a regression can have hundreds of children).
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

export type RunOpts = {
	argv: string[];
	cwd: string;
	env: Record<string, string>;
	/** Capture stdout/stderr into this file (logMode "tee"). */
	captureLog?: string;
	verbose: boolean;
	/** Single case only: attach the terminal and handle Ctrl+C here. */
	interactive: boolean;
	abort?: AbortSignal;
};

export async function runProcess(opts: RunOpts): Promise<number> {
	if (opts.abort?.aborted) return -15;
	const capture = opts.captureLog !== undefined;
	const stream = capture
		? createWriteStream(opts.captureLog as string, { flags: "a" })
		: undefined;
	const child = spawn(opts.argv[0] as string, opts.argv.slice(1), {
		cwd: opts.cwd,
		env: opts.env,
		stdio: [
			opts.interactive ? "inherit" : "ignore",
			capture || opts.verbose ? "pipe" : "ignore",
			capture || opts.verbose ? "pipe" : "ignore",
		],
	});
	const forward = (
		source: NodeJS.ReadableStream | null,
		target: NodeJS.WritableStream,
	): void => {
		source?.on("data", (chunk: Buffer) => {
			stream?.write(chunk);
			if (opts.verbose) target.write(chunk);
		});
	};
	forward(child.stdout, process.stdout);
	forward(child.stderr, process.stderr);

	let lastSigint = 0;
	const onSigint = (): void => {
		const now = Date.now();
		if (opts.interactive && now - lastSigint > 2000) {
			lastSigint = now;
			process.stderr.write(
				"\n[dtsim] Ctrl+C passed to child; press again within 2s to force-kill\n",
			);
			child.kill("SIGINT");
			return;
		}
		child.kill("SIGKILL");
	};
	const onAbort = (): void => {
		child.kill("SIGKILL");
	};
	// Only the single-case runner owns SIGINT; regression uses abort.
	if (opts.interactive) process.on("SIGINT", onSigint);
	opts.abort?.addEventListener("abort", onAbort, { once: true });

	const { promise, resolve } = Promise.withResolvers<number>();
	child.on("error", () => resolve(127));
	child.on("close", (exitCode: number | null) => resolve(exitCode ?? 1));
	const code = await promise;

	if (opts.interactive) process.removeListener("SIGINT", onSigint);
	opts.abort?.removeEventListener("abort", onAbort);
	if (stream) {
		const closed = Promise.withResolvers<void>();
		stream.end(() => closed.resolve());
		await closed.promise;
	}
	return code;
}
