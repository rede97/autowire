import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sd_sha } from "../demo/soc/sot/wb_bus_sd_sha.ts";
import { soc_wb } from "../demo/soc/sot/wb_bus_soc.ts";
import { sha256 } from "../demo/soc/sot/wb_reg_sha256.ts";
import { smoke } from "../demo/soc/sot/wb_reg_smoke.ts";
import { generateAll } from "../src/plugins/wishbone/generate.ts";
import {
	Bus,
	Master,
	Size,
	Slave,
	SlaveBus,
	SlaveRegfile,
	SlaveRegion,
	UPLINK_MASTER,
} from "../src/plugins/wishbone-bus/dsl.ts";
import {
	busModuleKind,
	busModuleName,
	emitBusSv,
} from "../src/plugins/wishbone-bus/emit.ts";
import { emitBusSystemSv } from "../src/plugins/wishbone-bus/emit-attach.ts";
import {
	emitBusMapC,
	emitBusMapUvm,
	emitBusRalf,
} from "../src/plugins/wishbone-bus/emit-map.ts";
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
		expect(sv).not.toContain("rb_grant_en");
	});

	test("multi master emits interconnect with named masters and slaves", () => {
		expect(busModuleKind(sd_sha)).toBe("interconnect");
		const sv = emitBusSv(sd_sha);
		expect(sv).toContain("module sd_sha_interconnect");
		expect(sv).toContain("uplink_o_wb_cyc");
		expect(sv).toContain("eng_i_wb_ack");
		expect(sv).toContain("sha256_i_wb_cyc");
		expect(sv).toContain("sha256_o_wb_ack");
		expect(sv).toContain("grant");
		expect(sv).toContain("rb_grant_en");
		expect(sv).not.toContain("m_adr_i");
		expect(sv).not.toContain("s_cyc_o");
	});

	test("demo/soc top interconnect (cpu + JTAG) cascades into two SlaveBus channels", () => {
		expect(busModuleKind(soc_wb)).toBe("interconnect");
		expect(soc_wb.masters.map((m) => m.name)).toEqual(["cpu", "dbg"]);
		const sv = emitBusSv(soc_wb);
		expect(sv).toContain("module soc_wb_interconnect");
		expect(sv).toContain("cpu_o_wb_adr");
		expect(sv).toContain("dbg_o_wb_adr");
		expect(sv).toContain("ch0_i_wb_cyc");
		expect(sv).toContain("ch1_o_wb_ack");
		expect(sv).toContain("smoke_i_wb_cyc");
		expect(sv).toContain("rb_grant_en");
		expect(sv).not.toContain("m_adr_i");
	});

	test("demo/soc toml generates top + channel interconnect and master bridges", async () => {
		const ws = await loadWorkspace(
			join(import.meta.dir, "..", "demo", "soc", "autowire.toml"),
		);
		expect(ws.wishboneSources.some((s) => s.id === "soc")).toBe(true);
		expect(
			ws.wishboneCExport?.replaceAll("\\", "/").endsWith("fw/gen/wishbone"),
		).toBe(true);
		const paths = await generateAll(ws);
		const root = join(import.meta.dir, "..", "demo", "soc");
		const present = (name: string) =>
			paths.some((p) => p.endsWith(name)) ||
			existsSync(join(root, "rtl/gen/plugins/wishbone", name)) ||
			existsSync(join(root, "fw/gen/wishbone", name)) ||
			existsSync(join(root, "dv/ral", name));
		expect(present("soc_wb_interconnect.sv")).toBe(true);
		expect(present("wb_jtag_tdr.sv")).toBe(true);
		expect(present("wb_cdc.sv")).toBe(true);
		expect(present("soc_wb_system.icl")).toBe(true);
		expect(present("soc_wb_system.sv")).toBe(true);
		expect(present("sd_sha_interconnect.sv")).toBe(true);
		expect(present("sd_sha_system.sv")).toBe(true);
		expect(present("wb_cfg_pipe.sv")).toBe(true);
		expect(present("soc_wb_map.h")).toBe(true);
		expect(present("sd_sha_map.h")).toBe(true);
		expect(present("ral_block_soc_wb.sv")).toBe(true);
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
		expect(sv).toContain("m_tga_tag");
		expect(sv).toContain("s0_i_wb_tga_tag");
		expect(sv).toContain("g_tga_tag = g_up_tag");
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
		expect(sv).toContain("m0_o_wb_tga_tag");
		expect(sv).toContain("m1_o_wb_tga_tag");
		expect(sv).toContain("({2{gsel[1]}} & m1_o_wb_tga_tag)");
		expect(sv).not.toContain("s0_i_wb_tga_tag");
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

	test("demo interconnect produces smoke TGA and forwards it", () => {
		const sv = emitBusSv(soc_wb);
		expect(soc_wb.tag_width).toBe(2);
		expect(sv).toContain("assign g_tga_bank = g_adr[31:30];");
		expect(sv).not.toContain("bank_tag_i");
		expect(sv).not.toContain("cpu_o_wb_tga");
		expect(sv).not.toContain("dbg_o_wb_tga");
		expect(sv).toContain("g_tga_bank");
		expect(sv).not.toContain("sram_i_wb_tga_bank");
		expect(sv).toContain("localparam int unsigned SLOT_SRAM");
		expect(sv).toContain("localparam int unsigned SLOT_CH1");
		expect(sv).toContain("slot_sel = 8'd1 << SLOT_CH1;");
		expect(sv).toContain("slot_sel[SLOT_CH1]");
		expect(sv).not.toMatch(/slot_sel\[\d+\]/);
	});

	test("demo SoC slaves use mixed PIPE depths", () => {
		const depths = soc_wb.slaves.map((s) => s.pipe);
		expect(new Set(depths).size).toBeGreaterThan(2);
		expect(soc_wb.slaves.find((s) => s.name === "flash_cfg")?.pipe).toBe(0);
		expect(soc_wb.slaves.find((s) => s.name === "ch0")?.pipe).toBe(2);
		expect(soc_wb.slaves.find((s) => s.name === "ch1")?.pipe).toBe(4);
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
		expect(smokeInst).toContain(".m_tga(g_tga_bank)");
		expect(smokeInst).toContain(".s_tga(smoke_i_wb_tga_bank)");
	});

	test("arbiter priority: lowest master index wins (multi-hot regression)", () => {
		const sv = emitBusSv(sd_sha);
		expect(sv).toContain("if      (uplink_o_wb_cyc)");
		expect(sv).toContain("else if (eng_o_wb_cyc)");
		expect(sv).toContain("prio_gnt = 2'b10;");
		expect(sv).toContain(
			"grant_nxt = (rb_grant_en && |rr_req_hi) ? rr_hi_gnt : prio_gnt;",
		);
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

	test("master pipe must be 0..16 and defaults to 0", () => {
		expect(Master("cpu", "CPU").pipe).toBe(0);
		expect(Master("cpu", "CPU", { pipe: 3 }).pipe).toBe(3);
		expect(() => Master("cpu", "CPU", { pipe: 17 })).toThrow(/pipe/);
		expect(() => Master("cpu", "CPU", { pipe: -1 })).toThrow(/pipe/);
	});

	test("master PIPE sits in front of the arbiter and holds the grant", () => {
		const def = Bus("mp", "master pipe", {
			masters: [Master("fast", "piped", { pipe: 2 }), Master("slow", "combo")],
			slaves: [Slave("mem", "mem", 0, 0xffff_0000, { tag: 2 })],
			tagWidth: 2,
		});
		const sv = emitBusSv(def);
		expect(sv).toContain(
			"wb_cfg_pipe #(.PIPE(2), .AW(32), .TW(2)) u_fast_mpipe",
		);
		expect(sv).not.toContain("u_slow_mpipe");
		const inst = sv.slice(
			sv.indexOf("u_fast_mpipe"),
			sv.indexOf("Arbitration"),
		);
		expect(inst).toContain(".m_cyc(fast_o_wb_cyc)");
		expect(inst).toContain(".m_tga(fast_o_wb_tga_tag)");
		expect(inst).toContain(".s_cyc(m0_cyc_q)");
		expect(inst).toContain(".s_tga(m0_tga_q)");
		expect(inst).toContain(".m_ack(m0_pack)");
		expect(inst).not.toContain(".m_tga(slow");
		expect(sv).toContain("assign m_cyc = {slow_o_wb_cyc, m0_cyc_q};");
		expect(sv).toContain("if      (m0_cyc_q)");
		expect(sv).toContain("else if (slow_o_wb_cyc)");
		expect(sv).toContain("({32{gsel[0]}} & m0_adr_q)");
		expect(sv).toContain("({32{gsel[1]}} & slow_o_wb_adr)");
		expect(sv).toContain("assign m0_rdat_q = {32{gsel[0]}} & rsp_dat;");
		expect(sv).toContain("assign fast_i_wb_ack = m0_pack;");
		expect(sv).toContain("assign slow_i_wb_ack = gsel[1] & rsp_ack;");
		expect(sv).toContain("// Master fast — piped  pipe=2");
	});

	test("decoder master PIPE sits in front of decode", () => {
		const def = Bus("dp", "decoder pipe", {
			masters: [Master("cpu", "CPU", { pipe: 1 })],
			slaves: [Slave("csr", "regs", 0, 0xffff_ff00)],
		});
		const sv = emitBusSv(def);
		expect(sv).toContain(
			"wb_cfg_pipe #(.PIPE(1), .AW(32), .TW(0)) u_cpu_mpipe",
		);
		const inst = sv.slice(
			sv.indexOf("u_cpu_mpipe"),
			sv.indexOf("Address decode"),
		);
		expect(inst).toContain(".m_cyc(m_cyc_i)");
		expect(inst).toContain(".m_adr(m_adr_i)");
		expect(inst).toContain(".s_cyc(m_cyc_q)");
		expect(inst).not.toContain("m_tga");
		expect(sv).toContain("assign g_cyc   = m_cyc_q;");
		expect(sv).toContain("assign m_ack_o  = m_pack;");
		expect(sv).not.toContain("assign g_cyc   = m_cyc_i;");
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
		expect(sv).toContain(".m_tga(g_tga_tag)");
		expect(sv).toContain(".s_tga(far_i_wb_tga_tag)");
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
[wishbone.t]
ts = "${ts.replaceAll("\\", "/")}"
`,
		);
		const ws = await loadWorkspace(join(dir, "autowire.toml"));
		const paths = await generateAll(ws);
		expect(paths.some((p) => p.endsWith("wb_cfg_pipe.sv"))).toBe(true);
		expect(paths.some((p) => p.endsWith("tiny_decoder.sv"))).toBe(true);
		expect(paths).toHaveLength(2);
	});

	test("SlaveRegion Size derives pow2 mask and rejects unaligned base", () => {
		const sram = SlaveRegion("sram", "64K", 0, Size(0x1_0000));
		expect(sram.size).toBe(0x1_0000);
		expect(sram.mask).toBe(0xffff_0000);
		expect(sram.mask_auto).toBe(true);
		expect(SlaveRegion("cell", "36B span", 0, Size(36)).mask).toBe(0xffff_ffc0);
		expect(soc_wb.slaves.find((s) => s.name === "sram")?.size).toBe(0x1_0000);
		expect(soc_wb.slaves.find((s) => s.name === "sram")?.mask).toBe(
			0xffff_0000,
		);
		expect(soc_wb.slaves.find((s) => s.name === "ch0")?.size).toBe(0x1000);
		expect(soc_wb.slaves.find((s) => s.name === "sram")?.window).toBe("region");
		expect(soc_wb.slaves.find((s) => s.name === "uart")?.size).toBeUndefined();
		expect(soc_wb.slaves.find((s) => s.name === "uart")?.window).toBe("raw");
		expect(soc_wb.slaves.find((s) => s.name === "uart")?.mask).toBe(
			0xffff_fff8,
		);
		const narrow = Bus("narrow_sz", "16-bit Size", {
			slaves: [SlaveRegion("s0", "S0", 0x100, Size(0x100))],
			addrWidth: 16,
		});
		expect(narrow.slaves[0]?.mask).toBe(0xff00);
		expect(() => SlaveRegion("bad", "t", 0x10, Size(32))).toThrow(/aligned/);
		expect(() => Size(0)).toThrow(/Size/);
		expect(() =>
			SlaveRegion("bad", "t", 0, 0x100 as unknown as ReturnType<typeof Size>),
		).toThrow(/Size/);
	});

	test("SlaveRegfile derives id/mask/tag and supports multi-hang", () => {
		expect(sd_sha.slaves.find((s) => s.name === "sha256")?.regfile?.name).toBe(
			"sha256",
		);
		expect(soc_wb.slaves.find((s) => s.name === "smoke")?.regfile?.name).toBe(
			"smoke",
		);
		expect(
			soc_wb.slaves.find((s) => s.name === "sram")?.regfile,
		).toBeUndefined();
		expect(sd_sha.slaves.find((s) => s.name === "sha256")?.mask).toBe(
			0xffff_ffc0,
		);
		expect(soc_wb.slaves.find((s) => s.name === "smoke")?.mask).toBe(
			0xffff_ffc0,
		);
		expect(soc_wb.slaves.find((s) => s.name === "smoke")?.tag).toBe(2);
		expect(() => SlaveRegfile(smoke, 0x0300_6000, { tag: 1 })).toThrow(
			/tga_width/,
		);
		expect(() => SlaveRegfile(sha256, 0x0300_4010, { id: "sha256_x" })).toThrow(
			/not aligned/,
		);
		expect(soc_wb.slaves.find((s) => s.name === "smoke")?.window).toBe(
			"region",
		);
		expect(soc_wb.slaves.find((s) => s.name === "smoke")?.size).toBeDefined();
		expect(() => SlaveRegfile(smoke, 0, { size: Size(4) })).toThrow(/smaller/);
		const twice = Bus("two_sha", "multi-hang", {
			masters: [Master("cpu", "CPU")],
			slaves: [
				SlaveRegfile(sha256, 0x0, { id: "sha256_0" }),
				SlaveRegfile(sha256, 0x40, { id: "sha256_1" }),
			],
		});
		expect(twice.slaves.map((s) => s.name)).toEqual(["sha256_0", "sha256_1"]);
	});

	test("broadcast and broadcastBy are mutually exclusive", () => {
		expect(() =>
			SlaveRegion("both", "source and subscriber", 0, Size(0x100), {
				broadcast: "all",
				broadcastBy: ["all"],
			}),
		).toThrow(/both broadcast and broadcastBy/);
		expect(() =>
			SlaveRegfile(smoke, 0, {
				id: "both",
				broadcast: "all",
				broadcastBy: ["all"],
			}),
		).toThrow(/both broadcast and broadcastBy/);
	});

	test("broadcast subscribers must share pipe depth", () => {
		expect(() =>
			Bus("skew", "unequal pipes", {
				masters: [Master("cfg", "cfg")],
				slaves: [
					SlaveRegion("a", "a", 0x000, Size(0x100), { broadcastBy: ["all"] }),
					SlaveRegion("b", "b", 0x100, Size(0x100), {
						pipe: 1,
						broadcastBy: ["all"],
					}),
					SlaveRegion("bcast", "bcast", 0x200, Size(0x100), {
						broadcast: "all",
					}),
				],
			}),
		).toThrow(/share pipe depth/);
	});

	test("Bus checks region overlap; raw Slave(mask) is unchecked", () => {
		expect(() =>
			Bus("hit", "overlap", {
				slaves: [
					SlaveRegion("hi", "64K", 0, Size(0x1_0000)),
					SlaveRegion("lo", "inside", 0x1000, Size(0x100)),
				],
			}),
		).toThrow(/overlaps/);
		expect(() =>
			Bus("rfhit", "regfile vs region", {
				slaves: [
					SlaveRegfile(smoke, 0x0300_6000),
					SlaveRegion("alias", "same win", 0x0300_6000, Size(0x40)),
				],
			}),
		).toThrow(/overlaps/);
		expect(() =>
			Bus("rawok", "raw vs region", {
				slaves: [
					Slave("raw", "unchecked", 0, 0xffff_0000),
					SlaveRegion("sram", "64K", 0, Size(0x1_0000)),
				],
			}),
		).not.toThrow();
		expect(() =>
			Bus("raw2", "two raw", {
				slaves: [
					Slave("a", "A", 0, 0xffff_0000),
					Slave("b", "B", 0, 0xffff_0000),
				],
			}),
		).not.toThrow();
	});

	test("wrapper and software map cover attached hangs", () => {
		const wrap = emitBusSystemSv(soc_wb);
		expect(wrap).toContain("module soc_wb_system");
		expect(wrap).toContain("soc_wb_interconnect u_ic");
		expect(wrap).toContain("wb_jtag_tdr #(.AW(32)) u_dbg_jtag");
		expect(wrap).toContain("u_dbg_cdc");
		expect(wrap).toContain("smoke_regfile u_smoke");
		expect(wrap).not.toContain("sha256_regfile");
		expect(wrap).toMatch(/\.rg_rb_grant_en\s+\(rg_rb_grant_en\)/);
		expect(wrap).not.toContain("sram_regfile");
		const ch = emitBusSystemSv(sd_sha);
		expect(ch).toContain("module sd_sha_system");
		expect(ch).toContain("sd_sha_interconnect u_ic");
		expect(ch).toContain("sha256_regfile u_sha256");
		expect(ch).toContain(".sha256_i_wb_cyc(sha256_i_wb_cyc)");
		expect(ch).toMatch(/\.rg_soft_reset\s+\(rg_soft_reset\)/);
		expect(ch).toContain("i_wb_cyc");
		expect(ch).not.toMatch(/^\s*(input|output).*uplink_o_wb_cyc/m);
		expect(ch).not.toMatch(/^\s*(input|output).*sha256_i_wb_cyc/m);
		const map = emitBusMapC(soc_wb);
		expect(map).toContain("#define SOC_WB_CH0_BANK0_SHA256_BASE 0x03000040u");
		expect(map).toContain("#define SOC_WB_CH0_BANK1_SHA256_BASE 0x43000040u");
		expect(map).toContain("#define SOC_WB_SMOKE_BANK0_BASE 0x03006000u");
		expect(map).toContain("#define SOC_WB_SMOKE_FABRIC_OFFSET 0x00000030u");
		expect(map).toContain("shadow bank");
		expect(map).toContain('#include "sha256.h"');
		const uvm = emitBusMapUvm(soc_wb);
		expect(uvm).toContain("class ral_block_soc_wb");
		expect(uvm).toContain('`include "ral_SHA256.sv"');
		expect(uvm).toContain("default_map.add_submap(this.ch0_bank0.default_map");
		expect(uvm).toContain("32'h03000000");
		expect(uvm).toContain("32'h03006000");
		const ralf = emitBusRalf(soc_wb);
		expect(ralf).toContain("block sd_sha ch0_bank0 @0x3000000;");
		expect(ralf).toContain("block sd_sha ch1_bank0 @0x3001000;");
		expect(ralf).toContain("block sd_sha {");
		expect(ralf.match(/^block sd_sha \{$/gm)?.length).toBe(1);
	});

	test("SlaveBus is Region sugar; one child RTL, N hangs; needs uplink", () => {
		expect(soc_wb.slaves.find((s) => s.name === "ch0")?.bus?.name).toBe(
			"sd_sha",
		);
		expect(soc_wb.slaves.find((s) => s.name === "ch1")?.bus?.name).toBe(
			"sd_sha",
		);
		expect(soc_wb.slaves.find((s) => s.name === "ch0")?.uplink).toBe(
			UPLINK_MASTER,
		);
		expect(soc_wb.slaves.find((s) => s.name === "ch0")?.window).toBe("region");
		expect(() =>
			SlaveBus(
				Bus("noup", "no uplink", {
					masters: [Master("cpu", "CPU")],
					slaves: [SlaveRegion("s0", "s", 0, Size(16))],
				}),
				0,
			),
		).toThrow(/uplink/);
		expect(() =>
			SlaveBus(sd_sha, 0x0300_0000, { id: "tiny", size: Size(16) }),
		).toThrow(/smaller/);
		const child = Bus("leafb", "decoder child", {
			masters: [Master(UPLINK_MASTER, "cascade")],
			slaves: [SlaveRegion("csr", "csr", 0, Size(16))],
		});
		const parent = Bus("par", "cascade", {
			masters: [Master("cpu", "CPU")],
			slaves: [
				SlaveBus(child, 0x1000, { id: "a", size: Size(0x100) }),
				SlaveBus(child, 0x2000, { id: "b", size: Size(0x100) }),
			],
		});
		expect(parent.slaves.map((s) => s.name)).toEqual(["a", "b"]);
		expect(busModuleKind(parent)).toBe("decoder");
		expect(busModuleKind(child)).toBe("decoder");
		const wrap = emitBusSystemSv(child);
		expect(wrap).toContain("i_wb_cyc");
		expect(wrap).toMatch(/\.m_cyc_i\s+\(i_wb_cyc\)/);
		expect(wrap).not.toMatch(/^\s*(input|output).*m_adr_i/m);
	});
});
