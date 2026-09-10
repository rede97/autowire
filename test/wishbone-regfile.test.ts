import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	sub_module_a,
	sub_module_b,
} from "../docs/examples/regfile/regfile.ts";
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
		expect(sv).not.toContain("o_enable");
		expect(sv).not.toContain("i_busy");
	});

	test("emit aligns port and signal declaration columns", () => {
		const sv = emitRegfileSv(layoutRegfile(sub_module_b));
		// port_align: dir / logic / packed; names share one column
		expect(sv).toContain("\tinput  logic        i_clk,");
		expect(sv).toContain("\tinput  logic [15:0] i_wb_adr,");
		expect(sv).toContain("\toutput logic [31:0] o_wb_dat");
		// signal_align: packed column; names share one column
		expect(sv).toContain("\tlogic        hit;");
		expect(sv).toContain("\tlogic [31:0] rd_data;");
	});

	test("emit includes module and same-cycle ack", () => {
		const sv = emitRegfileSv(layoutRegfile(sub_module_b));
		expect(sv).toContain("module sub_module_b_regfile");
		expect(sv).toContain("o_wb_ack");
		expect(sv).toContain("i_wb_cyc && i_wb_stb && hit");
		expect(sv).toContain("16'h1");
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
