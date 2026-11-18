// Built-in Verilator backend. No UVM plusargs, no fsdb/urg: it compiles an
// executable and runs it. Users tune flags with compileArgs/simArgs and the
// toolOptions { top, mdir } fields.
import { join } from "node:path";
import type { SimTool, ToolContext } from "../dsl/index.ts";

function verilatorOpts(ctx: ToolContext): { top: string; mdir: string } {
	const opts = ctx.caseOpts.toolOptions;
	return {
		top: typeof opts.top === "string" ? opts.top : "top",
		mdir: typeof opts.mdir === "string" ? opts.mdir : "obj_dir",
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

	fingerprint(c) {
		return [
			`top=${typeof c.toolOptions.top === "string" ? c.toolOptions.top : "top"}`,
			`mdir=${typeof c.toolOptions.mdir === "string" ? c.toolOptions.mdir : "obj_dir"}`,
		];
	},

	compile(ctx) {
		const { top, mdir } = verilatorOpts(ctx);
		return {
			argv: [
				"verilator",
				"--binary",
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
			executable: join(ctx.dir, mdir, `V${top}`),
		};
	},

	simulate(ctx) {
		const { top, mdir } = verilatorOpts(ctx);
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
