import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { soc_wb } from "../demo/soc/bus/soc_wb.ts";
import { Bus, Master, Slave } from "../src/plugins/wishbone-bus/dsl.ts";
import {
	busModuleKind,
	busModuleName,
	emitBusSv,
} from "../src/plugins/wishbone-bus/emit.ts";
import { generateAll } from "../src/plugins/wishbone-bus/generate.ts";
import { loadWorkspace } from "../src/workspace.ts";

describe("wishbone-bus", () => {
	test("single master degenerates to decoder", () => {
		const def = Bus("demo", "one master", {
			masters: [Master("cpu", "CPU")],
			slaves: [Slave("csr", "regs", 0, 0xffff_ff00)],
		});
		expect(busModuleKind(def)).toBe("decoder");
		expect(busModuleName(def)).toBe("demo_decoder");
		const sv = emitBusSv(def);
		expect(sv).toContain("module demo_decoder");
		expect(sv).toContain("csr_i_wb_cyc");
		expect(sv).toContain("csr_o_wb_ack");
		expect(sv).not.toContain("grant");
	});

	test("multi master emits interconnect with named slaves", () => {
		expect(busModuleKind(soc_wb)).toBe("interconnect");
		const sv = emitBusSv(soc_wb);
		expect(sv).toContain("module soc_wb_interconnect");
		expect(sv).toContain("smoke_i_wb_cyc");
		expect(sv).toContain("smoke_o_wb_ack");
		expect(sv).toContain("sha256_0_i_wb_adr");
		expect(sv).toContain("grant");
		expect(sv).not.toContain("s_cyc_o");
	});

	test("demo/soc toml generates soc_wb_interconnect", async () => {
		const ws = await loadWorkspace(
			join(import.meta.dir, "..", "demo", "soc", "autowire.toml"),
		);
		expect(ws.busSources.some((s) => s.id === "soc")).toBe(true);
		const paths = await generateAll(ws, ws.busSources);
		expect(paths.some((p) => p.endsWith("soc_wb_interconnect.sv"))).toBe(true);
	});

	test("zero masters also decoder", () => {
		const def = Bus("solo", "no masters listed", {
			slaves: [Slave("a", "A", 0, 0xffff_ffff)],
		});
		expect(busModuleKind(def)).toBe("decoder");
	});

	test("generateAll writes plugins_dir", async () => {
		const dir = mkdtempSync(join(tmpdir(), "aw_bus_"));
		const ts = join(dir, "bus.ts");
		writeFileSync(
			ts,
			`
import { Bus, Master, Slave } from ${JSON.stringify(join(import.meta.dir, "../src/plugins/wishbone-bus/dsl.ts"))};
export const tiny = Bus("tiny", "t", {
  masters: [Master("m", "m")],
  slaves: [Slave("s0", "s", 0, 0xfffffffc)],
});
`,
		);
		writeFileSync(
			join(dir, "autowire.toml"),
			`
[dump]
plugins_dir = "gen/plugins"
[bus.t]
ts = "${ts.replaceAll("\\", "/")}"
`,
		);
		const ws = await loadWorkspace(join(dir, "autowire.toml"));
		const paths = await generateAll(ws, ws.busSources);
		expect(paths).toHaveLength(1);
	});
});
