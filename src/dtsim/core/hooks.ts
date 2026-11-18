// Hooks are TypeScript callbacks from the workspace config. They run in the
// dtsim process with one context shape for every stage; `ctx.sh` runs shell
// commands with the phase's isolated environment and logs their output.
import { spawn } from "node:child_process";
import { appendFileSync, createWriteStream, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type Hook,
	type HookContext,
	type HookStage,
	type HookStatus,
	type Hooks,
	Status,
} from "../dsl/index.ts";
import { resolveCommand } from "./run.ts";

/** The context without `sh`, which runHooks adds for the stage's log. */
export type HookBase = Omit<HookContext, "sh">;

export function hookLog(dir: string, stage: HookStage): string {
	return join(dir, `hook-${stage}.log`);
}

function shellFor(base: HookBase, log: string): HookContext["sh"] {
	return async (command, opts = {}) => {
		appendFileSync(log, `$ ${command}\n`);
		const env = { ...base.env, DTSIM_HOOK: base.stage };
		const argv = resolveCommand(["bash", "-c", command], env, base.dir);
		const out = createWriteStream(log, { flags: "a" });
		const child = spawn(argv[0] as string, argv.slice(1), {
			cwd: base.dir,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		// Both streams share one log; end it once after the child closes, not
		// when the first stream ends (later stderr would throw).
		child.stdout?.pipe(out, { end: false });
		child.stderr?.pipe(out, { end: false });
		const timer =
			opts.timeoutSec === undefined
				? undefined
				: setTimeout(() => child.kill("SIGKILL"), opts.timeoutSec * 1000);
		const { promise, resolve } = Promise.withResolvers<number>();
		child.on("error", () => resolve(127));
		child.on("close", (code: number | null) => resolve(code ?? 1));
		const code = await promise;
		clearTimeout(timer);
		const closed = Promise.withResolvers<void>();
		out.end(() => closed.resolve());
		await closed.promise;
		if (code !== 0) {
			throw new Error(`sh exited ${code}: ${command} (log ${log})`);
		}
		return stdout;
	};
}

/** The stage's context with `sh`; starts a fresh hook log (a reused
 *  regression compile dir must not carry the previous run's log). */
function withShell(base: HookBase): { ctx: HookContext; log: string } {
	const log = hookLog(base.dir, base.stage);
	writeFileSync(log, "");
	return { ctx: { ...base, sh: shellFor(base, log) }, log };
}

function errorText(error: unknown): string {
	return error instanceof Error
		? (error.stack ?? error.message)
		: String(error);
}

export type HookFailure = { log: string; message: string };

/** Run the stage's hooks in order. The first throw stops the rest; its stack
 *  goes to the hook log. Undefined when every hook returned normally. */
export async function runHooks(
	hooks: Hooks,
	base: HookBase,
): Promise<HookFailure | undefined> {
	const value = hooks[base.stage as Exclude<HookStage, "onGrade">];
	if (!value) return undefined;
	const fns: readonly Hook[] = Array.isArray(value) ? value : [value as Hook];
	const { ctx, log } = withShell(base);
	for (const [i, fn] of fns.entries()) {
		try {
			await fn(ctx);
		} catch (error) {
			const message = `${base.stage} hook #${i + 1} (${fn.name || "anonymous"}) threw:\n${errorText(error)}`;
			appendFileSync(log, `${message}\n`);
			return { log, message };
		}
	}
	return undefined;
}

const HOOK_STATUSES: readonly string[] = Object.values(Status).filter(
	(s) => s !== Status.Aborted,
);

/** Run onGrade. A throw or a value outside HookStatus grades FAIL (logged). */
export async function runGradeHook(
	hooks: Hooks,
	base: HookBase,
): Promise<HookStatus | undefined> {
	const grade = hooks.onGrade;
	if (!grade) return undefined;
	const { ctx, log } = withShell(base);
	try {
		const status = await grade(ctx);
		if (HOOK_STATUSES.includes(status)) return status;
		appendFileSync(
			log,
			`onGrade returned ${JSON.stringify(status)}; graded FAIL\n`,
		);
	} catch (error) {
		appendFileSync(log, `onGrade threw:\n${errorText(error)}\n`);
	}
	return "FAIL";
}
