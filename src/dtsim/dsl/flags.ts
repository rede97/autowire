// Default simulator compile flags: a portable baseline a config extends instead
// of re-listing. vcsBaseFlags() / verilatorBaseFlags() return arrays for a
// tool's `flags` or a case's `compileArgs`. The structured options override the
// defaults (`sv: false` drops SystemVerilog, etc.) and `add` appends project
// flags, so one call does base-plus-overlay. dtsim's --wave owns every wave
// flag (VCS binds dump.tcl and adds -debug_access+all at compile time,
// Verilator binds its dump module and --trace-fst), so none belongs here.

export type VcsBaseOpts = {
	/** -timescale=<ts>, e.g. "1ns/1ps". */
	timescale?: string;
	/** -j<jobs> parallel compile. */
	jobs?: number | string;
	/** -sverilog (SystemVerilog); default true. */
	sv?: boolean;
	/** -full64; default true. */
	full64?: boolean;
	/** Extra flags appended after the baseline. */
	add?: readonly string[];
};

/** Portable VCS compile baseline: -full64 -sverilog, plus the options given. */
export function vcsBaseFlags(opts: VcsBaseOpts = {}): string[] {
	return [
		...(opts.full64 === false ? [] : ["-full64"]),
		...(opts.sv === false ? [] : ["-sverilog"]),
		...(opts.timescale ? [`-timescale=${opts.timescale}`] : []),
		...(opts.jobs === undefined ? [] : [`-j${opts.jobs}`]),
		...(opts.add ?? []),
	];
}

export type VerilatorBaseOpts = {
	/** -j <jobs> parallel verilation and build. */
	jobs?: number | string;
	/** --sv (SystemVerilog); default true. */
	sv?: boolean;
	/** --timing (event and delay control); default false. */
	timing?: boolean;
	/** --timescale <ts>, e.g. "1ns/1ps". */
	timescale?: string;
	/** Extra flags appended after the baseline. */
	add?: readonly string[];
};

/** Portable Verilator compile baseline: --sv, plus the options given. */
export function verilatorBaseFlags(opts: VerilatorBaseOpts = {}): string[] {
	return [
		...(opts.sv === false ? [] : ["--sv"]),
		...(opts.timing ? ["--timing"] : []),
		...(opts.timescale ? ["--timescale", opts.timescale] : []),
		...(opts.jobs === undefined ? [] : ["-j", String(opts.jobs)]),
		...(opts.add ?? []),
	];
}
