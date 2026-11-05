import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import {
	Access,
	Cell,
	CellDefault,
	Field,
	Regfile,
	RegfileDefault,
	Shadow,
} from "../src/plugins/wishbone-regfile/dsl.ts";
import { emitRegfileSv } from "../src/plugins/wishbone-regfile/emit.ts";
import { buildRegfileWorkbook } from "../src/plugins/wishbone-regfile/emit-excel.ts";
import { emitRegfileUvm } from "../src/plugins/wishbone-regfile/emit-sw.ts";
import { layoutRegfile } from "../src/plugins/wishbone-regfile/layout.ts";
import { verilatorSim, verilatorTest } from "./fixtures/verilator.ts";

// Tag 3 broadcasts; physical copy 3 is still observable on HW sidebands.
const remaps = { 0: 0b0001, 1: 0b0010, 2: 0b0100, 3: 0b1111 };
const w1cc = Regfile(
	"w1cc",
	"W1CC state-conditional sticky regression",
	RegfileDefault.addrWidth(8)
		.align(4)
		.shadows(
			Shadow("mux", 4, "1:0").remaps(remaps),
			Shadow("raw", 4, "3:2").remaps(remaps).innerShadowMux(false),
		)
		.resetDomains("por_n"),
	[
		Cell("SCALAR", "Scalar W1CC vector", CellDefault.ready("gate"), [
			Field("scalar", Access.W1CC, 16, "State-conditional sticky").reset(0),
		]),
		Cell("MUXED", "Muxed shadow W1CC", CellDefault.offset(4).shadow("mux"), [
			Field("muxed", Access.W1CC, 8, "Muxed sticky").reset({
				0: 0x10,
				1: 0x20,
				2: 0x40,
				3: 0x08,
			}),
		]),
		Cell("RAW", "Unmuxed shadow W1CC", CellDefault.offset(8).shadow("raw"), [
			Field("raw", Access.W1CC, 8, "Per-copy sticky").reset(0),
		]),
		Cell(
			"POR",
			"Independent POR reset W1CC",
			CellDefault.offset(0xc).resetDomain("por_n"),
			[Field("por", Access.W1CC, 1, "POR-held sticky").reset(1)],
		),
		Cell("LEGACY", "Legacy W1C arbitration", CellDefault.offset(0x10), [
			Field("legacy", Access.W1C, 1, "Legacy sticky set wins").reset(0),
			Field("mixed_conditional", Access.W1CC, 1, "Conditional sticky")
				.offset(1)
				.reset(0),
			Field("mixed_rw", Access.RW, 8, "Software value").offset(8).reset(0),
			Field("mixed_rww", Access.RWW, 8, "Hardware capture").offset(16).reset(0),
		]),
	],
);

describe("wishbone-regfile Access.W1CC", () => {
	verilatorTest(
		"executes old-q truth table, byte lanes, acceptance, shadow copies and resets",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "aw_regfile_w1cc_"));
			try {
				const dut = join(dir, "w1cc_regfile.sv");
				const tb = join(dir, "tb.sv");
				writeFileSync(dut, emitRegfileSv(layoutRegfile(w1cc)));
				const template = readFileSync(
					join(import.meta.dir, "fixtures", "wb_w1cc_tb.sv"),
					"utf8",
				);
				writeFileSync(
					tb,
					template.replace("__DUT__", "w1cc_regfile dut (.*);"),
				);
				const r = verilatorSim({
					dir: join(dir, "obj"),
					top: "tb",
					sources: [tb, dut],
				});
				expect(r.buildLog).not.toContain("%Error");
				expect(r.buildOk, r.buildLog).toBe(true);
				expect(r.exitCode, r.stdout + r.stderr).toBe(0);
				expect(r.stdout).toContain("PASS W1CC RTL regression");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		300_000,
	);

	test("Excel serialization round-trip preserves raw W1CC access", async () => {
		const wb = await buildRegfileWorkbook([layoutRegfile(w1cc)]);
		const reread = new ExcelJS.Workbook();
		await reread.xlsx.load(await wb.xlsx.writeBuffer());
		const sheet = reread.getWorksheet("regfile_w1cc");
		expect(sheet).toBeDefined();
		const accesses = new Map<string, string>();
		sheet?.eachRow((row) => {
			const name = String(row.getCell(7).value);
			if (!["scalar", "muxed", "raw", "por", "legacy"].includes(name)) {
				return;
			}
			accesses.set(name, String(row.getCell(6).value));
		});
		expect(Object.fromEntries(accesses)).toEqual({
			scalar: "W1CC",
			muxed: "W1CC",
			raw: "W1CC",
			por: "W1CC",
			legacy: "W1C",
		});
	});

	test("UVM maps W1CC to the standard software W1C policy", () => {
		const laid = layoutRegfile(w1cc);
		const uvm = emitRegfileUvm(laid);
		expect(uvm).toContain('.configure(this, 16, 0, "W1C", 0, 16\'h0, 1, 0, 0)');
		expect(uvm).toContain('.configure(this, 1, 0, "W1C", 0, 1\'h1, 1, 0, 0)');
		expect(uvm).not.toContain('"W1CC"');
	});
});
