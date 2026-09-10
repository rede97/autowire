import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256_0, sha256_1 } from "../demo/soc/regs/sha256_wb.ts";
import {
	smoke_block_wide,
	smoke_rc,
	smoke_ro,
	smoke_rw,
	smoke_rwe,
	smoke_rww,
	smoke_shadow,
	smoke_w1c,
	smoke_w1p,
} from "../demo/soc/regs/smoke.ts";
import {
	sub_module_a,
	sub_module_b,
} from "../docs/examples/regfile/regfile.ts";
import type { RegfileDef } from "../src/plugins/wishbone-regfile/dsl.ts";
import { emitRegfileSv } from "../src/plugins/wishbone-regfile/emit.ts";
import { generateAll } from "../src/plugins/wishbone-regfile/generate.ts";
import { layoutRegfile } from "../src/plugins/wishbone-regfile/layout.ts";
import { loadWorkspace } from "../src/workspace.ts";

describe("wishbone-regfile", () => {
	test("layout sub_module_b packs ID cell at 0", () => {
		const laid = layoutRegfile(sub_module_b);
		expect(laid.cells).toHaveLength(1);
		expect(laid.cells[0]?.name).toBe("ID");
		expect(laid.cells[0]?.byte_offset).toBe(0);
		expect(laid.tga_width).toBe(0);
	});

	test("layout sub_module_a has shadow tga and CFG0", () => {
		const laid = layoutRegfile(sub_module_a);
		expect(laid.tga_width).toBe(2);
		const cfg = laid.cells.find((c) => c.name === "CFG0");
		expect(cfg?.shadow).toBe("lane");
		expect(cfg?.byte_offset).toBe(0);
		const key0 = laid.cells.find((c) => c.name.includes("key"));
		expect(key0).toBeDefined();
	});

	test("emit uses Access sideband prefixes (master RG_NAME_PREFIX)", () => {
		const sv = emitRegfileSv(layoutRegfile(sub_module_a));
		expect(sv).toContain("rg_enable");
		expect(sv).toContain("ro_busy");
		expect(sv).toContain("c_rg_irq_sticky");
		expect(sv).toContain("p_rg_pulse_cmd");
		expect(sv).toContain("rg_capture_strb");
		// field "ext_data" already starts with Access prefix "ext" → no double prefix
		expect(sv).toContain("ext_data_wren");
		expect(sv).toContain("ext_data_ready");
		expect(sv).toContain("rwe_stall_ext_data");
		expect(sv).toContain(
			"sub_module_a_o_wb_ack = sub_module_a_i_wb_cyc && sub_module_a_i_wb_stb && hit && !rwe_stall_ext_data",
		);
		expect(sv).toContain("sub_module_a_i_wb_cyc");
		expect(sv).toContain("sub_module_a_o_wb_ack");
		expect(sv).not.toContain("o_enable");
		expect(sv).not.toContain("i_busy");
	});

	test("emit aligns port and signal declaration columns", () => {
		const sv = emitRegfileSv(layoutRegfile(sub_module_b));
		// port_align: dir / logic / packed; names share one column
		expect(sv).toContain("\tinput  logic        i_clk,");
		expect(sv).toContain("\tinput  logic [15:0] sub_module_b_i_wb_adr,");
		expect(sv).toContain("\toutput logic [31:0] sub_module_b_o_wb_dat");
		// signal_align: packed column; names share one column
		expect(sv).toContain("\tlogic        hit;");
		expect(sv).toContain("\tlogic [31:0] rd_data;");
	});

	test("emit includes module and same-cycle ack", () => {
		const sv = emitRegfileSv(layoutRegfile(sub_module_b));
		expect(sv).toContain("module sub_module_b_regfile");
		expect(sv).toContain("sub_module_b_o_wb_ack");
		expect(sv).toContain(
			"sub_module_b_i_wb_cyc && sub_module_b_i_wb_stb && hit",
		);
		expect(sv).toContain("16'h1");
	});

	test("emit carries SoT desc into header / ports / cells", () => {
		const sv = emitRegfileSv(layoutRegfile(sub_module_a));
		expect(sv).toContain("//  Module: sub_module_a_regfile");
		expect(sv).toContain("//  Desc:");
		expect(sv).toContain("//  Address map:");
		expect(sv).toContain("// Wishbone classic slave");
		expect(sv).toContain("// Field / shadow sidebands");
		expect(sv).toContain("//  2. Address decode / hit / wr_sel / rd_sel");
		expect(sv).toMatch(/\/\/ Addr: 0x0+\s+RegCell: CFG0\s+—/);
		expect(sv).toMatch(/\/\/\s+(\[\d+\]|\[\d+:\d+\])\s+RW\s+enable\s+—/);
	});

	test("emit aligns field map comment columns", () => {
		const sv = emitRegfileSv(layoutRegfile(sub_module_a));
		const enable = sv
			.split("\n")
			.find((l) => /\/\/\s+\[0\]\s+RW\s+enable\s+— Soft enable/.test(l));
		const mode = sv
			.split("\n")
			.find((l) => /\/\/\s+\[10:8\]\s+RW\s+mode\s+—/.test(l));
		expect(enable).toBeDefined();
		expect(mode).toBeDefined();
		if (!enable || !mode) return;
		// longer bits pad shorter ones so Access columns line up
		expect(enable.indexOf("RW", enable.indexOf("[0]"))).toBe(
			mode.indexOf("RW", mode.indexOf("[10:8]")),
		);
	});

	test("one SoT file generates all RegfileDef exports", async () => {
		const dir = mkdtempSync(join(tmpdir(), "aw_regfile_"));
		const example = join(
			import.meta.dir,
			"..",
			"docs",
			"examples",
			"regfile",
			"regfile.ts",
		);
		writeFileSync(
			join(dir, "autowire.toml"),
			`
[dump]
plugins_dir = "gen/plugins"
[regfile.examples]
ts = "${example.replaceAll("\\", "/")}"
`,
		);
		const ws = await loadWorkspace(join(dir, "autowire.toml"));
		expect(ws.regfileSources).toHaveLength(1);
		expect(ws.regfileSources[0]?.exports).toBeNull();
		const paths = await generateAll(ws, ws.regfileSources);
		expect(paths.some((p) => p.includes("sub_module_a_regfile.sv"))).toBe(true);
		expect(paths.some((p) => p.includes("sub_module_b_regfile.sv"))).toBe(true);
	});

	test("exports= filters which leaves to generate", async () => {
		const dir = mkdtempSync(join(tmpdir(), "aw_regfile_f_"));
		const example = join(
			import.meta.dir,
			"..",
			"docs",
			"examples",
			"regfile",
			"regfile.ts",
		);
		writeFileSync(
			join(dir, "autowire.toml"),
			`
[dump]
plugins_dir = "gen/plugins"
[regfile.examples]
ts = "${example.replaceAll("\\", "/")}"
exports = ["sub_module_b"]
`,
		);
		const ws = await loadWorkspace(join(dir, "autowire.toml"));
		expect(ws.regfileSources[0]?.exports).toEqual(["sub_module_b"]);
		const paths = await generateAll(ws, ws.regfileSources);
		expect(paths).toHaveLength(1);
		expect(paths[0]).toContain("sub_module_b_regfile.sv");
	});
});

