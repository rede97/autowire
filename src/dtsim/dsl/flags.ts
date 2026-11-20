// Default simulator compile flags: a portable baseline a config extends instead
// of re-listing. vcsBaseFlags() / verilatorBaseFlags() return arrays for a
// tool's `flags` or a case's `compileArgs`. The structured options override the
// defaults (`sv: false` drops SystemVerilog, etc.) and `add` appends project
// flags, so one call does base-plus-overlay. dtsim's --wave already binds the
// dump (VCS dump.tcl, Verilator dump module + --trace-fst), so no wave flag
// belongs here except VCS -debug_access+all, kept behind `debugAccessOnWave`.

export type VcsBaseOpts = {
	/** -timescale=<ts>, e.g. "1ns/1ps". */
	timescale?: string;
	/** -j<jobs> parallel compile. */
	jobs?: number | string;
	/** -sverilog (SystemVerilog); default true. */
	sv?: boolean;
	/** -full64; default true. */
	full64?: boolean;
	/** Add -debug_access+all when DTSIM_WAVE=1, so the UCLI fsdb dump can see
	 *  the design. Default false: dtsim already writes dump.tcl. */
	debugAccessOnWave?: boolean;
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
		...(opts.debugAccessOnWave && process.env.DTSIM_WAVE === "1"
			? ["-debug_access+all"]
			: []),
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
