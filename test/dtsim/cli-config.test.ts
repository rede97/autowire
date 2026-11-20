import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	AUTOWIRE,
	CASES_TS,
	type CliResult,
	makeWorkspace,
	mockEnv,
	runDtsim,
} from "./helpers.ts";

// Config loading and the dtsim command line: which invocations read the
// config, how it is found, and how config flags are registered.

async function autowire(
	cwd: string,
	args: string[],
	extraEnv: Record<string, string> = {},
): Promise<CliResult> {
	const proc = Bun.spawn({
		cmd: ["bun", AUTOWIRE, ...args],
		cwd,
		env: mockEnv(extraEnv),
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

/** A dir with an autowire.toml (`extra` appended) and nothing else. */
async function tomlProject(extra = ""): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "dtsim-cli-"));
	await writeFile(
		join(dir, "autowire.toml"),
		`[workspace]\nname = "t"\n\n${extra}`,
	);
	return dir;
}

describe("dtsim config loading", () => {
	test("a non-dtsim command neither imports the config nor writes .dtsim", async () => {
		const bare = await tomlProject();
		const help = await autowire(bare, ["help"]);
		expect(help.code).toBe(0);
		expect(existsSync(join(bare, "dt"))).toBe(false);

		// A project with a config: `autowire help` must not import it.
		const ws = await makeWorkspace(
			`import { writeFileSync } from "node:fs";\nwriteFileSync("IMPORTED", "");\n${CASES_TS}`,
		);
		await writeFile(
			join(ws.root, "autowire.toml"),
			'[workspace]\nname = "t"\n',
		);
		expect((await autowire(ws.root, ["help"])).code).toBe(0);
		expect(existsSync(join(ws.root, "IMPORTED"))).toBe(false);
		expect(existsSync(join(ws.verify, ".dtsim"))).toBe(false);
	});

	test("a missing config fails before .dtsim is written", async () => {
		const dir = await tomlProject();
		const r = await autowire(dir, ["dtsim", "list"]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("set [dtsim] config in autowire.toml");
		expect(existsSync(join(dir, "dt"))).toBe(false);

		const set = await tomlProject('[dtsim]\nconfig = "dt/config/x.ts"\n');
		await mkdir(join(set, "dt", "config"), { recursive: true });
		const missing = await autowire(set, ["dtsim", "list"]);
		expect(missing.code).toBe(1);
		expect(missing.stderr).toContain("config not found");
		expect(existsSync(join(set, "dt", "config", ".dtsim"))).toBe(false);
	});

	test("help, version and results without --recheck need no config", async () => {
		const dir = await mkdtemp(join(tmpdir(), "dtsim-none-"));
		const help = await autowire(dir, ["dtsim", "--help"]);
		expect(help.code).toBe(0);
		expect(help.stdout).toContain("run [options] <case>");
		expect((await autowire(dir, ["dtsim", "run", "--help"])).code).toBe(0);
		expect((await autowire(dir, ["dtsim", "help", "regr"])).code).toBe(0);
		const empty = join(dir, "reg");
		await mkdir(empty);
		const results = await autowire(dir, ["dtsim", "results", "--dir", empty]);
		expect(results.code).toBe(0);
		// A command that needs the config still reports it.
		const list = await autowire(dir, ["dtsim", "list"]);
		expect(list.code).toBe(1);
		expect(list.stderr).toContain("dtsim: no ");

		// The multi-call `dtsim` entry (here a script named dtsim.js).
		const entry = join(dir, "dtsim.js");
		await writeFile(
			entry,
			`import ${JSON.stringify(pathToFileURL(AUTOWIRE).href)};\n`,
		);
		const proc = (args: string[]) =>
			Bun.spawnSync(["bun", entry, ...args], { cwd: dir, env: mockEnv() });
		for (const args of [["--help"], ["-h"], ["--version"], ["help"]]) {
			expect(proc(args).exitCode).toBe(0);
		}
		expect(proc(["--version"]).stdout.toString()).toMatch(/\d+\.\d+\.\d+/);
	});

	test("autowire.toml without [dtsim] keeps the upward search", async () => {
		const top = await tomlProject();
		const ws = await makeWorkspace();
		// Move the generated project under the toml dir: <top>/chip/dt/config.
		const chip = join(top, "chip", "dt", "config");
		await mkdir(chip, { recursive: true });
		await writeFile(
			join(chip, "dtsim.config.ts"),
			await readFile(ws.config, "utf8"),
		);
		await writeFile(join(chip, "file.lst"), "# mock filelist\n");
		const r = await autowire(join(top, "chip"), ["dtsim", "list"]);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("test_hello_world");
	});

	test("[dtsim] config outside <project>/dt/config/ is rejected", async () => {
		const dir = await tomlProject('[dtsim]\nconfig = "sim/dtsim.config.ts"\n');
		await mkdir(join(dir, "sim"));
		await writeFile(join(dir, "sim", "dtsim.config.ts"), CASES_TS);
		const r = await autowire(dir, ["dtsim", "list"]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("the config must live in <project>/dt/config/");
		expect(existsSync(join(dir, "sim", ".dtsim"))).toBe(false);
	});
});

describe("config flags", () => {
	// The factory prints the variable, so each command shows what it saw.
	const withRegistry = (registry: string): string =>
		CASES_TS.replace(
			"export default Workspace({",
			`export default Workspace(${registry}, () => {\n\tconsole.log(\`COV_MERGE=\${process.env.COV_MERGE}\`);\n\treturn {`,
		).replace(
			"\tgroups: [base, cosim],\n});",
			"\tgroups: [base, cosim],\n\t};\n});",
		);

	test("a negatable flag sets its variable only when passed", async () => {
		const ws = await makeWorkspace(
			withRegistry('[{ name: "COV_MERGE", flags: "--no-cov-merge" }]'),
		);
		const unset = await runDtsim(ws, ["groups"]);
		expect(unset.code).toBe(0);
		expect(unset.stdout).toContain("COV_MERGE=undefined");
		// list, groups and env take config flags too.
		for (const args of [
			["groups"],
			["list"],
			["env", "--case", "test_quick_smoke"],
		]) {
			const set = await runDtsim(ws, [...args, "--no-cov-merge"]);
			expect(set.code).toBe(0);
			expect(set.stdout).toContain("COV_MERGE=false");
		}
	});

	test("a flag clashing with a built-in option names the config entry", async () => {
		const ws = await makeWorkspace(
			withRegistry('[{ name: "WAVE", flags: "-v, --wave" }]'),
		);
		const r = await runDtsim(ws, ["run", "test_hello_world"]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain(`dtsim: ${ws.config}: env var WAVE: `);
		expect(r.stderr).toContain("conflicting flag");
		// Other autowire commands are unaffected.
		await writeFile(
			join(ws.root, "autowire.toml"),
			'[workspace]\nname = "t"\n',
		);
		expect((await autowire(ws.root, ["help"])).code).toBe(0);
	});
});

describe("dresults", () => {
	// SIM_TOOL orders the tools; under verilator test_quick_smoke's grader
	// needs a keyword the mock never prints.
	const body = CASES_TS.replace(
		'import { DefaultGrader, VcsTool } from "./.dtsim/dsl/index.ts";',
		'import { DefaultGrader, VcsTool, VerilatorTool } from "./.dtsim/dsl/index.ts";',
	)
		.replace(
			'owner: "dave",',
			'owner: "dave",\n\tbyTool: { verilator: { grader: grader.extend({ pass: ["NEVER_PRINTED_KEYWORD"] }) } },',
		)
		.replace(
			"tools: [VcsTool()],",
			'tools: process.env.SIM_TOOL === "verilator" ? [VerilatorTool(), VcsTool()] : [VcsTool(), VerilatorTool()],',
		)
		.replace(
			"export default Workspace({",
			"export default Workspace([], () => ({",
		)
		.replace("\tgroups: [base, cosim],\n});", "\tgroups: [base, cosim],\n}));");

	test("--recheck grades with the regression's tool", async () => {
		const ws = await makeWorkspace(body);
		const regr = await runDtsim(ws, ["regr", "base"]);
		expect(regr.code).toBe(0);
		const regDir = join(ws.out, "vcs", "regression");
		const script = join(regDir, "dresults");
		expect(await readFile(script, "utf8")).toContain("--tool 'vcs'");

		// Run by hand from the regression dir while the probe would pick verilator.
		const env = mockEnv({ SIM_TOOL: "verilator" });
		const pinned = Bun.spawnSync(["bash", "./dresults", "--recheck"], {
			cwd: regDir,
			env,
		});
		expect(pinned.stdout.toString()).toContain("PASS=3");
		expect(pinned.exitCode).toBe(0);

		// Without the pin the verilator grader fails the smoke case.
		const unpinned = await runDtsim(
			ws,
			["results", "--dir", regDir, "--recheck"],
			{ SIM_TOOL: "verilator" },
		);
		expect(unpinned.code).toBe(1);

		const unknown = await runDtsim(ws, [
			"results",
			"--dir",
			regDir,
			"--recheck",
			"--tool",
			"xcelium",
		]);
		expect(unknown.code).toBe(1);
		expect(unknown.stderr).toContain('tool "xcelium" is not configured');
	});
});
