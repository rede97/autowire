// dtsim demo workspace: VCS backend, LSF slots, environment isolation.
// The tools are fakes from ../bin (run.sh puts them first on PATH; the LSF
// launcher goes through the fake bsub). Repo demos import the DSL source;
// `docs unpack` rewrites the import to the .dtsim/dsl copy dtsim writes.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type PatchContext,
	WaiveRule,
	Workspace,
} from "../../../../src/dtsim/dsl/index.ts";
import { base, cosim, regrPlanA } from "./groups.ts";

// Patches are plain functions; dtsim only calls them before each compile.
// This one copies the SPICE deck into the compile dir with placeholders
// expanded, and only for cosim subcases.
async function spiceDeck(ctx: PatchContext): Promise<void> {
	if (!ctx.caseId.includes(".cosim")) return;
	// biome-ignore lint/suspicious/noTemplateCurlyInString: dtsim placeholder, expanded by ctx.resolvePath
	const deck = await readFile(ctx.resolvePath("${verify}/cosim/spice/input.sp"), "utf8");
	await writeFile(join(ctx.dir, "input.sp"), ctx.expand(deck));
}

export default Workspace({
	tool: "vcs",
	filelist: "file.lst",
	bareDefaults: {
		compileArgs: ["+nospecify", "+notimingcheck"],
	},
	env: {
		passthrough: ["PROJ_CFG", "DTSIM_MOCK_*"],
		deny: ["LD_PRELOAD"],
	},
	// Launcher "lsf" wraps every compile / sim in `bsub -I -J <job> -q normal
	// <options.args> <cmd>`; DTSIM_TASK_TYPE=slurm|local switches launcher.
	task: {
		type: "lsf",
		queue: "normal",
		maxSlots: 8,
		maxCompiles: 4,
		options: { args: ["-R", "rusage[mem=4000]"] },
	},
	waive: [
		WaiveRule("timing_rl_rdwin", "re:tRL_I \\+ tRDWIN_I .*timing violation"),
		WaiveRule("boot_timeout", "Error: timeout in boot phase"),
	],
	patches: [spiceDeck],
	hooks: {},
	groups: [base, regrPlanA, cosim],
	cases: ["./cases/hello.ts", "./cases/chip.ts"],
});