/** Basic smoke: each Access / theme leaf must layout + emit stably. */
describe("wishbone-regfile smoke features", () => {
	const cases: { def: RegfileDef; must: string[] }[] = [
		{ def: smoke_rc, must: ["module smoke_rc_regfile", "16'ha55a"] },
		{ def: smoke_ro, must: ["ro_busy", "ro_code"] },
		{ def: smoke_rw, must: ["rg_enable", "rg_mode_q"] },
		{
			def: smoke_rww,
			must: ["rg_capture", "rg_capture_strb", "rg_capture_hwdata"],
		},
		{
			def: smoke_rwe,
			must: ["ext_data", "ext_data_wren", "ext_data_ready"],
		},
		{ def: smoke_w1p, must: ["p_rg_go"] },
		{ def: smoke_w1c, must: ["c_rg_sticky"] },
		{
			def: smoke_shadow,
			must: ["smoke_shadow_i_wb_tga", "o_bank_sel", "rg_cfg_q"],
		},
		{ def: smoke_block_wide, must: ["rg_key_0", "rg_key_1", "rg_key_2"] },
	];

	for (const { def, must } of cases) {
		test(`${def.name}: layout + emit`, () => {
			const laid = layoutRegfile(def);
			expect(laid.cells.length).toBeGreaterThan(0);
			const sv = emitRegfileSv(laid);
			expect(sv).toContain(`module ${def.name.toLowerCase()}_regfile`);
			expect(sv).toContain(
				`${def.name}_o_wb_ack = ${def.name}_i_wb_cyc && ${def.name}_i_wb_stb && hit`,
			);
			for (const s of must) expect(sv).toContain(s);
		});
	}

	test("shadow sel encoder is lowest-set-bit priority (broadcast remap)", () => {
		// Audit: ascending loop selected the HIGHEST set bit, contradicting the
		// emitted comment; contract pins lowest set bit (read path stays bitwise-OR).
		const sv = emitRegfileSv(layoutRegfile(smoke_shadow));
		expect(sv).toContain("// one-hot mask → bin index (lowest set bit wins)");
		expect(sv).toContain("for (int __i = 3; __i >= 0; __i--)");
	});

	test("smoke.ts generates all feature leaves via plugin generate", async () => {
		const dir = mkdtempSync(join(tmpdir(), "aw_regfile_smoke_"));
		const smoke = join(
			import.meta.dir,
			"..",
			"demo",
			"soc",
			"regs",
			"smoke.ts",
		);
		writeFileSync(
			join(dir, "autowire.toml"),
			`
[dump]
plugins_dir = "gen/plugins"
[regfile.smoke]
ts = "${smoke.replaceAll("\\", "/")}"
`,
		);
		const ws = await loadWorkspace(join(dir, "autowire.toml"));
		const paths = await generateAll(ws, ws.regfileSources);
		// on-bus `smoke` + per-Access leaves
		expect(paths.length).toBe(cases.length + 1);
		expect(paths.some((p) => p.includes("smoke_regfile.sv"))).toBe(true);
		for (const { def } of cases) {
			expect(
				paths.some((p) => p.includes(`${def.name.toLowerCase()}_regfile.sv`)),
			).toBe(true);
		}
	});
});

