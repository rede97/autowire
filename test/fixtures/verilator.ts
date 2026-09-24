// Verilator --binary --timing runner for RTL simulation tests.
// Windows (MSYS2 UCRT64 on PATH): the perl wrapper `verilator` is not
// runnable, so call verilator_bin directly with VERILATOR_ROOT derived from
// its location and mingw32-make as MAKE.
import { test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const bin = Bun.which("verilator_bin") ?? Bun.which("verilator");
const make = Bun.which("make") ?? Bun.which("mingw32-make");

export const verilatorTest = bin && make ? test : test.skip;

function verilatorEnv(): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...process.env };
	if (make) env.MAKE = make;
	if (!env.VERILATOR_ROOT && bin) {
		const root = join(dirname(bin), "..", "share", "verilator");
		if (existsSync(join(root, "include", "verilated.mk")))
			env.VERILATOR_ROOT = root.replaceAll("\\", "/");
	}
	return env;
}

export interface VerilatorRun {
	buildOk: boolean;
	buildLog: string;
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

/** Build `sources` with top `top` into `dir`, then run the binary. */
export function verilatorSim(o: {
	dir: string;
	top: string;
	sources: string[];
	args?: string[];
}): VerilatorRun {
	const env = verilatorEnv();
	const build = Bun.spawnSync({
		cmd: [
			bin ?? "verilator",
			"--binary",
			"--timing",
			"-j",
			"0",
			"--timescale",
			"1ns/1ps",
			"--top-module",
			o.top,
			"--Mdir",
			o.dir,
			"-Wno-fatal",
			"-Wno-lint",
			"-Wno-style",
			/* MinGW GCC 16 libstdc++ misses std::string symbols under C++20. */
			"-CFLAGS",
			"-std=c++17",
			...(o.args ?? []),
			...o.sources,
			"-o",
			`V${o.top}`,
		],
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const buildLog = build.stdout.toString() + build.stderr.toString();
	if (build.exitCode !== 0)
		return { buildOk: false, buildLog, exitCode: null, stdout: "", stderr: "" };
	const exe = join(
		o.dir,
		`V${o.top}${process.platform === "win32" ? ".exe" : ""}`,
	);
	const run = Bun.spawnSync({
		cmd: [exe],
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		buildOk: true,
		buildLog,
		exitCode: run.exitCode,
		stdout: run.stdout.toString(),
		stderr: run.stderr.toString(),
	};
}
