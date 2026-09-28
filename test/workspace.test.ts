import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	defaultToml,
	findWorkspace,
	hdxmlArgs,
	loadWorkspace,
} from "../src/workspace.ts";

function tempWorkspace(toml: string): string {
	const dir = mkdtempSync(join(tmpdir(), "aw_ws_test_"));
	const full = toml.includes("[workspace]")
		? toml
		: `[workspace]\nname = "test"\n\n${toml}`;
	writeFileSync(join(dir, "autowire.toml"), full);
	return dir;
}

describe("workspace", () => {
	test("default template parses and maps to minimal args", async () => {
		const dir = tempWorkspace(
			defaultToml("test").replace('walk_dirs = ["rtl"]', "walk_dirs = []"),
		);
		const cfg = await loadWorkspace(join(dir, "autowire.toml"));
		expect(cfg.root).toBe(dir);
		expect(cfg.name).toBe("test");
		expect(cfg.indexDir).toBe(join(dir, ".autowire/hdxml"));
		expect(cfg.dumpDir).toBe(join(dir, "gen/connect"));
		expect(cfg.connectDir).toBe(join(dir, "gen/connect"));
		expect(cfg.simDir).toBe(join(dir, "gen/sim"));
		expect(cfg.pluginsDir).toBe(join(dir, "gen/plugins"));
		expect(cfg.simUnits).toEqual([]);
		expect(cfg.wishboneExcelExport).toBeNull();
		expect(cfg.wishboneCExport).toBeNull();
		expect(cfg.wishboneUvmExport).toBeNull();
		expect(hdxmlArgs(cfg)).toEqual([
			"--output-dir",
			join(dir, ".autowire/hdxml"),
		]);
	});

	test("[connect.<id>] parses html + deps and resolves paths", async () => {
		const dir = tempWorkspace(`
[connect.a]
html = "connect/a.html"

[connect.b]
html = "connect/b.html"
deps = ["a"]
`);
		const cfg = await loadWorkspace(join(dir, "autowire.toml"));
		expect(cfg.connectUnits).toEqual([
			{
				id: "a",
				html: join(dir, "connect/a.html"),
				deps: [],
				kind: "connect",
			},
			{
				id: "b",
				html: join(dir, "connect/b.html"),
				deps: ["a"],
				kind: "connect",
			},
		]);
	});

	test("[sim.<id>] parses and may deps connect ids", async () => {
		const dir = tempWorkspace(`
[connect.soc]
html = "connect/soc.html"
[sim.tb]
html = "sim/tb.html"
deps = ["soc"]
[workspace.dump]
connect_dir = "gen/connect"
sim_dir = "gen/sim"
`);
		const cfg = await loadWorkspace(join(dir, "autowire.toml"));
		expect(cfg.simUnits).toEqual([
			{ id: "tb", html: join(dir, "sim/tb.html"), deps: ["soc"], kind: "sim" },
		]);
		expect(cfg.connectDir).toBe(join(dir, "gen/connect"));
		expect(cfg.simDir).toBe(join(dir, "gen/sim"));
	});

	test("connect deps must not include sim ids", async () => {
		const dir = tempWorkspace(`
[connect.a]
html = "a.html"
deps = ["tb"]
[sim.tb]
html = "tb.html"
`);
		await expect(loadWorkspace(join(dir, "autowire.toml"))).rejects.toThrow(
			"sim unit",
		);
	});

	test("flat [connect] html= list is rejected", async () => {
		const dir = tempWorkspace('[connect]\nhtml = ["a.html"]\n');
		await expect(loadWorkspace(join(dir, "autowire.toml"))).rejects.toThrow(
			"flat [connect] html",
		);
	});

	test("[connect.*] deps cycle is rejected", async () => {
		const dir = tempWorkspace(`
[connect.a]
html = "a.html"
deps = ["b"]
[connect.b]
html = "b.html"
deps = ["a"]
`);
		await expect(loadWorkspace(join(dir, "autowire.toml"))).rejects.toThrow(
			"cycle",
		);
	});

	test("[connect.*] unknown deps id is rejected", async () => {
		const dir = tempWorkspace(`
[connect.a]
html = "a.html"
deps = ["missing"]
`);
		await expect(loadWorkspace(join(dir, "autowire.toml"))).rejects.toThrow(
			"unknown id",
		);
	});

	test("analysis.* mapping: valued defines -> -D, keep_raw -> --keep-raw, numbers stringified", async () => {
		const dir = tempWorkspace(`
[analysis]
keep_raw = ["ENV_MACRO", "WIDTH"]
define_headers = ["include/defs.svh"]

[analysis.rtl]
walk_dirs = ["rtl"]
incdirs = ["rtl/include"]
exclude_filenames = ["tb_top.sv"]
exclude_dirs = ["dv"]

[analysis.defines]
SYNTHESIS = "1"
DEPTH = 16
`);
		const cfg = await loadWorkspace(join(dir, "autowire.toml"));
		expect(cfg.keepRaw).toEqual(["ENV_MACRO", "WIDTH"]);
		expect(cfg.defines).toEqual({ SYNTHESIS: "1", DEPTH: "16" });
		expect(hdxmlArgs(cfg)).toEqual([
			"-w",
			join(dir, "rtl"),
			"--exclude-filenames",
			"tb_top.sv",
			"--exclude-dirs",
			"dv",
			"-I",
			join(dir, "rtl/include"),
			"--define-headers",
			join(dir, "include/defs.svh"),
			"-D",
			"DEPTH=16",
			"SYNTHESIS=1",
			"--keep-raw",
			"ENV_MACRO",
			"WIDTH",
			"--output-dir",
			join(dir, ".autowire/hdxml"),
		]);
	});

	test("empty define value is rejected and points to keep_raw", async () => {
		const dir = tempWorkspace('[analysis.defines]\nWIDTH = ""\n');
		await expect(loadWorkspace(join(dir, "autowire.toml"))).rejects.toThrow(
			"keep_raw",
		);
	});

	test("[analysis] hdxml_bin resolves against the workspace root; unset is null", async () => {
		const withBin = tempWorkspace('[analysis]\nhdxml_bin = "tools/hdxml"\n');
		const cfg = await loadWorkspace(join(withBin, "autowire.toml"));
		expect(cfg.hdxmlBin).toBe(join(withBin, "tools/hdxml"));
		const without = tempWorkspace("[analysis.rtl]\n");
		expect(
			(await loadWorkspace(join(without, "autowire.toml"))).hdxmlBin,
		).toBeNull();
	});

	test("[analysis] hdxml_bin must be a non-empty string", async () => {
		const dir = tempWorkspace("[analysis]\nhdxml_bin = 42\n");
		await expect(loadWorkspace(join(dir, "autowire.toml"))).rejects.toThrow(
			"hdxml_bin",
		);
	});

	test("findWorkspace searches upward from a subdirectory", () => {
		const dir = tempWorkspace("[analysis.rtl]\n");
		mkdirSync(join(dir, "a/b"), { recursive: true });
		expect(findWorkspace(join(dir, "a/b"))).toBe(join(dir, "autowire.toml"));
		expect(findWorkspace(tmpdir())).toBe(findWorkspace(tmpdir())); // must not throw
	});

	test("[plugins.wishbone] export/c/uvm resolve as optional paths", async () => {
		const dir = tempWorkspace(`
[plugins.wishbone]
export = "docs/regs.xlsx"
c = "fw/gen/wishbone"
uvm = "dv/ral"
`);
		const cfg = await loadWorkspace(join(dir, "autowire.toml"));
		expect(cfg.wishboneExcelExport).toBe(join(dir, "docs/regs.xlsx"));
		expect(cfg.wishboneCExport).toBe(join(dir, "fw/gen/wishbone"));
		expect(cfg.wishboneUvmExport).toBe(join(dir, "dv/ral"));
	});

	test("[plugins.wishbone] empty c= is rejected", async () => {
		const dir = tempWorkspace(`
[plugins.wishbone]
c = ""
`);
		await expect(loadWorkspace(join(dir, "autowire.toml"))).rejects.toThrow(
			"[plugins.wishbone] c",
		);
	});

	test("[regfile.*] is rejected in favor of [wishbone.*]", async () => {
		const dir = tempWorkspace(`
[regfile.smoke]
ts = "regs/smoke.ts"
`);
		await expect(loadWorkspace(join(dir, "autowire.toml"))).rejects.toThrow(
			"[regfile.*] is removed",
		);
	});

	test("[plugins.bus] is rejected in favor of [plugins.wishbone]", async () => {
		const dir = tempWorkspace(`
[plugins.bus]
c = "fw/gen/bus"
`);
		await expect(loadWorkspace(join(dir, "autowire.toml"))).rejects.toThrow(
			"[plugins.bus] is removed",
		);
	});

	test("type errors name the offending key", async () => {
		const dir = tempWorkspace('[analysis.rtl]\nwalk_dirs = "rtl"\n');
		await expect(loadWorkspace(join(dir, "autowire.toml"))).rejects.toThrow(
			"analysis.rtl.walk_dirs",
		);
	});

	test("[workspace] name is required", async () => {
		const dir = mkdtempSync(join(tmpdir(), "aw_ws_test_"));
		writeFileSync(join(dir, "autowire.toml"), "[analysis.rtl]\n");
		await expect(loadWorkspace(join(dir, "autowire.toml"))).rejects.toThrow(
			"[workspace] name is required",
		);
	});

	test("[workspace] name must be a C-identifier", async () => {
		const dir = mkdtempSync(join(tmpdir(), "aw_ws_test_"));
		writeFileSync(join(dir, "autowire.toml"), '[workspace]\nname = "1bad"\n');
		await expect(loadWorkspace(join(dir, "autowire.toml"))).rejects.toThrow(
			"must match",
		);
	});

	test("legacy top-level [dump] / [style] / [hdxml] are rejected", async () => {
		const d1 = tempWorkspace('[dump]\nplugins_dir = "gen/plugins"\n');
		await expect(loadWorkspace(join(d1, "autowire.toml"))).rejects.toThrow(
			"[workspace.dump]",
		);
		const d2 = tempWorkspace("[style]\nport_align = true\n");
		await expect(loadWorkspace(join(d2, "autowire.toml"))).rejects.toThrow(
			"[workspace.style]",
		);
		const d3 = tempWorkspace('[hdxml]\nbin = "x"\n');
		await expect(loadWorkspace(join(d3, "autowire.toml"))).rejects.toThrow(
			"[analysis] hdxml_bin",
		);
	});
});
