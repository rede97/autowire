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

	test("multi master emits interconnect with named masters and slaves", () => {
		expect(busModuleKind(soc_wb)).toBe("interconnect");
		const sv = emitBusSv(soc_wb);
		expect(sv).toContain("module soc_wb_interconnect");
		expect(sv).toContain("cpu_o_wb_cyc");
		expect(sv).toContain("dma1m_i_wb_ack");
		expect(sv).toContain("smoke_i_wb_cyc");
		expect(sv).toContain("smoke_o_wb_ack");
		expect(sv).toContain("sha256_0_i_wb_adr");
		expect(sv).toContain("grant");
		expect(sv).not.toContain("m_adr_i");
		expect(sv).not.toContain("s_cyc_o");
	});

	test("demo/soc toml generates soc_wb_interconnect", async () => {
		const ws = await loadWorkspace(
			join(import.meta.dir, "..", "demo", "soc", "autowire.toml"),
		);
		expect(ws.busSources.some((s) => s.id === "soc")).toBe(true);
		const paths = await generateAll(ws, ws.busSources);
		expect(paths.some((p) => p.endsWith("soc_wb_interconnect.sv"))).toBe(true);
		expect(paths.some((p) => p.endsWith("wb_cfg_pipe.sv"))).toBe(true);
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

	test("TGA interconnect uses named master ports", () => {
		const def = Bus("tgai", "tag interconnect", {
			masters: [Master("m0", "M0"), Master("m1", "M1")],
			slaves: [
				Slave("s0", "plain", 0, 0xffff_ff00),
				Slave("s1", "tagged", 0x1000, 0xffff_ff00, 2),
			],
		});
		expect(def.tag_width).toBe(2);
		const sv = emitBusSv(def);
		expect(sv).toContain("m0_o_wb_tga");
		expect(sv).toContain("m1_o_wb_tga");
		expect(sv).toContain("({2{gsel[1]}} & m1_o_wb_tga)");
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
		expect(sv).toContain("cpu_o_wb_tga");
		expect(sv).toContain("g_tga[1:0]");
		expect(sv).not.toContain("sram_i_wb_tga");
	});

	test("demo SoC slaves use mixed PIPE depths", () => {
		const depths = soc_wb.slaves.map((s) => s.pipe);
		expect(new Set(depths).size).toBeGreaterThan(2);
		expect(soc_wb.slaves.find((s) => s.name === "flash_cfg")?.pipe).toBe(0);
		expect(soc_wb.slaves.find((s) => s.name === "sd0")?.pipe).toBe(2);
		expect(soc_wb.slaves.find((s) => s.name === "sd1")?.pipe).toBe(4);
		expect(soc_wb.slaves.find((s) => s.name === "smoke")?.pipe).toBe(3);
		const sv = emitBusSv(soc_wb);
		expect(sv).toContain(
			"wb_cfg_pipe #(.PIPE(2), .AW(32), .TW(0)) u_sram_pipe",
		);
		expect(sv).toContain(
			"wb_cfg_pipe #(.PIPE(3), .AW(32), .TW(2)) u_smoke_pipe",
		);
		expect(sv).not.toContain("wb_pipe_beat_t");
		expect(sv).not.toContain("flash_cfg_pipe");
		const sramInst = sv.slice(
			sv.indexOf("u_sram_pipe"),
			sv.indexOf("u_flash_xip_pipe"),
		);
		expect(sramInst).not.toContain("m_tga");
		expect(sramInst).not.toContain("s_tga");
		const smokeInst = sv.slice(sv.indexOf("u_smoke_pipe"));
		expect(smokeInst).toContain(".m_tga(g_tga[1:0])");
		expect(smokeInst).toContain(".s_tga(smoke_i_wb_tga)");
	});

	test("arbiter priority: lowest master index wins (multi-hot regression)", () => {
		// Unrolled if/else chain: the first matching (lowest-index) master takes
		// the grant — a shared accumulate would go multi-hot under contention
		// (caught by demo/soc --sd smoke: CPU+DMA concurrent CYC → cpu trap).
		const sv = emitBusSv(soc_wb);
		expect(sv).toContain("if      (cpu_o_wb_cyc)");
		expect(sv).toContain("else if (dma0m_o_wb_cyc) grant_nxt = 3'b010;");
		expect(sv).toContain("else if (dma1m_o_wb_cyc) grant_nxt = 3'b100;");
	});

	test("Slave fifth-arg number is tag, not pipe", () => {
		const s = Slave("s0", "t", 0, 0xff, 2);
		expect(s.tag).toBe(2);
		expect(s.pipe).toBe(0);
	});

	test("slave pipe must be 0..16", () => {
		expect(() => Slave("s0", "t", 0, 0xff, { pipe: 17 })).toThrow(/pipe/);
		expect(() => Slave("s0", "t", 0, 0xff, { pipe: -1 })).toThrow(/pipe/);
	});

	test("slave PIPE instantiates wb_cfg_pipe; TGA ports connected only when tagged", () => {
		const def = Bus("piped", "pipe", {
			masters: [Master("cpu", "CPU")],
			slaves: [
				Slave("near", "combo", 0, 0xffff_ff00),
				Slave("far", "piped", 0x1000, 0xffff_ff00, { pipe: 2, tag: 2 }),
			],
		});
		const sv = emitBusSv(def);
		expect(sv).toContain("wb_cfg_pipe #(.PIPE(2), .AW(32), .TW(2)) u_far_pipe");
		expect(sv).toContain(".m_tga(g_tga[1:0])");
		expect(sv).toContain(".s_tga(far_i_wb_tga)");
		expect(sv).toContain(".m_ack(far_pipe_ack)");
		expect(sv).toContain(".m_rdat(far_pipe_rdat)");
		expect(sv).not.toContain("near_pipe");
		expect(sv).not.toContain("wb_pipe_beat_t");
		expect(sv).toContain("(far_pipe_ack)");
		expect(sv).toContain("near_o_wb_ack");
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
		expect(paths.some((p) => p.endsWith("wb_cfg_pipe.sv"))).toBe(true);
		expect(paths.some((p) => p.endsWith("tiny_decoder.sv"))).toBe(true);
		expect(paths).toHaveLength(2);
	});
});
