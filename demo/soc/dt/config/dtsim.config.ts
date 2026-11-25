// demo/soc smokes on two simulators. Run from demo/soc:
//   bun ../../index.ts dtsim run basic_smoke             (Verilator, the default)
//   SIM_TOOL=vcs bun ../../index.ts dtsim run basic_smoke  (or ./dt/vcs/run.sh)
//   bun ../../index.ts dtsim regr smoke --wave     (fst / fsdb per seed)
// Filelists name sources as $WORKSPACE/... (the project root, demo/soc): the
// simulator compiles in dt/simout/<tool>/<case>/, which is also the output.
// Every bench's top module is tb_top (the Workspace default): the Verilator
// C++ harness (tb_main.cpp), the pure-SV aw-tb-mod dump and the sv_reg smoke.
// byTool holds what differs per simulator. The SD, tb_mod and sv_reg cases
// are Verilator-only (sdspisim is a C++ model).
import {
	Case,
	DefaultGrader,
	Group,
	VcsTool,
	VerilatorTool,
	Workspace,
	vcsBaseFlags,
	verilatorBaseFlags,
} from "../../../../src/dtsim/dsl/index.ts";
import { applyIpPatch, buildFirmware } from "./hooks.ts";

// Every case: firmware "FAIL:" lines and Verilator %Error are errors; each
// case adds its own pass line.
const smoke = DefaultGrader({ error: ["FAIL:", "%Error"] });

const VL_WARN = [
	"-Wno-fatal",
	"-Wno-WIDTH",
	"-Wno-CASEINCOMPLETE",
	"-Wno-UNOPTFLAT",
	"-Wno-BLKANDNBLK",
	"-Wno-INITIALDLY",
	"-Wno-TIMESCALEMOD",
];
const VL_DIR = "${workspace}/dt/verilator";
const SDSPISIM = `${VL_DIR}/third_party/sdspisim`;
const firmware = (fw: string) =>
	`+firmware=\${workspace}/fw/${fw}/build/firmware.hex`;

// C++ harness (tb_main.cpp drives tb_top and the external JTAG host).
// The SD build links the sdspisim card model; it is a separate compile group.
function harness(sd: boolean) {
	return {
		filelists: ["harness.f"],
		toolOptions: { main: false },
		compileArgs: [
			"-Wall",
			"--timing",
			"-CFLAGS",
			`-O2 -std=c++17 -I${VL_DIR}${sd ? ` -DSOC_USE_SDSPISIM -I${SDSPISIM}` : ""}`,
			"-LDFLAGS",
			"-pthread",
			`${VL_DIR}/tb_main.cpp`,
			...(sd ? [`${SDSPISIM}/sdspisim.cpp`] : []),
		],
		// "JTAG SMOKE PASS" alone is not a pass: tb_main prints this last.
		grader: smoke.extend({ pass: ["SMOKE PASS: verilator soc"] }),
	};
}

export const basicSmoke = Case("basic_smoke", {
	owner: "soc",
	env: { FW: { value: "basic_smoke", scope: "sim" } },
	simArgs: [firmware("basic_smoke")],
	byTool: { verilator: harness(false) },
});

export const regfileSmoke = Case("regfile_smoke", {
	owner: "soc",
	env: { FW: { value: "regfile_smoke", scope: "sim" } },
	simArgs: [firmware("regfile_smoke")],
	byTool: { verilator: harness(false) },
});

export const sdSha256 = Case("sd_sha256", {
	owner: "soc",
	tools: ["verilator"],
	...harness(true),
	env: {
		FW: { value: "sd_sha256", scope: "sim" },
		SD_IMAGE: { value: "${output_dir}/zeros_sha.img", scope: "sim" },
	},
	simArgs: [firmware("sd_sha256"), "+sdcard=${output_dir}/zeros_sha.img"],
});

// aw-tb-mod dump top (rtl/gen/sim/soc_tb.sv): basic_smoke + SV JTAG host.
export const tbMod = Case("tb_mod", {
	owner: "soc",
	tools: ["verilator"],
	filelists: ["tb_mod.f"],
	grader: smoke.extend({ pass: ["SMOKE PASS: tb_soc"] }),
	compileArgs: ["-CFLAGS", "-O2 -std=c++17", "-LDFLAGS", "-pthread"],
	env: { FW: { value: "basic_smoke", scope: "sim" } },
	simArgs: [firmware("basic_smoke")],
});

// Generated sv_reg packages only: no firmware, no bus RTL.
export const svRegSmoke = Case("sv_reg_smoke", {
	owner: "soc",
	tools: ["verilator"],
	filelists: ["sv_reg.f"],
	compileArgs: ["--timescale", "1ns/1ps", "-Wno-lint", "-Wno-style"],
	grader: smoke.extend({ pass: ["SV_REG SMOKE PASS"] }),
});

const verilator = VerilatorTool();
// Flags of the original VCS run.sh (pure SV, no UVM): the backend defaults
// target newer VCS than O-2018.09.
const vcs = VcsTool({ ntbOpts: "", flags: vcsBaseFlags({ timescale: "1ns/1ps" }) });

export default Workspace(
	[
		{
			name: "SIM_TOOL",
			values: "verilator|vcs",
			default: "verilator",
			desc: "simulator tried first (the other is the fallback)",
		},
		{ name: "WAVE", values: "0|1", default: "0", flags: "--wave", desc: "dump waveforms" },
	],
	() => ({
		// Tool selection is config-owned: the first available tool runs.
		tools: process.env.SIM_TOOL === "vcs" ? [vcs, verilator] : [verilator, vcs],
		wave: process.env.WAVE === "1",
		bareDefaults: {
			random: false,
			byTool: {
				verilator: {
					compileArgs: verilatorBaseFlags({ jobs: 0, add: VL_WARN }),
					// MSYS2 UCRT64 GCC 16.2 at Verilator's default -Os calls a
					// std::string constructor libstdc++-6.dll does not export, so
					// verilated.o fails to link; build the C++ at -O2 instead. Any
					// MAKEFLAGS of the caller (-j ...) is kept.
					env: {
						MAKEFLAGS: {
							value: `${process.env.MAKEFLAGS ?? ""} OPT_FAST=-O2 OPT_GLOBAL=-O2`.trim(),
							scope: "compile",
						},
					},
				},
				// --no-as-needed: VCS O-2018.09 on binutils >= 2.34 drops its own
				// shared libs.
				vcs: {
					filelists: ["vcs.f"],
					compileArgs: ["-LDFLAGS", "-Wl,--no-as-needed"],
					grader: smoke.extend({ pass: ["SMOKE PASS: tb_soc"] }),
				},
			},
		},
		// MAKE / MAKEFLAGS reach the firmware hook; CROSS picks the RISC-V
		// toolchain prefix.
		env: { passthrough: ["MAKE", "MAKEFLAGS", "CROSS", "MSYSTEM"] },
		task: { maxSlots: 4, maxCompiles: 2 },
		hooks: { preCompile: applyIpPatch, preSim: buildFirmware },
		groups: [
			Group("smoke", ["basic_smoke", "regfile_smoke", "tb_mod", "sv_reg_smoke"]),
			Group("sd", ["sd_sha256"]),
		],
	}),
);
