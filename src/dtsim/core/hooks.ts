// User hooks are script files in the workspace, never functions inside the
// config: a file can be re-run later by `dtsim results --recheck`, and a
// throwing script cannot corrupt the scheduler.

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { HookPhase, HookSpec } from "../dsl/index.ts";
import { resolveCommand } from "./run.ts";

export type HookContext = {
	phase: HookPhase;
	caseId: string;
	seed?: string;
	dir: string;
	/** Config directory; relative hook paths resolve against it. */
	verify: string;
	tool: string;
	log?: string;
	status?: string;
	env: Record<string, string>;
};

export type HookOutcome = {
	ok: boolean;
	log: string;
	code: number;
	/** First stdout line; the onGrade protocol reads the status from it. */
	firstLine: string;
};

export async function runHook(
	spec: HookSpec,
	ctx: HookContext,
): Promise<HookOutcome> {
	const script = isAbsolute(spec.path)
		? spec.path
		: resolve(ctx.verify, spec.path);
	const log = `${ctx.dir}/hook-${ctx.phase}.log`;
	const argv = script.endsWith(".ts")
		? ["bun", script]
		: script.endsWith(".sh")
			? ["bash", script]
			: [script];
	const args = [
		"--phase",
		ctx.phase,
		"--case",
		ctx.caseId,
		...(ctx.seed === undefined ? [] : ["--seed", ctx.seed]),
		"--dir",
		ctx.dir,
		"--tool",
		ctx.tool,
		...(ctx.log === undefined ? [] : ["--log", ctx.log]),
		...(ctx.status === undefined ? [] : ["--status", ctx.status]),
	];
	const out = createWriteStream(log, { flags: "a" });
	const env = { ...ctx.env, DTSIM_HOOK: ctx.phase };
	const cmd = resolveCommand([...argv, ...args], env, ctx.dir);
	const child = spawn(cmd[0] as string, cmd.slice(1), {
		cwd: ctx.dir,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	// Both streams share one log; end it once after the child closes, not when
	// the first stream ends (stderr written after stdout closed would throw).
	child.stdout?.pipe(out, { end: false });
	child.stderr?.pipe(out, { end: false });
	const timer = setTimeout(() => child.kill("SIGKILL"), spec.timeoutSec * 1000);
	const { promise, resolve: done } = Promise.withResolvers<number>();
	child.on("error", () => done(127));
	child.on("close", (code: number | null) => done(code ?? 1));
	const code = await promise;
	clearTimeout(timer);
	const closed = Promise.withResolvers<void>();
	out.end(() => closed.resolve());
	await closed.promise;
	return {
		ok: code === 0,
		log,
		code,
		firstLine: stdout.split("\n")[0]?.trim() ?? "",
	};
}
