import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { soc_wb } from "../demo/soc/sot/wb_bus_soc.ts";
import { smoke } from "../demo/soc/sot/wb_reg_smoke.ts";
import { generateAll } from "../src/plugins/wishbone/generate.ts";
import { buildRegfileWorkbook } from "../src/plugins/wishbone-regfile/emit-excel.ts";
import { layoutRegfile } from "../src/plugins/wishbone-regfile/layout.ts";
import { loadWorkspace } from "../src/workspace.ts";

describe("wishbone pack", () => {
	test("Excel bus sheet lists address leaves, not every register", () => {
		const wb = buildRegfileWorkbook([layoutRegfile(smoke)], [soc_wb]);
		const names = wb.worksheets.map((s) => s.name);
		expect(names).toContain("smoke");
		expect(names).toContain("soc_wb");
		expect(names).not.toContain("MAP_soc_wb");
		expect(names).not.toContain("sd_sha");
		const map = wb.getWorksheet("soc_wb");
		expect(map?.getCell(1, 1).value).toBe("Address");
		expect(map?.getCell(1, 5).value).toBe("Bits");
		const windows = new Set<string>();
		map?.eachRow((row, n) => {
			if (n === 1) return;
			const v = row.getCell(2).value;
			if (typeof v === "string") windows.add(v);
		});
		expect(windows.has("smoke")).toBe(true);
		expect(windows.has("ch0")).toBe(true);
		expect(windows.has("sha256")).toBe(true);
		expect(windows.has("sram")).toBe(true);
		const smokeRow = map?.getColumn(2).values.indexOf("smoke");
		if (smokeRow === undefined) throw new Error("MAP sheet missing");
		expect(smokeRow).toBeGreaterThan(1);
		const bits = String(map?.getCell(smokeRow, 5).value ?? "");
		expect(bits).toContain("[");
		expect(bits).not.toContain("\n");
	});

	test("bus source emits attached leaf SV without listing the leaf file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "aw_wb_pack_"));
		const bus = join(
			import.meta.dir,
			"..",
			"demo",
			"soc",
			"sot",
			"wb_bus_soc.ts",
		);
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
		expect(paths.some((p) => p.endsWith("sd_sha_system.sv"))).toBe(true);
		expect(paths.some((p) => p.endsWith("wishbone.h"))).toBe(true);
		expect(paths.some((p) => p.endsWith("ral_wishbone.sv"))).toBe(true);
		expect(paths.some((p) => p.endsWith("wishbone.xlsx"))).toBe(true);
		const umbrella = readFileSync(join(dir, "fw/gen/wishbone.h"), "utf8");
		expect(umbrella).toContain('#include "sha256.h"');
		expect(umbrella).toContain('#include "soc_wb_map.h"');
		rmSync(dir, { recursive: true, force: true });
	});
});
