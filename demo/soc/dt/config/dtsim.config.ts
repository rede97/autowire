// demo/soc Verilator smokes (primary DV path). Run from demo/soc:
//   bun ../../index.ts dtsim run basic_smoke     (or ./dt/verilator/run.sh)
//   bun ../../index.ts dtsim regr smoke
// VCS: dt/config/vcs.config.ts (./dt/vcs/run.sh).
// Filelists are relative to the project root (demo/soc); dtsim flattens them
// into each compile dir. Outputs: dt/simout/<case>/.
import { Case, Group, Hook, Workspace } from "./.dtsim/dsl/index.ts";

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
		filelist: "harness.f",
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
		grade: { pass: ["SMOKE PASS: verilator soc"] },
	};
}

export const basicSmoke = Case("basic_smoke", {
	owner: "soc",
	...harness(false),
	env: { FW: { value: "basic_smoke", scope: "sim" } },
	simArgs: [firmware("basic_smoke")],
});

export const regfileSmoke = Case("regfile_smoke", {
	owner: "soc",
	...harness(false),
	env: { FW: { value: "regfile_smoke", scope: "sim" } },
	simArgs: [firmware("regfile_smoke")],
});

export const sdSha256 = Case("sd_sha256", {
	owner: "soc",
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
	filelist: "tb_mod.f",
	toolOptions: { top: "tb_soc" },
	grade: { pass: ["SMOKE PASS: tb_soc"] },
	compileArgs: ["-CFLAGS", "-O2 -std=c++17", "-LDFLAGS", "-pthread"],
	env: { FW: { value: "basic_smoke", scope: "sim" } },
	simArgs: [firmware("basic_smoke")],
});

// Generated sv_reg packages only: no firmware, no bus RTL.
export const svRegSmoke = Case("sv_reg_smoke", {
	owner: "soc",
	filelist: "sv_reg.f",
	toolOptions: { top: "sv_reg_smoke" },
	compileArgs: ["--timescale", "1ns/1ps", "-Wno-lint", "-Wno-style"],
	grade: { pass: ["SV_REG SMOKE PASS"] },
});

export default Workspace({
	tool: "verilator",
	filelist: "harness.f",
	bareDefaults: {
		random: false,
		compileArgs: ["-j", "0", ...VL_WARN],
		grade: { error: ["FAIL:", "%Error"] },
	},
	// MAKE / MAKEFLAGS reach verilator --build and the firmware hook (e.g.
	// MAKEFLAGS=OPT_FAST=-O2); CROSS picks the RISC-V toolchain prefix.
	env: { passthrough: ["MAKE", "MAKEFLAGS", "CROSS", "MSYSTEM"] },
	task: { type: "local", maxSlots: 4, maxCompiles: 2 },
	hooks: {
		preCompile: Hook("hooks/pre_compile.sh"),
		preSim: Hook("hooks/pre_sim.sh"),
	},
	groups: [
		Group("smoke", ["basic_smoke", "regfile_smoke", "tb_mod", "sv_reg_smoke"]),
		Group("sd", ["sd_sha256"]),
	],
});
