// demo/soc VCS smokes (aw-tb-mod tb_soc top, same as the Verilator tb_mod case).
// Run from demo/soc (-d vcs keeps outputs apart from the Verilator runs):
//   bun ../../index.ts dtsim run basic_smoke --config dt/config/vcs.config.ts --no-wave -d vcs
//   ./dt/vcs/run.sh [basic_smoke|regfile_smoke]
// The SD card-image case stays Verilator-only (sdspisim is a C++ model).
import { Case, Hook, Workspace } from "./.dtsim/dsl/index.ts";

const firmware = (fw: string) =>
	`+firmware=\${workspace}/fw/${fw}/build/firmware.hex`;

export const basicSmoke = Case("basic_smoke", {
	owner: "soc",
	env: { FW: { value: "basic_smoke", scope: "sim" } },
	simArgs: [firmware("basic_smoke")],
});

export const regfileSmoke = Case("regfile_smoke", {
	owner: "soc",
	env: { FW: { value: "regfile_smoke", scope: "sim" } },
	simArgs: [firmware("regfile_smoke")],
});

export default Workspace({
	tool: "vcs",
	filelist: "vcs.f",
	// Flags of the original run.sh (pure SV, no UVM): the backend defaults
	// target newer VCS than O-2018.09. -debug_access+all lets -ucli run dump.tcl.
	toolOptions: {
		ntbOpts: "",
		flags: ["-full64", "-sverilog", "-timescale=1ns/1ps", "-debug_access+all"],
	},
	bareDefaults: {
		random: false,
		// --no-as-needed: VCS O-2018.09 on binutils >= 2.34 drops its own shared libs.
		compileArgs: ["-top", "tb_soc", "-LDFLAGS", "-Wl,--no-as-needed"],
		grade: { pass: ["SMOKE PASS: tb_soc"], error: ["FAIL:"] },
	},
	env: { passthrough: ["MAKE", "CROSS"] },
	task: { type: "local", maxSlots: 2, maxCompiles: 1 },
	hooks: {
		preCompile: Hook("hooks/pre_compile.sh"),
		preSim: Hook("hooks/pre_sim.sh"),
	},
});
