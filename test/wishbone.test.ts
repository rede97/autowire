import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { soc_wb } from "../demo/soc/bus/soc_wb.ts";
import { smoke } from "../demo/soc/regs/smoke.ts";
import { generateAll } from "../src/plugins/wishbone/generate.ts";
import { buildRegfileWorkbook } from "../src/plugins/wishbone-regfile/emit-excel.ts";
import { layoutRegfile } from "../src/plugins/wishbone-regfile/layout.ts";
import { loadWorkspace } from "../src/workspace.ts";

describe("wishbone pack", () => {
	test("Excel packs field sheets and MAP_<bus>", () => {
		const wb = buildRegfileWorkbook([layoutRegfile(smoke)], [soc_wb]);
		expect(wb.worksheets.map((s) => s.name)).toContain("smoke");
		expect(wb.worksheets.map((s) => s.name)).toContain("MAP_soc_wb");
		const map = wb.getWorksheet("MAP_soc_wb");
		expect(map?.getCell(1, 1).value).toBe("Slave");
		const slaves = new Set<string>();
		map?.eachRow((row, n) => {
			if (n === 1) return;
			const v = row.getCell(1).value;
			if (typeof v === "string") slaves.add(v);
		});
		expect(slaves.has("smoke")).toBe(true);
		expect(slaves.has("sha256_0")).toBe(true);
		expect(slaves.has("sram")).toBe(false);
	});

	test("bus source emits attached leaf SV without listing the leaf file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "aw_wb_pack_"));
		const bus = join(import.meta.dir, "..", "demo", "soc", "bus", "soc_wb.ts");
		writeFileSync(
			join(dir, "autowire.toml"),
			`
[dump]
plugins_dir = "gen/plugins"
[plugins.wishbone]
c = "fw/gen"
uvm = "dv/ral"
export = "docs/wishbone.xlsx"
[wishbone.soc]
ts = "${bus.replaceAll("\\", "/")}"
exports = ["soc_wb"]
`,
		);
		const ws = await loadWorkspace(join(dir, "autowire.toml"));
		const paths = await generateAll(ws);
		expect(paths.some((p) => p.endsWith("sha256_regfile.sv"))).toBe(true);
		expect(paths.some((p) => p.endsWith("smoke_regfile.sv"))).toBe(true);
		expect(paths.some((p) => p.endsWith("soc_wb_system.sv"))).toBe(true);
		expect(paths.some((p) => p.endsWith("wishbone.h"))).toBe(true);
		expect(paths.some((p) => p.endsWith("ral_wishbone.sv"))).toBe(true);
		expect(paths.some((p) => p.endsWith("wishbone.xlsx"))).toBe(true);
		const umbrella = readFileSync(join(dir, "fw/gen/wishbone.h"), "utf8");
		expect(umbrella).toContain('#include "sha256.h"');
		expect(umbrella).toContain('#include "soc_wb_map.h"');
		rmSync(dir, { recursive: true, force: true });
	});
});
