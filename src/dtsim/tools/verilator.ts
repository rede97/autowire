// Built-in Verilator backend. No UVM plusargs, no fsdb/urg: it compiles an
// executable and runs it. Users tune flags with compileArgs/simArgs and the
// toolOptions { top, mdir, main } fields. main=false builds a C++ harness
// (--cc --exe --build; the .cpp files and --timing come from compileArgs)
// instead of --binary.
import { join } from "node:path";
import type { SimTool } from "../dsl/index.ts";

function verilatorOpts(opts: Record<string, unknown>): {
	top: string;
	mdir: string;
	main: boolean;
} {
	return {
		top: typeof opts.top === "string" ? opts.top : "top",
		mdir: typeof opts.mdir === "string" ? opts.mdir : "obj_dir",
		main: opts.main !== false,
	};
}

export const verilatorTool: SimTool = {
	kind: "dtsim-tool",
	id: "verilator",
	interactive: false,
	passthrough: [
		"PATH",
		"HOME",
		"USER",
		"LANG",
		"LC_ALL",
		"TMPDIR",
		"LD_LIBRARY_PATH",
		"VERILATOR_ROOT",
		"CC",
		"CXX",
		"SYSTEMC_INCLUDE",
		"SYSTEMC_LIBDIR",
	],
	compileErrors: [/%Error/, /%Fatal/],
	simErrors: [/%Error/, /%Fatal/],

	// The binary also depends on its top, -Mdir and --binary vs C++ harness.
	compileKey(c, base) {
		const { top, mdir, main } = verilatorOpts(c.toolOptions);
		return JSON.stringify([base, top, mdir, main]);
	},

	compile(ctx) {
		const { top, mdir, main } = verilatorOpts(ctx.caseOpts.toolOptions);
		return {
			argv: [
				"verilator",
				...(main ? ["--binary"] : ["--cc", "--exe", "--build"]),
				"--top-module",
				top,
				"-Mdir",
				mdir,
				"-f",
				ctx.filelist,
				...ctx.caseOpts.defines.map((d) => `-D${d}`),
				...ctx.caseOpts.compileArgs,
			].map((a) => ctx.expand(a)),
			cwd: ctx.dir,
			log: join(ctx.dir, "compile.log"),
			logMode: "tee",
			executable: join(
				ctx.dir,
				mdir,
				`V${top}${process.platform === "win32" ? ".exe" : ""}`,
			),
		};
	},

	simulate(ctx) {
		const { top, mdir } = verilatorOpts(ctx.caseOpts.toolOptions);
		return {
			argv: [
				join(ctx.compileDir, mdir, `V${top}`),
				...ctx.caseOpts.simArgs,
			].map((a) => ctx.expand(a)),
			cwd: ctx.dir,
			log: join(ctx.dir, "sim.log"),
			logMode: "tee",
		};
	},
};
