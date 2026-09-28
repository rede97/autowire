import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../demo/soc/sot/wb_reg_sha256.ts";
import { smoke } from "../demo/soc/sot/wb_reg_smoke.ts";
import {
	sub_module_a,
	sub_module_b,
} from "../docs/examples/regfile/regfile.ts";
import { generateAll } from "../src/plugins/wishbone/generate.ts";
import {
	Access,
	Cell,
	CellDefault,
	Field,
	Regfile,
	type RegfileDef,
	RegfileDefault,
} from "../src/plugins/wishbone-regfile/dsl.ts";
import { emitRegfileSv } from "../src/plugins/wishbone-regfile/emit.ts";
import { buildRegfileWorkbook } from "../src/plugins/wishbone-regfile/emit-excel.ts";
import {
	emitRegfileC,
	emitRegfileUvm,
} from "../src/plugins/wishbone-regfile/emit-sw.ts";
import { generateDef } from "../src/plugins/wishbone-regfile/generate.ts";
import { layoutRegfile } from "../src/plugins/wishbone-regfile/layout.ts";
import { loadWorkspace } from "../src/workspace.ts";
import { verilatorSim, verilatorTest } from "./fixtures/verilator.ts";
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
} from "./fixtures/wb_reg_access.ts";

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
[workspace]
name = "test"
[workspace.dump]
plugins_dir = "gen/plugins"
[wishbone.examples]
ts = "${example.replaceAll("\\", "/")}"
`,
		);
		const ws = await loadWorkspace(join(dir, "autowire.toml"));
		expect(ws.wishboneSources).toHaveLength(1);
		expect(ws.wishboneSources[0]?.exports).toBeNull();
		const paths = await generateAll(ws);
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
[workspace]
name = "test"
[workspace.dump]
plugins_dir = "gen/plugins"
[wishbone.examples]
ts = "${example.replaceAll("\\", "/")}"
exports = ["sub_module_b"]
`,
		);
		const ws = await loadWorkspace(join(dir, "autowire.toml"));
		expect(ws.wishboneSources[0]?.exports).toEqual(["sub_module_b"]);
		const paths = await generateAll(ws);
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
			must: [
				"smoke_shadow_i_wb_tga_bank",
				"o_bank_sel",
				"i_bank_mux_sel",
				"rg_cfg_q[i_bank_mux_sel]",
			],
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

	test("wide field slices document logical bit range in desc", () => {
		const laid = layoutRegfile(smoke_block_wide);
		expect(laid.cells.map((c) => c.fields[0]?.field.desc)).toEqual([
			"96-bit key auto-split (key[31:0] of [95:0])",
			"96-bit key auto-split (key[63:32] of [95:0])",
			"96-bit key auto-split (key[95:64] of [95:0])",
		]);
		expect(laid.cells.map((c) => c.desc)).toEqual([
			"96-bit key auto-split (key[31:0] of [95:0])",
			"96-bit key auto-split (key[63:32] of [95:0])",
			"96-bit key auto-split (key[95:64] of [95:0])",
		]);
		const sv = emitRegfileSv(laid);
		expect(sv).toContain("key[31:0] of [95:0]");
		expect(sv).toContain("key[63:32] of [95:0]");
		expect(sv).toContain("key[95:64] of [95:0]");
		expect(sv).not.toContain("slice0 of");
		const c = emitRegfileC(laid);
		expect(c).toContain("key[63:32] of [95:0]");
		const uvm = emitRegfileUvm(laid);
		expect(uvm).toContain("key[95:64] of [95:0]");
		const wb = buildRegfileWorkbook([laid]);
		const ws = wb.getWorksheet("regfile_smoke_block_wide");
		const descs: string[] = [];
		ws?.eachRow((row, n) => {
			if (n === 1) return;
			const d = row.getCell(8).value;
			if (typeof d === "string" && d.includes("of [95:0]")) descs.push(d);
		});
		expect(descs).toEqual([
			"96-bit key auto-split (key[31:0] of [95:0])",
			"96-bit key auto-split (key[31:0] of [95:0])",
			"96-bit key auto-split (key[63:32] of [95:0])",
			"96-bit key auto-split (key[63:32] of [95:0])",
			"96-bit key auto-split (key[95:64] of [95:0])",
			"96-bit key auto-split (key[95:64] of [95:0])",
		]);
	});

	test("shadow sel encoder is lowest-set-bit priority (broadcast remap)", () => {
		// Audit: ascending loop selected the HIGHEST set bit, contradicting the
		// emitted comment; contract pins lowest set bit (read path stays bitwise-OR).
		const sv = emitRegfileSv(layoutRegfile(smoke_shadow));
		expect(sv).toContain("// one-hot mask → bin index (lowest set bit wins)");
		expect(sv).toContain("for (int __i = 3; __i >= 0; __i--)");
	});

	verilatorTest(
		"W1C hardware set survives a zero-lane write",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "aw_regfile_w1c_"));
			try {
				const dut = join(dir, "smoke_w1c_regfile.sv");
				const tb = join(dir, "tb.sv");
				writeFileSync(dut, emitRegfileSv(layoutRegfile(smoke_w1c)));
				writeFileSync(
					tb,
					`module tb;
	logic i_clk = 1'b0;
	logic i_rst_n = 1'b0;
	logic smoke_w1c_i_wb_cyc = 1'b0;
	logic smoke_w1c_i_wb_stb = 1'b0;
	logic smoke_w1c_i_wb_we = 1'b0;
	logic [7:0] smoke_w1c_i_wb_adr = 8'h0;
	logic [31:0] smoke_w1c_i_wb_dat = 32'h0;
	logic [3:0] smoke_w1c_i_wb_sel = 4'h0;
	logic smoke_w1c_o_wb_ack;
	logic [31:0] smoke_w1c_o_wb_dat;
	logic c_rg_sticky;
	logic c_rg_sticky_set = 1'b0;

	always #5 i_clk = ~i_clk;

	smoke_w1c_regfile dut (.*);

	initial begin
		#12 i_rst_n = 1'b1;
		@(negedge i_clk);
		smoke_w1c_i_wb_cyc = 1'b1;
		smoke_w1c_i_wb_stb = 1'b1;
		smoke_w1c_i_wb_we = 1'b1;
		smoke_w1c_i_wb_sel = 4'b0000;
		c_rg_sticky_set = 1'b1;
		@(posedge i_clk);
		#1;
		if (c_rg_sticky !== 1'b1)
			$fatal(1, "W1C hardware set was lost");
		$finish;
	end
endmodule
`,
				);
				const r = verilatorSim({
					dir: join(dir, "obj"),
					top: "tb",
					sources: [tb, dut],
				});
				expect(r.buildLog).not.toContain("%Error");
				expect(r.buildOk).toBe(true);
				expect(r.exitCode).toBe(0);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		180_000,
	);

	test("C export is field layout only; uvm_reg adds one leaf block", () => {
		const c = emitRegfileC(layoutRegfile(smoke_rw));
		expect(c).toContain("struct SMOKE_RW_CFG_BITS");
		expect(c).toContain("union SMOKE_RW_CFG");
		expect(c).toContain("volatile uint32_t ENABLE");
		expect(c).toContain("volatile uint32_t MODE");
		expect(c).toContain("volatile uint32_t all");
		expect(c).not.toContain("OFFSET_");
		expect(c).not.toContain("_Regdef");
		expect(c).not.toContain("tagBits");

		const uvm = emitRegfileUvm(layoutRegfile(smoke_rw));
		expect(uvm).toContain("class ral_reg_smoke_rw_CFG extends uvm_reg");
		expect(uvm).toContain('.configure(this, 1, 0, "RW", 0, 1\'h0, 1, 1, 0)');
		expect(uvm).toContain('.configure(this, 3, 8, "RW", 0, 3\'h1, 1, 1, 0)');
		// One leaf block per sheet; the bus side hangs it with add_submap.
		expect(uvm).toContain("class ral_block_smoke_rw extends uvm_reg_block");
		expect(uvm).toContain('default_map.add_reg(this.CFG, 32\'h00000000, "RW")');
		expect(uvm.match(/^class ral_block_smoke_rw /gm)?.length).toBe(1);
	});

	test("C/UVM shadow is a comment; reset dict uses copy 0", () => {
		const laid = layoutRegfile(smoke_shadow);
		const c = emitRegfileC(laid);
		expect(c).toContain("shadow: bank, 4 copies");
		expect(c).not.toContain("1:0");
		expect(c).not.toContain("remaps");
		const uvm = emitRegfileUvm(laid);
		expect(uvm).toContain("shadow: bank, 4 copies");
		expect(uvm).toContain('.configure(this, 8, 0, "RW", 0, 8\'h1, 1, 1, 0)');
		expect(uvm).not.toContain("tagBits");
	});

	test("generateAll writes C, uvm_reg, and Excel when toml paths are set", async () => {
		const dir = mkdtempSync(join(tmpdir(), "aw_regfile_sw_"));
		const access = join(import.meta.dir, "fixtures", "wb_reg_access.ts");
		writeFileSync(
			join(dir, "autowire.toml"),
			`
[workspace]
name = "acc"
[workspace.dump]
plugins_dir = "gen/plugins"
[plugins.wishbone]
c = "fw/gen"
uvm = "dv/ral"
export = "docs/regs.xlsx"
[wishbone.access]
ts = "${access.replaceAll("\\", "/")}"
exports = ["smoke_rw"]
`,
		);
		const ws = await loadWorkspace(join(dir, "autowire.toml"));
		const paths = await generateAll(ws);
		expect(paths.some((p) => p.endsWith("smoke_rw_regfile.sv"))).toBe(true);
		expect(paths.some((p) => p.endsWith("smoke_rw.h"))).toBe(true);
		expect(paths.some((p) => p.endsWith("acc.h"))).toBe(true);
		expect(paths.some((p) => p.endsWith("ral_SMOKE_RW.sv"))).toBe(true);
		expect(paths.some((p) => p.endsWith("ral_acc.sv"))).toBe(true);
		expect(paths.some((p) => p.endsWith("regs.xlsx"))).toBe(true);
		const hdr = readFileSync(join(dir, "fw/gen/regfile/smoke_rw.h"), "utf8");
		expect(hdr).toContain("union SMOKE_RW_CFG");
		const ral = readFileSync(
			join(dir, "dv/ral/regfile/ral_SMOKE_RW.sv"),
			"utf8",
		);
		expect(ral).toContain("class ral_reg_smoke_rw_CFG");
		const xlsx = readFileSync(join(dir, "docs/regs.xlsx"));
		expect(xlsx.byteLength).toBeGreaterThan(0);
		rmSync(dir, { recursive: true, force: true });
	});

	test("shared sheet emits one C header; layout mismatch is an error", async () => {
		const dir = mkdtempSync(join(tmpdir(), "aw_regfile_sheet_"));
		writeFileSync(
			join(dir, "autowire.toml"),
			`
[workspace]
name = "test"
[workspace.dump]
plugins_dir = "gen/plugins"
[plugins.wishbone]
c = "fw/gen"
`,
		);
		const ws = await loadWorkspace(join(dir, "autowire.toml"));
		const body = [
			Cell("CFG", "cfg", CellDefault, [
				Field("mode", Access.RW, 3, "Mode").reset(0),
			]),
		];
		const a = Regfile(
			"core_0",
			"lane 0",
			RegfileDefault.align(4).addrWidth(8).sheet("core"),
			body,
		);
		const b = Regfile(
			"core_1",
			"lane 1",
			RegfileDefault.align(4).addrWidth(8).sheet("core"),
			body,
		);
		const other = Regfile(
			"core_x",
			"mismatch",
			RegfileDefault.align(4).addrWidth(8).sheet("core"),
			[
				Cell("CFG", "cfg", CellDefault, [
					Field("mode", Access.RW, 4, "Mode").reset(0),
				]),
			],
		);
		const sheets = new Map<string, string>();
		const p0 = await generateDef(ws, a, sheets);
		const p1 = await generateDef(ws, b, sheets);
		expect(p0.some((p) => p.endsWith("core.h"))).toBe(true);
		expect(p1.some((p) => p.endsWith("core.h"))).toBe(false);
		expect(p1.some((p) => p.endsWith("core_1_regfile.sv"))).toBe(true);
		const hdr = readFileSync(join(dir, "fw/gen/regfile/core.h"), "utf8");
		expect(hdr).toContain("union CORE_CFG");
		expect(hdr).not.toContain("CORE_0");
		await expect(generateDef(ws, other, sheets)).rejects.toThrow(
			/sheet "core" reused by "core_x"/,
		);
		rmSync(dir, { recursive: true, force: true });
	});

	test("smoke FABRIC.rb_grant_en is RW reset-0 at 0x030", () => {
		const laid = layoutRegfile(smoke);
		const fabric = laid.cells.find((c) => c.name === "FABRIC");
		expect(fabric?.byte_offset).toBe(0x030);
		const sv = emitRegfileSv(laid);
		expect(sv).toContain("rg_rb_grant_en");
		expect(sv).toMatch(/rg_rb_grant_en_q <= 1'h0/);
	});

	test("access fixture generates all feature leaves via plugin generate", async () => {
		const dir = mkdtempSync(join(tmpdir(), "aw_regfile_access_"));
		const access = join(import.meta.dir, "fixtures", "wb_reg_access.ts");
		writeFileSync(
			join(dir, "autowire.toml"),
			`
[workspace]
name = "test"
[workspace.dump]
plugins_dir = "gen/plugins"
[wishbone.access]
ts = "${access.replaceAll("\\", "/")}"
`,
		);
		const ws = await loadWorkspace(join(dir, "autowire.toml"));
		const paths = await generateAll(ws);
		expect(paths.length).toBe(cases.length);
		expect(paths.some((p) => p.includes("smoke_regfile.sv"))).toBe(false);
		for (const { def } of cases) {
			expect(
				paths.some((p) => p.includes(`${def.name.toLowerCase()}_regfile.sv`)),
			).toBe(true);
		}
	});
});

