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
	test("Excel Address Map indents 2-row blocks and stops at regfile leaves", async () => {
		const wb = await buildRegfileWorkbook([layoutRegfile(smoke)], [soc_wb]);
		const names = wb.worksheets.map((s) => s.name);
		expect(names).toContain("regfile_smoke");
		expect(names).toContain("bus_map_soc_wb");
		expect(names.indexOf("bus_map_soc_wb")).toBeLessThan(
			names.indexOf("regfile_smoke"),
		);
		expect(wb.getWorksheet("regfile_smoke")?.properties.tabColor).toEqual({
			argb: "FFC6E0B4",
			theme: 0,
		});
		const map = wb.getWorksheet("bus_map_soc_wb");
		if (!map) throw new Error("Address Map sheet missing");
		expect(map.properties.tabColor).toEqual({ argb: "FFBDD7EE", theme: 0 });
		expect(names).not.toContain("sd_sha");
		// Two header rows: address column plus one 3-column group per level.
		expect(map.getCell(1, 1).value).toBe("Abs Addr");
		expect(map.getCell(1, 4).value).toBe("Tag / Broadcast");
		expect(map.getCell(2, 2).value).toBe("Name");
		expect(map.getCell(2, 4).value).toBe("Description");
		// Root block at depth 0, then slaves at depth 1 (columns 5..7).
		expect(map.getCell(4, 2).value).toBe("soc_wb");
		expect(map.getCell(4, 3).value).toBe("interconnect");
		const nameAt = (depth: number): string[] => {
			const col = 2 + depth * 3;
			const out: string[] = [];
			map.eachRow((row, n) => {
				if (n <= 2) return;
				const v = row.getCell(col).value;
				const type = row.getCell(col + 1).value;
				if (typeof v === "string" && typeof type === "string") out.push(v);
			});
			return out;
		};
		const level1 = nameAt(1);
		expect(level1).toContain("sram");
		expect(level1).toContain("ch0");
		expect(level1).toContain("smoke");
		// ch0 opens one level deeper; ch1 repeats the same BusDef and stays closed.
		const level2 = nameAt(2);
		expect(level2).toContain("sha256");
		const ch1 = level1.indexOf("ch1");
		expect(ch1).toBeGreaterThan(-1);
		const closed = nameAt(1).filter((n) => n === "ch1");
		expect(closed).toHaveLength(1);
		// No register/field breakdown on the map sheet.
		let text = "";
		map.eachRow((row) => {
			row.eachCell((cell) => {
				text += String(cell.value ?? "");
			});
		});
		expect(text).not.toContain("ID@0x");
		expect(text).toContain("repeat of sd_sha");
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
[workspace]
name = "soc"
[workspace.dump]
plugins_dir = "gen/plugins"
[plugins.wishbone]
c = "fw/gen"
uvm = "dv/ral"
export = "docs/bus_regfiles.xlsx"
[wishbone.soc]
ts = "${bus.replaceAll("\\", "/")}"
exports = ["soc_wb"]
`,
		);
		const ws = await loadWorkspace(join(dir, "autowire.toml"));
		const paths = await generateAll(ws);
		expect(paths.some((p) => p.endsWith("sha256_regfile.sv"))).toBe(true);
		expect(paths.some((p) => p.endsWith("smoke_regfile.sv"))).toBe(true);
		expect(paths.some((p) => p.endsWith("soc_wb_bus_cfg.sv"))).toBe(true);
		expect(paths.some((p) => p.endsWith("sd_sha_bus_cfg.sv"))).toBe(true);
		expect(paths.some((p) => p.endsWith("soc.h"))).toBe(true);
		expect(paths.some((p) => p.endsWith("ral_soc.sv"))).toBe(true);
		expect(paths.some((p) => p.endsWith("bus_regfiles.xlsx"))).toBe(true);
		const umbrella = readFileSync(join(dir, "fw/gen/soc.h"), "utf8");
		expect(umbrella).toContain('#include "regfile/sha256.h"');
		expect(umbrella).toContain('#include "bus/soc_wb_map.h"');
		rmSync(dir, { recursive: true, force: true });
	});
});
