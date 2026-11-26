// Subprocess execution. Logs go to files by default; the terminal only sees
// them with --verbose. Regression children always get stdin = /dev/null and
// are killed through the scheduler's AbortSignal, never per-child SIGINT
// listeners (a regression can have hundreds of children).
import { spawn } from "node:child_process";
import {
	closeSync,
	createWriteStream,
	existsSync,
	openSync,
	readSync,
	statSync,
} from "node:fs";
import { stat } from "node:fs/promises";
import { delimiter, extname, isAbsolute, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Subprocess } from "bun";

const WIN_EXE = [".exe", ".com", ".cmd", ".bat"];

/** Where `name` can resolve: a path with a separator as-is (against `cwd`
 *  when relative), else each PATH dir. Windows also tries the executable
 *  extensions; elsewhere only the bare name. */
function pathCandidates(
	name: string,
	env: Record<string, string>,
	cwd: string,
): string[] {
	const exts =
		process.platform === "win32" && !extname(name) ? [...WIN_EXE, ""] : [""];
	const dirs =
		name.includes("/") || name.includes("\\")
			? [isAbsolute(name) ? "" : cwd]
			: (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
	return dirs.flatMap((dir) =>
		exts.map((ext) => (dir ? resolve(dir, name + ext) : name + ext)),
	);
}

/** Find `name` the way Windows would, plus extensionless (shebang) files. */
function winLookup(
	name: string,
	env: Record<string, string>,
	cwd: string,
): string | undefined {
	return pathCandidates(name, env, cwd).find(
		(c) => existsSync(c) && statSync(c).isFile(),
	);
}

/** Is `name` an executable on PATH? Probes every candidate concurrently, so
 *  launcher detection does not serialise stat latency on a slow or networked
 *  filesystem. Outside Windows the file needs an exec bit. */
async function onPath(name: string): Promise<boolean> {
	const candidates = pathCandidates(
		name,
		process.env as Record<string, string>,
		process.cwd(),
	);
	const hits = await Promise.all(
		candidates.map((c) =>
			stat(c).then(
				(s) =>
					s.isFile() &&
					(process.platform === "win32" || (s.mode & 0o111) !== 0),
				() => false,
			),
		),
	);
	return hits.some(Boolean);
}

/** A tool or launcher `probe`: available when every executable is on PATH
 *  (no probe: always available). */
export async function probeOk(probe: readonly string[] = []): Promise<boolean> {
	return (await Promise.all(probe.map(onPath))).every(Boolean);
}

/**
 * Windows cannot exec shebang scripts (mock tools, UCRT64 `verilator`, which
 * is a perl script). Resolve such a command to `<interpreter> <script> ...`
 * with the interpreter looked up on the child's PATH. Elsewhere: unchanged.
 */
export function resolveCommand(
	argv: string[],
	env: Record<string, string>,
	cwd: string,
): string[] {
	if (process.platform !== "win32" || argv.length === 0) return argv;
	const [cmd, ...rest] = argv as [string, ...string[]];
	const found = winLookup(cmd, env, cwd);
	if (!found || WIN_EXE.includes(extname(found).toLowerCase())) return argv;
	const head = Buffer.alloc(256);
	const fd = openSync(found, "r");
	const n = readSync(fd, head, 0, head.length, 0);
	closeSync(fd);
	const first = head.subarray(0, n).toString("utf8").split(/\r?\n/)[0] ?? "";
	if (!first.startsWith("#!")) return argv;
	// "#!/usr/bin/env perl -w" -> perl -w; "#!/bin/bash" -> bash
	const words = first.slice(2).trim().split(/\s+/);
	const named = words[0]?.endsWith("/env") ? words.slice(1) : words;
	const interp = named[0]?.split("/").at(-1);
	if (!interp) return argv;
	// Forward slashes: MSYS perl derives paths from its script path (UCRT64
	// verilator sets VERILATOR_ROOT from it); "C:/x" stays usable by the
	// native verilator_bin, "C:\x" turns into an MSYS-only "/ucrt64/...".
	const script = found.replaceAll("\\", "/");
	return [
		winLookup(interp, env, cwd) ?? interp,
		...named.slice(1),
		script,
		...rest,
	];
}

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
	/** Every output line of the child as it arrives (colour, other control
	 *  bytes and carriage-return redraws removed). */
	onLine?: (line: string) => void;
	/** With onLine: run the child on a pseudo-terminal so it flushes line by
	 *  line, as on a terminal (POSIX only; Windows keeps pipes, since ConPTY
	 *  re-renders the output). The tee log then gets the cleaned lines. */
	pty?: boolean;
};

/** A line as a terminal would leave it: what follows the last carriage
 *  return, without escape sequences or other control bytes. */
