// Default simulator compile flags: a portable baseline a config extends instead
// of re-listing. vcsBaseFlags() / verilatorBaseFlags() return arrays for a
// tool's `flags` or a case's `compileArgs`. SystemVerilog is mandatory
// (-sverilog / --sv) and VCS is always -full64; the structured options cover
// timescale, jobs and debug access, and `add` appends project flags, so one
// call does base-plus-overlay. dtsim's --wave owns the dump itself (VCS binds
// dump.tcl and adds -debug_access+all at compile time, Verilator binds its
// dump module and --trace-fst).

/** VCS -debug_access level. */
export type VcsDebugAccess = "all" | "pp" | "r" | "w" | "f" | "drivers";

export type VcsBaseOpts = {
	/** -timescale=<ts>, e.g. "1ns/1ps". */
	timescale?: string;
	/** -j<jobs> parallel compile. */
	jobs?: number | string;
	/** Optional -debug_access+<level> (e.g. "all"). dtsim's --wave adds
	 *  -debug_access+all on its own, so this is for explicit control. */
	debugaccess?: VcsDebugAccess;
	/** -kdb: write simv.daidir for verdi (run_verdi loads it). Default true. */
	kdb?: boolean;
	/** Extra flags appended after the baseline. */
	add?: readonly string[];
};

/** VCS compile baseline: -full64 -sverilog (always), plus the options given. */
export function vcsBaseFlags(opts: VcsBaseOpts = {}): string[] {
	return [
		"-full64",
		"-sverilog",
		...(opts.kdb === false ? [] : ["-kdb"]),
		...(opts.timescale ? [`-timescale=${opts.timescale}`] : []),
		...(opts.jobs === undefined ? [] : [`-j${opts.jobs}`]),
		...(opts.debugaccess ? [`-debug_access+${opts.debugaccess}`] : []),
		...(opts.add ?? []),
	];
}

export type VerilatorBaseOpts = {
	/** -j <jobs> parallel verilation and build. */
	jobs?: number | string;
	/** --timing (event and delay control); default false. */
	timing?: boolean;
	/** --timescale <ts>, e.g. "1ns/1ps". */
	timescale?: string;
	/** Extra flags appended after the baseline. */
	add?: readonly string[];
};

/** Verilator compile baseline: --sv (always), plus the options given. */
export function verilatorBaseFlags(opts: VerilatorBaseOpts = {}): string[] {
	return [
		"--sv",
		...(opts.timing ? ["--timing"] : []),
		...(opts.timescale ? ["--timescale", opts.timescale] : []),
		...(opts.jobs === undefined ? [] : ["-j", String(opts.jobs)]),
		...(opts.add ?? []),
	];
}