describe("wishbone-regfile Excel export", () => {
	const formulaOf = (cell: { formula?: string; value?: unknown }): string => {
		if (typeof cell.formula === "string" && cell.formula.length > 0) {
			return cell.formula;
		}
		const v = cell.value;
		if (v && typeof v === "object" && "formula" in v) {
			return String((v as { formula: string }).formula);
		}
		return "";
	};

	test("trunk columns minus empty A and ADDRWIDTH; MSB-first reserved", () => {
		const wb = buildRegfileWorkbook([layoutRegfile(smoke_rw)]);
		const ws = wb.getWorksheet("regfile_smoke_rw");
		expect(ws).toBeDefined();
		const headers = ((ws?.getRow(1).values as unknown[]) ?? [])
			.slice(1)
			.map(String)
			.join("|");
		expect(headers).toContain("Sub-Addr");
		expect(headers).toContain("SHADOW");
		expect(headers).not.toContain("ADDRWIDTH");
		expect(ws?.columnCount).toBe(12);

		const cellRow = ws?.getRow(2);
		expect(cellRow?.getCell(1).value).toBe("00");
		expect(cellRow?.getCell(7).value).toBe("CFG");
		expect(formulaOf(cellRow?.getCell(4) ?? {})).toMatch(/^SUM\(D3:D\d+\)$/);
		expect(formulaOf(cellRow?.getCell(5) ?? {})).toContain("32'h");

		const topField = ws?.getRow(3);
		expect(topField?.getCell(2).value).toBe(11);
		expect(topField?.getCell(3).value).toBe(31);
		expect(topField?.getCell(6).value).toBe("RO");
		expect(topField?.getCell(7).value).toBe("reserved");
		expect(topField?.getCell(8).value).toBe("RESERVED");
		expect(topField?.getCell(12).value).toBe("");
	});

	test("SHADOW on cell row only; reset dict uses copy 0", () => {
		const wb = buildRegfileWorkbook([layoutRegfile(smoke_shadow)]);
		const ws = wb.getWorksheet("regfile_smoke_shadow");
		expect(ws).toBeDefined();
		expect(ws?.getRow(2).getCell(7).value).toBe("CFG");
		expect(ws?.getRow(2).getCell(12).value).toBe("bank");
		let cfgReset: unknown;
		ws?.eachRow((row, n) => {
			if (n === 1) return;
			if (row.getCell(7).value === "cfg") cfgReset = row.getCell(9).value;
		});
		expect(cfgReset).toBe(1);
	});
});