describe("wishbone-regfile demo/soc sha256", () => {
	test("sha256_0 layout matches legacy CTRL + HASH0..7 map", () => {
		const laid = layoutRegfile(sha256_0);
		expect(laid.cells.map((c) => c.byte_offset)).toEqual([
			0, 4, 8, 12, 16, 20, 24, 28, 32,
		]);
		const ctrl = laid.cells[0];
		expect(ctrl?.name).toBe("CTRL");
		expect(ctrl?.fields.map((f) => f.bit_offset)).toEqual([0, 1, 8, 9]);
	});

	test("sha256_0 emit has Access prefixes and same-cycle ACK", () => {
		const sv = emitRegfileSv(layoutRegfile(sha256_0));
		expect(sv).toContain("module sha256_0_regfile");
		expect(sv).toContain("rg_soft_reset");
		expect(sv).toContain("p_rg_done_clear");
		expect(sv).toContain("ro_busy");
		expect(sv).toContain("ro_done");
		expect(sv).toContain("ro_hash7");
		expect(sv).toContain(
			"sha256_0_o_wb_ack = sha256_0_i_wb_cyc && sha256_0_i_wb_stb && hit",
		);
	});

	test("demo/soc toml generates sha256_0/1_regfile", async () => {
		const ws = await loadWorkspace(
			join(import.meta.dir, "..", "demo", "soc", "autowire.toml"),
		);
		expect(ws.regfileSources.some((s) => s.id === "sha256")).toBe(true);
		const paths = await generateAll(ws, ws.regfileSources);
		expect(paths.some((p) => p.endsWith("sha256_0_regfile.sv"))).toBe(true);
		expect(paths.some((p) => p.endsWith("sha256_1_regfile.sv"))).toBe(true);
		expect(sha256_1.name).toBe("sha256_1");
	});
});
