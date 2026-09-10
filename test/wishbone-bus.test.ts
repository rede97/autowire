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

	test("TGA decoder forwards tag to slave", () => {
		const def = Bus("tgad", "tag decoder", {
			masters: [Master("cpu", "CPU")],
			slaves: [Slave("s0", "tagged", 0, 0xffff_ff00, 2)],
		});
		expect(def.tag_width).toBe(2);
		const sv = emitBusSv(def);
		expect(sv).toContain("m_tga_i");
		expect(sv).toContain("s0_i_wb_tga");
		expect(sv).toContain("g_tga   = m_tga_i");
		expect(sv).toContain("= g_tga[1:0]");
	});

	test("TGA interconnect slices flat master tag vector", () => {
		const def = Bus("tgai", "tag interconnect", {
			masters: [Master("m0", "M0"), Master("m1", "M1")],
			slaves: [
				Slave("s0", "plain", 0, 0xffff_ff00),
				Slave("s1", "tagged", 0x1000, 0xffff_ff00, 2),
			],
		});
		expect(def.tag_width).toBe(2);
		const sv = emitBusSv(def);
		expect(sv).toContain("[3:0] m_tga_i");
		expect(sv).toContain("m_tga_i[0*2 +: 2]");
		expect(sv).toContain("m_tga_i[1*2 +: 2]");
		expect(sv).not.toContain("s0_i_wb_tga");
	});

	test("tag-free bus emits no tga anywhere", () => {
		const def = Bus("plain", "no tags", {
			masters: [Master("m0", "M0"), Master("m1", "M1")],
			slaves: [Slave("s0", "S0", 0, 0xffff_ff00)],
		});
		expect(def.tag_width).toBe(0);
		expect(emitBusSv(def)).not.toContain("tga");
	});

	test("addrWidth 16 parametrizes decode and ports", () => {
		const def = Bus("narrow", "16-bit address", {
			masters: [Master("cpu", "CPU")],
			slaves: [Slave("s0", "S0", 0x100, 0xff00)],
			addrWidth: 16,
		});
		const sv = emitBusSv(def);
		expect(sv).toContain("g_adr & 16'h");
		expect(sv).toContain("[15:0] m_adr_i");
	});

	test("demo interconnect drops unused integers and forwards smoke TGA", () => {
		const sv = emitBusSv(soc_wb);
		expect(sv).not.toContain("integer si");
		expect(sv).not.toContain("integer oi");
		// demo smoke slave declares tag 2 → fabric carries a 2-bit TGA
		expect(soc_wb.tag_width).toBe(2);
		expect(sv).toContain("[5:0] m_tga_i");
		expect(sv).toContain("= g_tga[1:0]");
		expect(sv).not.toContain("sram_i_wb_tga");
	});

	test("arbiter priority: lowest master index wins (multi-hot regression)", () => {
		// Unrolled if/else chain: the first matching (lowest-index) master takes
		// the grant — a shared accumulate would go multi-hot under contention
		// (caught by demo/soc --sd smoke: CPU+DMA concurrent CYC → cpu trap).
		const sv = emitBusSv(soc_wb);
		expect(sv).toContain("if      (m_cyc_i[0]) grant_nxt = 3'b001;");
		expect(sv).toContain("else if (m_cyc_i[1]) grant_nxt = 3'b010;");
		expect(sv).toContain("else if (m_cyc_i[2]) grant_nxt = 3'b100;");
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