function cleanLine(raw: string): string {
	const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
	const visible = line.slice(line.lastIndexOf("\r") + 1);
	const shown = stripVTControlCharacters(visible);
	// biome-ignore lint/suspicious/noControlCharactersInRegex: tool output may carry control bytes
	return shown.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/** Whole output lines out of a byte stream; `end()` flushes a trailing
 *  partial line. */
type LineSplitter = { push(chunk: Uint8Array): void; end(): void };

function lineSplitter(emit: (line: string) => void): LineSplitter {
	const decoder = new TextDecoder();
	let rest = "";
	return {
		push(chunk) {
			const parts = (rest + decoder.decode(chunk, { stream: true })).split(
				"\n",
			);
			rest = parts.pop() ?? "";
			for (const part of parts) emit(cleanLine(part));
		},
		end() {
			rest += decoder.decode();
			if (rest.length > 0) emit(cleanLine(rest));
			rest = "";
		},
	};
}

export async function runProcess(opts: RunOpts): Promise<number> {
	if (opts.abort?.aborted) return -15;
	const capture = opts.captureLog !== undefined;
	const stream = capture
		? createWriteStream(opts.captureLog as string, { flags: "a" })
		: undefined;
	const argv = resolveCommand(opts.argv, opts.env, opts.cwd);
	const code =
		opts.onLine && opts.pty && !opts.interactive && process.platform !== "win32"
			? await runOnPty(opts, argv, stream, opts.onLine)
			: await runOnPipes(opts, argv, stream);
	if (stream) {
		const closed = Promise.withResolvers<void>();
		stream.end(() => closed.resolve());
		await closed.promise;
	}
	return code;
}

/** The child on a pseudo-terminal: one stream, line-buffered like a shell. */
async function runOnPty(
	opts: RunOpts,
	argv: string[],
	stream: NodeJS.WritableStream | undefined,
	onLine: (line: string) => void,
): Promise<number> {
	const lines = lineSplitter((line) => {
		stream?.write(`${line}\n`);
		onLine(line);
	});
	const closed = Promise.withResolvers<void>();
	let proc: Subprocess;
	try {
		proc = Bun.spawn(argv, {
			cwd: opts.cwd,
			env: opts.env,
			// Wide enough that the child never wraps a line for the terminal.
			terminal: {
				cols: 1000,
				rows: 50,
				data: (_t, data) => lines.push(data),
				exit: () => closed.resolve(),
			},
		});
	} catch (error) {
		const line = `dtsim: cannot start ${argv[0]}: ${(error as Error).message}`;
		stream?.write(`${line}\n`);
		onLine(line);
		return 127;
	}
	const onAbort = (): void => {
		proc.kill("SIGKILL");
	};
	opts.abort?.addEventListener("abort", onAbort, { once: true });
	await proc.exited;
	// Output still in the PTY reaches `data` before its stream closes.
	await Promise.race([closed.promise, Bun.sleep(1000)]);
	proc.terminal?.close();
	lines.end();
	opts.abort?.removeEventListener("abort", onAbort);
	return proc.exitCode ?? 1;
}

async function runOnPipes(
	opts: RunOpts,
	argv: string[],
	stream: NodeJS.WritableStream | undefined,
): Promise<number> {
	const piped = stream !== undefined || opts.verbose || opts.onLine;
	const child = spawn(argv[0] as string, argv.slice(1), {
		cwd: opts.cwd,
		env: opts.env,
		stdio: [
			opts.interactive ? "inherit" : "ignore",
			piped ? "pipe" : "ignore",
			piped ? "pipe" : "ignore",
		],
	});
	const splitters: LineSplitter[] = [];
	const forward = (
		source: NodeJS.ReadableStream | null,
		target: NodeJS.WritableStream,
	): void => {
		const lines = opts.onLine ? lineSplitter(opts.onLine) : undefined;
		if (lines) splitters.push(lines);
		source?.on("data", (chunk: Buffer) => {
			stream?.write(chunk);
			if (opts.verbose) target.write(chunk);
			lines?.push(chunk);
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
				"\nCtrl+C passed to the simulator; press again within 2s to force-kill\n",
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
	child.on("error", (error) => {
		// Not started at all (missing tool, bad cwd): say so instead of a bare 127.
		const line = `dtsim: cannot start ${argv[0]}: ${error.message}\n`;
		stream?.write(line);
		process.stderr.write(line);
		resolve(127);
	});
	child.on("close", (exitCode: number | null) => resolve(exitCode ?? 1));
	const code = await promise;
	for (const lines of splitters) lines.end();

	if (opts.interactive) process.removeListener("SIGINT", onSigint);
	opts.abort?.removeEventListener("abort", onAbort);
	return code;
}
