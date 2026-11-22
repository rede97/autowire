// Shared test helpers: isolated <project>/dt/config workspace per test plus
// the mock tool binaries shipped with demo/dtsim. No real VCS/Verilator
// installation is ever required.
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
export const MOCK_BIN = join(REPO, "demo", "dtsim", "dt", "bin");
export const AUTOWIRE = join(REPO, "index.ts");

export type TestWorkspace = {
	dir: string;
	/** <project>/dt/config */
	verify: string;
	/** project root (RTL design dir) */
	root: string;
	/** <project>/dt/simout */
	out: string;
	config: string;
};

export const CASES_TS = `
import { Case, Group, WaiveRule, Workspace } from "./.dtsim/dsl/index.ts";
import { DefaultGrader, VcsTool } from "./.dtsim/dsl/index.ts";
// Waive rules belong to the grader; cases extend it with their keywords.
const grader = DefaultGrader({
	waive: [
		WaiveRule("boot_timeout", "Error: timeout in boot phase"),
		WaiveRule("timing_rl_rdwin", "re:tRL_I \\\\+ tRDWIN_I .*timing violation"),
	],
});
const helloGrader = grader.extend({ pass: ["TEST PASSED"], error: ["Error:"], expect: ["Keyword"] });

// Only top-level cases are exported; derived cases hang off them.
export const hello = Case("test_hello_world", {
	owner: "andy",
	random: false,
	defines: ["NUM=1"],
	simArgs: ["+TEST_OPT=1"],
	grader: helloGrader,
	uvm: { test: "top_test", seq: "test_hello_world_seq", timeout: "1000ps" },
});

hello.SubCase("cosim", {
	compileArgs: ["-ad=\${verify}/abc", "-debug_access+all"],
	simArgs: ["+fsdb+glitch=0"],
	env: { INPUT: "input.spf" },
});

hello.SubCase("timing", {
	grader: helloGrader.extend({ error: ["re:ERROR:.*timing violation"] }),
});

export const bar = Case("test_bar_basic", {
	owner: "bob",
	defines: ["NUM=1"],
	env: { BAR_CFG: "basic", SIM_TRACE: { value: "1", scope: "sim" } },
	uvm: { test: "top_test", seq: "test_bar_seq" },
});

bar.SubCase("cosim", {
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
	tools: [VcsTool()],
	filelists: ["file.lst"],
	bareDefaults: { compileArgs: ["+nospecify", "+notimingcheck"] },
	env: { passthrough: ["DTSIM_MOCK_*"], deny: ["LD_PRELOAD"] },
	task: { maxSlots: 4, maxCompiles: 2 },
	seeds: process.env.DTSIM_TEST_SEEDS ? process.env.DTSIM_TEST_SEEDS.split(",") : ["0"],
	grader,
	groups: [base, cosim],
});
`;

export async function makeWorkspace(
	configBody: string = CASES_TS,
): Promise<TestWorkspace> {
	const dir = await mkdtemp(join(tmpdir(), "dtsim-test-"));
	const root = join(dir, "proj");
	const verify = join(root, "dt", "config");
	await mkdir(verify, { recursive: true });
	const config = join(verify, "dtsim.config.ts");
	await writeFile(config, configBody);
	await writeFile(join(verify, "file.lst"), "# mock filelist\n");
	return { dir, verify, root, out: join(root, "dt", "simout"), config };
}

export type CliResult = {
	code: number;
	stdout: string;
	stderr: string;
};

/** Child env with the mock bin dir first. Windows env names are
 *  case-insensitive, so every PATH spelling is replaced, not duplicated. */
export function mockEnv(
	extraEnv: Record<string, string> = {},
): Record<string, string> {
	const env: Record<string, string> = {};
	let path = "";
	for (const [k, v] of Object.entries(process.env)) {
		if (v === undefined) continue;
		if (k.toUpperCase() === "PATH") path = v;
		else env[k] = v;
	}
	return {
		...env,
		PATH: `${MOCK_BIN}${delimiter}${path}`,
		DTSIM_TASK_TYPE: "local",
		DTSIM_LOG_WAIT_SEC: "2",
		...extraEnv,
	};
}

/** `bun index.ts dtsim <args>` from the project root (config found upward). */
export async function runDtsim(
	ws: TestWorkspace,
	args: string[],
	extraEnv: Record<string, string> = {},
): Promise<CliResult> {
	const runArgs: string[] = [];
	const env = { ...extraEnv };
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "-s") {
			env.DTSIM_TEST_SEEDS = args[++i] ?? "";
			continue;
		}
		if (args[i] === "--num-seeds") {
			const n = Number(args[++i]);
			env.DTSIM_TEST_SEEDS = Array.from({ length: n }, (_, j) =>
				String(j),
			).join(",");
			continue;
		}
		runArgs.push(args[i] as string);
	}
	const proc = Bun.spawn({
		cmd: ["bun", AUTOWIRE, "dtsim", ...runArgs],
		cwd: ws.root,
		env: mockEnv(env),
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

/** The compile dir of the build that runs `caseId`, read from the plan in
 *  `<regDir>/regression.txt` (build names are positional). */
export async function buildDirOf(
	regDir: string,
	caseId: string,
): Promise<string> {
	let build = "";
	for (const line of (
		await Bun.file(join(regDir, "regression.txt")).text()
	).split("\n")) {
		const head = /^compile (\S+)/.exec(line);
		if (head) build = head[1] as string;
		else if (line.endsWith(`sim ${caseId}`)) {
			return join(regDir, `compile_${build}`);
		}
	}
	throw new Error(`no build for ${caseId} in ${regDir}/regression.txt`);
}
