// Shared test helpers: isolated workspace per test plus mock tool binaries.
// No real VCS/Verilator installation is ever required.
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MOCK_BIN = join(import.meta.dir, "test_env", "bin");
export const DTSIM = join(import.meta.dir, "..", "dtsim", "index.ts");

export type TestWorkspace = {
	dir: string;
	verify: string;
	root: string;
	config: string;
};

export const CASES_TS = `
import { Case, Group, Subcase, WaiveRule, Workspace } from "./.dtsim/dsl/index.ts";

export const hello = Case("test_hello_world", {
	owner: "andy",
	random: false,
	defines: ["NUM=1"],
	simArgs: ["+TEST_OPT=1"],
	grade: { pass: ["TEST PASSED"], error: ["Error:"], expect: ["Keyword"] },
	uvm: { test: "top_test", seq: "test_hello_world_seq", timeout: "1000ps" },
});

export const helloCosim = Subcase(hello, "cosim", {
	compileArgs: ["-ad=\${verify}/abc", "-debug_access+all"],
	simArgs: ["+fsdb+glitch=0"],
	env: { INPUT: "input.spf" },
});

export const helloTiming = Subcase(hello, "timing", {
	grade: { error: ["re:ERROR:.*timing violation"] },
});

export const bar = Case("test_bar_basic", {
	owner: "bob",
	defines: ["NUM=1"],
	env: { BAR_CFG: "basic", SIM_TRACE: { value: "1", scope: "sim" } },
	uvm: { test: "top_test", seq: "test_bar_seq" },
});

export const barCosim = Subcase(bar, "cosim", {
	compileArgs: ["-debug_access+all"],
	env: { INPUT: "input.spf" },
});

export const smoke = Case("test_quick_smoke", {
	owner: "dave",
	uvm: { test: "quick_test", timeout: "100ps" },
});

export const base = Group("base", ["test_quick_smoke", "test_hello_world", "test_bar_basic"]);
export const cosim = Group("cosim", ["test_hello_world.cosim", "test_bar_basic.cosim"]);

export default Workspace({
	tool: "vcs",
	filelist: "file.lst",
	bareDefaults: { compileArgs: ["+nospecify", "+notimingcheck"] },
	env: { passthrough: ["DTSIM_MOCK_*"], deny: ["LD_PRELOAD"] },
	task: { type: "local", maxSlots: 4, maxCompiles: 2 },
	waive: [
		WaiveRule("boot_timeout", "Error: timeout in boot phase"),
		WaiveRule("timing_rl_rdwin", "re:tRL_I \\\\+ tRDWIN_I .*timing violation"),
	],
	groups: [base, cosim],
});
`;

export async function makeWorkspace(
	configBody: string = CASES_TS,
): Promise<TestWorkspace> {
	const dir = await mkdtemp(join(tmpdir(), "dtsim-test-"));
	const verify = join(dir, "verify");
	const root = join(dir, "ws");
	await mkdir(verify, { recursive: true });
	await mkdir(root, { recursive: true });
	const config = join(verify, "dtsim.config.ts");
	await writeFile(config, configBody);
	await writeFile(join(verify, "file.lst"), "# mock filelist\n");
	return { dir, verify, root, config };
}

export type CliResult = {
	code: number;
	stdout: string;
	stderr: string;
};

export async function runDtsim(
	ws: TestWorkspace,
	args: string[],
	extraEnv: Record<string, string> = {},
	entry: string = DTSIM,
): Promise<CliResult> {
	const proc = Bun.spawn({
		cmd: ["bun", entry, ...args, "--config", ws.config, "--root", ws.root],
		cwd: ws.verify,
		env: {
			...process.env,
			PATH: `${MOCK_BIN}:${process.env.PATH ?? ""}`,
			DTSIM_TASK_TYPE: "local",
			DTSIM_LOG_WAIT_SEC: "2",
			...extraEnv,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
}

export async function seedDirs(caseDir: string): Promise<string[]> {
	const entries = await readdir(caseDir, { withFileTypes: true });
	return entries
		.filter(
			(e) =>
				e.isDirectory() &&
				!e.name.startsWith(".") &&
				!e.name.startsWith("compile_g") &&
				e.name !== "simv.vdb" &&
				e.name !== "obj_dir",
		)
		.map((e) => join(caseDir, e.name));
}