describe("wishbone-regfile demo/soc sha256", () => {
	test("sha256 layout matches legacy CTRL + HASH0..7 map", () => {
		const laid = layoutRegfile(sha256);
		expect(laid.cells.map((c) => c.byte_offset)).toEqual([
			0, 4, 8, 12, 16, 20, 24, 28, 32,
		]);
		const ctrl = laid.cells[0];
		expect(ctrl?.name).toBe("CTRL");
		expect(ctrl?.fields.map((f) => f.bit_offset)).toEqual([0, 1, 8, 9]);
	});

	test("note is Excel-only: same Description cell, not RTL or C", () => {
		const noteOf = (cell: { note?: unknown }): string => {
			const note = cell.note;
			if (!note) return "";
			if (typeof note === "string") return note;
			if (typeof note === "object" && note && "texts" in note) {
				return (note as { texts: { text: string }[] }).texts
					.map((t) => t.text)
					.join("");
			}
			return "";
		};
		const laid = layoutRegfile(sha256);
		const wb = buildRegfileWorkbook([laid]);
		expect(wb.getWorksheet("NOTES")).toBeUndefined();
		const ws = wb.getWorksheet("regfile_sha256");
		const headerNote = noteOf(ws?.getRow(1).getCell(8) ?? {});
		expect(headerNote.startsWith(`${sha256.desc}\n`)).toBe(true);
		expect(headerNote).toContain("byte-reversed");
		let soft = "";
		ws?.eachRow((row) => {
			if (row.getCell(7).value === "soft_reset")
				soft = String(row.getCell(8).value);
		});
		expect(soft.startsWith("Soft reset hash core\n")).toBe(true);
		expect(soft).toContain("Write 1 to reset the core.");
		const sv = emitRegfileSv(laid);
		const c = emitRegfileC(laid);
		expect(sv).not.toContain("byte-reversed");
		expect(c).not.toContain("byte-reversed");
		expect(sv).not.toContain("Write 1 to reset the core");
	});

	test("sha256 C/UVM types follow the single table name", () => {
		const c = emitRegfileC(layoutRegfile(sha256));
		expect(c).toContain("union SHA256_CTRL");
		expect(c).not.toContain("SHA256_0");
		const uvm = emitRegfileUvm(layoutRegfile(sha256));
		expect(uvm).toContain("class ral_reg_sha256_CTRL");
	});

	test("sha256 emit has Access prefixes and same-cycle ACK", () => {
		const sv = emitRegfileSv(layoutRegfile(sha256));
		expect(sv).toContain("module sha256_regfile");
		expect(sv).toContain("rg_soft_reset");
		expect(sv).toContain("p_rg_done_clear");
		expect(sv).toContain("ro_busy");
		expect(sv).toContain("ro_done");
		expect(sv).toContain("ro_hash7");
		expect(sv).toContain(
			"sha256_o_wb_ack = sha256_i_wb_cyc && sha256_i_wb_stb && hit",
		);
	});

	test("demo/soc toml generates one sha256_regfile and sha256.h", async () => {
		const ws = await loadWorkspace(
			join(import.meta.dir, "..", "demo", "soc", "autowire.toml"),
		);
		expect(ws.wishboneSources.some((s) => s.id === "sha256")).toBe(true);
		expect(
			ws.wishboneCExport?.replaceAll("\\", "/").endsWith("fw/gen/wishbone"),
		).toBe(true);
		const paths = await generateAll(ws, undefined, true);
		expect(paths.filter((p) => p.endsWith("sha256_regfile.sv"))).toHaveLength(
			1,
		);
		expect(paths.some((p) => p.endsWith("sha256_0_regfile.sv"))).toBe(false);
		expect(paths.some((p) => p.endsWith("sha256_1_regfile.sv"))).toBe(false);
		expect(paths.filter((p) => p.endsWith("sha256.h"))).toHaveLength(1);
		expect(paths.some((p) => p.endsWith("soc.h"))).toBe(true);
		const hdr = readFileSync(
			join(
				import.meta.dir,
				"..",
				"demo",
				"soc",
				"fw",
				"gen",
				"wishbone",
				"regfile",
				"sha256.h",
			),
			"utf8",
		);
		expect(hdr).toContain("union SHA256_CTRL");
		expect(paths.some((p) => p.endsWith("smoke.h"))).toBe(true);
		expect(sha256.name).toBe("sha256");
	});
});
