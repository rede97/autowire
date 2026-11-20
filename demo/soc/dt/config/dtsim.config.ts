// demo/soc smokes on two simulators. Run from demo/soc:
//   bun ../../index.ts dtsim run basic_smoke             (Verilator, the default)
//   DTSIM_TOOL=vcs bun ../../index.ts dtsim run basic_smoke  (or ./dt/vcs/run.sh)
//   bun ../../index.ts dtsim regr smoke            (DTSIM_TOOL=vcs for the farm)
// Filelists are relative to the project root (demo/soc); dtsim flattens them
// into each compile dir. Outputs: dt/simout/<tool>/<case>/.
// Verilator runs a C++ harness (tb_main.cpp), VCS the pure-SV aw-tb-mod
// tb_soc top; byTool holds what differs. The SD, tb_mod and sv_reg cases are
// Verilator-only (sdspisim is a C++ model).
import {
	Case,
	DefaultGrader,
	Group,
	VcsTool,
	VerilatorTool,
	Workspace,
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

// C++ harness (tb_main.cpp drives tb_soc_vl and the external JTAG host).
// The SD build links the sdspisim card model; it is a separate compile group.
function harness(sd: boolean) {
	return {
		filelists: ["harness.f"],
		toolOptions: { top: "tb_soc_vl", main: false },
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

// aw-tb-mod dump top (rtl/gen/sim/tb_soc.sv): basic_smoke + SV JTAG host.
export const tbMod = Case("tb_mod", {
	owner: "soc",
	tools: ["verilator"],
	filelists: ["tb_mod.f"],
	toolOptions: { top: "tb_soc" },
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
	toolOptions: { top: "sv_reg_smoke" },
	compileArgs: ["--timescale", "1ns/1ps", "-Wno-lint", "-Wno-style"],
	grader: smoke.extend({ pass: ["SV_REG SMOKE PASS"] }),
});

export default Workspace([], (mode) => {
	const opts = {
	tools: [
		VerilatorTool(),
		// Flags of the original VCS run.sh (pure SV, no UVM): the backend
		// defaults target newer VCS than O-2018.09. -debug_access+all is added
		// by the backend itself when wave is on.
		VcsTool({
			ntbOpts: "",
			top: "tb_soc",
			flags: ["-full64", "-sverilog", "-timescale=1ns/1ps"],
		}),
	],
	bareDefaults: {
		random: false,
		byTool: {
			verilator: { compileArgs: ["-j", "0", ...VL_WARN] },
			// --no-as-needed: VCS O-2018.09 on binutils >= 2.34 drops its own
			// shared libs.
			vcs: {
				filelists: ["vcs.f"],
				compileArgs: ["-LDFLAGS", "-Wl,--no-as-needed"],
				grader: smoke.extend({ pass: ["SMOKE PASS: tb_soc"] }),
			},
		},
	},
	// MAKE / MAKEFLAGS reach verilator --build and the firmware hook (e.g.
	// MAKEFLAGS=OPT_FAST=-O2); CROSS picks the RISC-V toolchain prefix.
	env: { passthrough: ["MAKE", "MAKEFLAGS", "CROSS", "MSYSTEM"] },
	task: { maxSlots: 4, maxCompiles: 2 },
	hooks: { preCompile: applyIpPatch, preSim: buildFirmware },
	groups: [
		Group("smoke", ["basic_smoke", "regfile_smoke", "tb_mod", "sv_reg_smoke"]),
		Group("sd", ["sd_sha256"]),
	],
	};
	// Tool selection is config-owned: sort the requested backend first so the
	// auto-fallback picks it (default Verilator, SIM_TOOL=vcs for the farm).
	if (process.env.SIM_TOOL) {
		opts.tools.sort(
			(a, b) =>
				Number(b.name === process.env.SIM_TOOL) -
				Number(a.name === process.env.SIM_TOOL),
		);
	}
	return opts;
});
