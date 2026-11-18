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
import { delimiter, extname, isAbsolute, resolve } from "node:path";

const WIN_EXE = [".exe", ".com", ".cmd", ".bat"];

/** Find `name` the way Windows would, plus extensionless (shebang) files. */
function winLookup(
	name: string,
	env: Record<string, string>,
	cwd: string,
): string | undefined {
	const exts = extname(name) ? [""] : [...WIN_EXE, ""];
	const dirs =
		name.includes("/") || name.includes("\\")
			? [isAbsolute(name) ? "" : cwd]
			: (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
	for (const dir of dirs) {
		for (const ext of exts) {
			const candidate = dir ? resolve(dir, name + ext) : name + ext;
			if (existsSync(candidate) && statSync(candidate).isFile())
				return candidate;
		}
	}
	return undefined;
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
};

export async function runProcess(opts: RunOpts): Promise<number> {
	if (opts.abort?.aborted) return -15;
	const capture = opts.captureLog !== undefined;
	const stream = capture
		? createWriteStream(opts.captureLog as string, { flags: "a" })
		: undefined;
	const argv = resolveCommand(opts.argv, opts.env, opts.cwd);
	const child = spawn(argv[0] as string, argv.slice(1), {
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

	if (opts.interactive) process.removeListener("SIGINT", onSigint);
	opts.abort?.removeEventListener("abort", onAbort);
	if (stream) {
		const closed = Promise.withResolvers<void>();
		stream.end(() => closed.resolve());
		await closed.promise;
	}
	return code;
}
