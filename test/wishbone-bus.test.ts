import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sd_sha } from "../demo/soc/sot/wb_bus_sd_sha.ts";
import { soc_wb } from "../demo/soc/sot/wb_bus_soc.ts";
import { sha256 } from "../demo/soc/sot/wb_reg_sha256.ts";
import { smoke } from "../demo/soc/sot/wb_reg_smoke.ts";
import { generateAll } from "../src/plugins/wishbone/generate.ts";
import {
	Bus,
	Crossbar,
	Master,
	Size,
	Slave,
	SlaveBus,
	SlaveRegfile,
	SlaveRegion,
} from "../src/plugins/wishbone-bus/dsl.ts";
import {
	busModuleKind,
	busModuleName,
	emitBusSv,
} from "../src/plugins/wishbone-bus/emit.ts";
import type { WrapperStyle } from "../src/plugins/wishbone-bus/emit-attach.ts";
import { emitBusSystemSv } from "../src/plugins/wishbone-bus/emit-attach.ts";
import {
	emitBusMapC,
	emitBusMapPkg,
	emitBusMapUvm,
} from "../src/plugins/wishbone-bus/emit-map.ts";
import { ShadowDomain } from "../src/plugins/wishbone-regfile/dsl.ts";
import { loadWorkspace } from "../src/workspace.ts";
import { smoke_rw } from "./fixtures/wb_reg_access.ts";

const ALIGNED: WrapperStyle = {
	portAlign: true,
	signalAlign: true,
	instPortAlign: true,
	instParamAlign: true,
	netType: "logic",
};

describe("wishbone-bus", () => {
	test("single master degenerates to decoder", () => {
		const def = Bus("demo", "one master", {
			addrWidth: 32,
			masters: [Master("cpu", "CPU")],
			slaves: [Slave("csr", "regs", 0, 0xffff_ff00)],
		});
		expect(busModuleKind(def)).toBe("decoder");
		expect(busModuleName(def)).toBe("demo_decoder");
		const sv = emitBusSv(def);
		expect(sv).toContain("module demo_decoder");
		expect(sv).toContain("cpu_o_wb_adr");
		expect(sv).toContain("cpu_i_wb_ack");
		expect(sv).toContain("csr_i_wb_cyc");
		expect(sv).toContain("csr_o_wb_ack");
		expect(sv).not.toContain("m_adr_i");
	});

	test("multi master emits interconnect with named masters and slaves", () => {
		expect(busModuleKind(sd_sha)).toBe("interconnect");
		const sv = emitBusSv(sd_sha);
		expect(sv).toContain("module sd_sha_interconnect");
		expect(sv).toContain("cfg_o_wb_cyc");
		expect(sv).toContain("eng_i_wb_ack");
		expect(sv).toContain("sha256_i_wb_cyc");
		expect(sv).toContain("sha256_o_wb_ack");
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
			existsSync(join(root, "rtl/gen/plugins/wishbone/bus", name)) ||
			existsSync(join(root, "rtl/gen/plugins/wishbone/regfile", name)) ||
			existsSync(join(root, "fw/gen/wishbone/bus", name)) ||
			existsSync(join(root, "fw/gen/wishbone/regfile", name)) ||
			existsSync(join(root, "dv/ral/bus", name)) ||
			existsSync(join(root, "dv/ral/regfile", name));
		expect(present("soc_wb_interconnect.sv")).toBe(true);
		expect(present("wb_jtag_tdr.sv")).toBe(true);
		expect(present("wb_cdc.sv")).toBe(true);
		expect(present("wb_async_fifo.sv")).toBe(true);
		expect(present("soc_wb_bus_cfg.icl")).toBe(true);
		expect(present("soc_wb_bus_cfg.sv")).toBe(true);
		expect(present("sd_sha_interconnect.sv")).toBe(true);
		expect(present("sd_sha_bus_cfg.sv")).toBe(true);
		expect(present("wb_cfg_pipe.sv")).toBe(true);
		expect(present("soc_wb_map.h")).toBe(true);
		expect(present("sd_sha_map.h")).toBe(true);
		expect(present("ral_block_soc_wb.sv")).toBe(true);
	});

	test("configured RTL dirs split regfile leaves from bus fabric", async () => {
		const dir = mkdtempSync(join(tmpdir(), "aw-rtl-dirs-"));
		mkdirSync(join(dir, "sot"), { recursive: true });
		writeFileSync(
			join(dir, "sot/wb.ts"),
			`export { smoke } from ${JSON.stringify(join(import.meta.dir, "../demo/soc/sot/wb_reg_smoke.ts"))};\nexport { sd_sha } from ${JSON.stringify(join(import.meta.dir, "../demo/soc/sot/wb_bus_sd_sha.ts"))};\n`,
		);
		writeFileSync(
			join(dir, "autowire.toml"),
			`[workspace]\nname = "split"\n[workspace.dump]\nplugins_dir = "gen/plugins"\n[wishbone.one]\nts = "sot/wb.ts"\n[plugins.wishbone]\nbus_dir = "rtl/fabric"\n`,
		);
		const ws = await loadWorkspace(join(dir, "autowire.toml"));
		const paths = (await generateAll(ws)).map((p) => p.replaceAll("\\", "/"));
		expect(
			paths.some((p) =>
				p.endsWith("gen/plugins/wishbone/regfile/smoke_regfile.sv"),
			),
		).toBe(true);
		expect(
			paths.some((p) => p.endsWith("rtl/fabric/sd_sha_interconnect.sv")),
		).toBe(true);
		expect(paths.some((p) => p.endsWith("rtl/fabric/sd_sha_bus_cfg.sv"))).toBe(
			true,
		);
		expect(paths.some((p) => p.endsWith("rtl/fabric/wb_cfg_pipe.sv"))).toBe(
			true,
		);
		expect(paths.some((p) => p.includes("gen/plugins/wishbone/bus/"))).toBe(
			false,
		);
	});

	for (const masters of [undefined, []]) {
		test(`omitted or empty masters normalize to the default named face (${masters === undefined ? "omitted" : "empty"})`, () => {
			const def = Bus("solo", "default master", {
				addrWidth: 16,
				masters,
				slaves: [SlaveRegion("csr", "CSR", 0, Size(0x100))],
			});
			expect(def.masters.map((master) => master.name)).toEqual(["m"]);
			expect(def.masters[0]?.pipe).toBe(0);
			expect(busModuleKind(def)).toBe("decoder");
			expect(SlaveBus(def, 0).uplink).toBe("m");
			for (const sv of [
				emitBusSv(def),
				emitBusSystemSv(def.uplink(), ALIGNED),
			]) {
				expect(sv).not.toBeNull();
				expect(sv).toMatch(/^\s*input\s+logic\s+\[15:0\]\s+m_o_wb_adr\b/m);
				expect(sv).toMatch(/^\s*output\s+logic\s+m_i_wb_ack\b/m);
				expect(sv).not.toMatch(
					/^\s*(?:input|output)\s+.*\b(?:m_adr_i|i_wb_adr|o_wb_ack)\b/m,
				);
			}
		});
	}

	for (const kind of ["decoder", "interconnect", "crossbar"] as const) {
		test(`${kind} cascade keeps every named public Wishbone signal`, () => {
			const cfg = Master("cfg", "cascade", { pipe: 1 });
			const csr = Bus("csr", "tagged child", {
				addrWidth: 8,
				tags: [ShadowDomain("bank", 4, 2)],
				slaves: [SlaveRegion("reg", "registers", 0, Size(0x100))],
			});
			const opts = {
				addrWidth: 16,
				tags: [ShadowDomain("bank", 4, 2)],
				masters: kind === "decoder" ? [cfg] : [Master("eng", "local"), cfg],
				slaves: [SlaveBus(csr, 0, { pipe: 1 })],
			};
			const def =
				kind === "crossbar"
					? Crossbar("named", "cascade", opts)
					: Bus("named", "cascade", opts);
			const selected = def.uplink("cfg");
			expect(SlaveBus(selected, 0).uplink).toBe("cfg");
			for (const sv of [
				emitBusSv(selected),
				emitBusSystemSv(selected, ALIGNED),
			]) {
				expect(sv).not.toBeNull();
				for (const signal of [
					"adr",
					"dat",
					"sel",
					"cyc",
					"stb",
					"we",
					"tga_bank",
				]) {
					expect(sv).toMatch(
						new RegExp(
							`^\\s*input\\s+logic\\s+(?:\\[[^\\]]+\\]\\s+)?cfg_o_wb_${signal}\\b`,
							"m",
						),
					);
					expect(sv).toMatch(
						new RegExp(
							`^\\s*output\\s+logic\\s+(?:\\[[^\\]]+\\]\\s+)?csr_i_wb_${signal}\\b`,
							"m",
						),
					);
				}
				for (const signal of ["dat", "ack"]) {
					expect(sv).toMatch(
						new RegExp(
							`^\\s*output\\s+logic\\s+(?:\\[[^\\]]+\\]\\s+)?cfg_i_wb_${signal}\\b`,
							"m",
						),
					);
					expect(sv).toMatch(
						new RegExp(
							`^\\s*input\\s+logic\\s+(?:\\[[^\\]]+\\]\\s+)?csr_o_wb_${signal}\\b`,
							"m",
						),
					);
				}
				expect(sv).not.toMatch(
					/^\s*(?:input|output)\s+.*\b(?:m_adr_i|[io]_wb_\w+)\b/m,
				);
				if (kind !== "decoder") {
					expect(sv).toMatch(/^\s*input\s+logic\s+\[15:0\]\s+eng_o_wb_adr\b/m);
					expect(sv).toMatch(/^\s*output\s+logic\s+eng_i_wb_ack\b/m);
				}
			}
		});
	}

	test("TGA decoder exposes inherited tags at both faces", () => {
		const def = Bus("tgad", "tag decoder", {
			addrWidth: 32,
			masters: [Master("cpu", "CPU")],
			slaves: [Slave("s0", "tagged", 0, 0xffff_ff00, 2)],
		});
		expect(def.tag_width).toBe(2);
		const sv = emitBusSv(def);
		expect(sv).toContain("cpu_o_wb_tga_tag");
		expect(sv).toContain("s0_i_wb_tga_tag");
	});

	test("TGA interconnect uses named master ports", () => {
		const def = Bus("tgai", "tag interconnect", {
			addrWidth: 32,
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
		expect(sv).not.toContain("s0_i_wb_tga_tag");
	});

	test("tag-free bus emits no tga anywhere", () => {
		const def = Bus("plain", "no tags", {
			addrWidth: 32,
			masters: [Master("m0", "M0"), Master("m1", "M1")],
			slaves: [Slave("s0", "S0", 0, 0xffff_ff00)],
		});
		expect(def.tag_width).toBe(0);
		expect(emitBusSv(def)).not.toContain("tga");
	});

	test("addrWidth 16 sets the public address port width", () => {
		const def = Bus("narrow", "16-bit address", {
			masters: [Master("cpu", "CPU")],
			slaves: [Slave("s0", "S0", 0x100, 0xff00)],
			addrWidth: 16,
		});
		const sv = emitBusSv(def);
		expect(sv).toContain("[15:0] cpu_o_wb_adr");
	});

	test("demo interconnect exposes produced tags only on tagged slave faces", () => {
		const sv = emitBusSv(soc_wb);
		expect(soc_wb.tag_width).toBe(2);
		expect(sv).not.toContain("bank_tag_i");
		expect(sv).not.toContain("cpu_o_wb_tga");
		expect(sv).not.toContain("dbg_o_wb_tga");
		expect(sv).toMatch(/^\s*output\s+logic\s+\[1:0\]\s+ch0_i_wb_tga_bank\b/m);
		expect(sv).not.toContain("sram_i_wb_tga_bank");
	});

	test("demo SoC slaves use mixed PIPE depths", () => {
		const depths = soc_wb.slaves.map((s) => s.pipe);
		expect(new Set(depths).size).toBeGreaterThan(2);
		expect(soc_wb.slaves.find((s) => s.name === "flash_cfg")?.pipe).toBe(0);
		expect(soc_wb.slaves.find((s) => s.name === "ch0")?.pipe).toBe(2);
		expect(soc_wb.slaves.find((s) => s.name === "ch1")?.pipe).toBe(4);
		expect(soc_wb.slaves.find((s) => s.name === "smoke")?.pipe).toBe(3);
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

	test("generateAll writes plugins_dir", async () => {
		const dir = mkdtempSync(join(tmpdir(), "aw_bus_"));
		const ts = join(dir, "bus.ts");
		writeFileSync(
			ts,
			`
import { Bus, Master, Slave } from ${JSON.stringify(join(import.meta.dir, "../src/plugins/wishbone-bus/dsl.ts"))};
export const tiny = Bus("tiny", "t", {
  addrWidth: 32,
  masters: [Master("m", "m")],
  slaves: [Slave("s0", "s", 0, 0xfffffffc)],
});
`,
		);
		writeFileSync(
			join(dir, "autowire.toml"),
			`
[workspace]
name = "test"
[workspace.dump]
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
		expect(sd_sha.slaves.find((s) => s.name === "sha256")?.mask).toBe(0xfc0);
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
			addrWidth: 32,
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
				addrWidth: 32,
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

	test("Bus rejects unsatisfiable, holey, wide, and overlapping windows", () => {
		expect(() =>
			Bus("hit", "overlap", {
				addrWidth: 32,
				slaves: [
					SlaveRegion("hi", "64K", 0, Size(0x1_0000)),
					SlaveRegion("lo", "inside", 0x1000, Size(0x100)),
				],
			}),
		).toThrow(/overlaps/);
		expect(() =>
			Bus("rfhit", "regfile vs region", {
				addrWidth: 32,
				slaves: [
					SlaveRegfile(smoke, 0x0300_6000),
					SlaveRegion("alias", "same win", 0x0300_6000, Size(0x40)),
				],
			}),
		).toThrow(/overlaps/);
		expect(() =>
			Bus("rawok", "raw vs region", {
				addrWidth: 32,
				slaves: [
					Slave("raw", "same window", 0, 0xffff_0000),
					SlaveRegion("sram", "64K", 0, Size(0x1_0000)),
				],
			}),
		).toThrow(/overlaps/);
		expect(() =>
			Bus("raw2", "two raw", {
				addrWidth: 32,
				slaves: [
					Slave("a", "A", 0, 0xffff_0000),
					Slave("b", "B", 0, 0xffff_0000),
				],
			}),
		).toThrow(/overlaps/);
		expect(() =>
			Bus("dead", "unaligned raw", {
				addrWidth: 32,
				slaves: [Slave("uart", "u", 0x0200_0004, 0xffff_fff8)],
			}),
		).toThrow(/can never match/);
		expect(() =>
			Bus("hole", "holey mask", {
				addrWidth: 32,
				slaves: [Slave("s", "s", 0, 0xffff_00ff)],
			}),
		).toThrow(/holes/);
		expect(() =>
			Bus("wide", "addr past 32", {
				addrWidth: 40,
				slaves: [Slave("s", "s", 0, 0xffff_0000)],
			}),
		).toThrow(/2\.\.32/);
		expect(() =>
			Bus("bcastonly", "broadcast has no data port", {
				addrWidth: 16,
				slaves: [
					SlaveRegion("all", "all", 0, Size(0x100), { broadcast: "all" }),
				],
			}),
		).toThrow(/no data slave/);
		expect(() =>
			Bus("adj", "adjacent raw windows", {
				addrWidth: 32,
				slaves: [
					Slave("a", "A", 0, 0xffff_0000),
					Slave("b", "B", 0x1_0000, 0xffff_0000),
				],
			}),
		).not.toThrow();
	});

	test("wrapper and software map cover attached hangs", () => {
		const wrap = emitBusSystemSv(soc_wb, ALIGNED);
		expect(wrap).toContain("module soc_wb_bus_cfg");
		const ch = emitBusSystemSv(sd_sha.uplink("cfg"), ALIGNED);
		expect(ch).toContain("module sd_sha_bus_cfg");
		expect(ch).toMatch(/^\s*input\s+logic\s+cfg_o_wb_cyc\b/m);
		expect(ch).toMatch(/^\s*input\s+logic\s+\[1:0\]\s+cfg_o_wb_tga_bank\b/m);
		expect(ch).toMatch(/^\s*output\s+logic\s+cfg_i_wb_ack\b/m);
		expect(ch).not.toMatch(/^\s*(input|output).*\b[io]_wb_\w+/m);
		expect(ch).not.toMatch(/^\s*(input|output).*sha256_i_wb_cyc/m);
		const map = emitBusMapC(soc_wb);
		expect(map).toContain("#define SOC_WB_CH0_BANK0_SHA256_BASE 0x03000040u");
		expect(map).toContain("#define SOC_WB_CH0_BANK1_SHA256_BASE 0x07000040u");
		expect(map).toContain("#define SOC_WB_SMOKE_BANK0_BASE 0x03006000u");
		expect(map).toContain("#define SOC_WB_SMOKE_FABRIC_OFFSET 0x00000030u");
		expect(map).toContain("shadow bank");
		expect(map).toContain('#include "../regfile/sha256.h"');
		const uvm = emitBusMapUvm(soc_wb);
		expect(uvm).toContain("class ral_block_soc_wb");
		expect(uvm).toContain('`include "../regfile/ral_SHA256.sv"');
		expect(uvm).toContain("default_map.add_submap(this.ch0_bank0.default_map");
		expect(uvm).toContain("32'h03000000");
		expect(uvm).toContain("32'h03006000");
		const pkg = emitBusMapPkg(soc_wb);
		expect(pkg).toContain("package soc_wb_map_pkg;");
		expect(pkg).toContain("endpackage : soc_wb_map_pkg");
		expect(pkg).toContain(
			"localparam logic [31:0] CH0_BANK0_SHA256_BASE = 32'h03000040;",
		);
		expect(pkg).toContain(
			"localparam logic [31:0] SHA256_CTRL_OFFSET = 32'h00000000;",
		);
		// Absolute = BASE + OFFSET (symbolic, not pre-summed).
		expect(pkg).toContain(
			"localparam logic [31:0] CH0_BANK1_SHA256_CTRL = CH0_BANK1_SHA256_BASE + SHA256_CTRL_OFFSET;",
		);
		expect(pkg).toContain("shadow bank");
		// Field bit/mask stays in the regfile package, not the bus map.
		expect(pkg).not.toContain("_MASK");
	});

	test("SlaveBus is Region sugar; one child RTL, N hangs; picks a cascade face", () => {
		expect(soc_wb.slaves.find((s) => s.name === "ch0")?.bus?.name).toBe(
			"sd_sha",
		);
		expect(soc_wb.slaves.find((s) => s.name === "ch1")?.bus?.name).toBe(
			"sd_sha",
		);
		expect(soc_wb.slaves.find((s) => s.name === "ch0")?.uplink).toBe("cfg");
		expect(soc_wb.slaves.find((s) => s.name === "ch0")?.window).toBe("region");
		// A multi-master child with no explicit face is ambiguous.
		expect(() =>
			SlaveBus(sd_sha, 0x0400_0000, { id: "amb", size: Size(0x1000) }),
		).toThrow(/call \.uplink\("name"\)/);
		expect(() =>
			SlaveBus(sd_sha.uplink("cfg"), 0x0300_0000, {
				id: "tiny",
				size: Size(16),
			}),
		).toThrow(/smaller/);
		// Single-master child marks implicitly.
		const child = Bus("leafb", "decoder child", {
			addrWidth: 8,
			masters: [Master("cfg", "cascade")],
			slaves: [SlaveRegion("csr", "csr", 0, Size(16))],
		});
		const parent = Bus("par", "cascade", {
			addrWidth: 16,
			masters: [Master("cpu", "CPU")],
			slaves: [
				SlaveBus(child, 0x1000, { id: "a", size: Size(0x100) }),
				SlaveBus(child, 0x2000, { id: "b", size: Size(0x100) }),
			],
		});
		expect(parent.slaves.map((s) => s.name)).toEqual(["a", "b"]);
		expect(busModuleKind(parent)).toBe("decoder");
		expect(busModuleKind(child)).toBe("decoder");
		const wrap = emitBusSystemSv(child.uplink(), ALIGNED);
		expect(wrap).toMatch(/^\s*input\s+.*\bcfg_o_wb_cyc\b/m);
		expect(wrap).not.toMatch(/^\s*(input|output).*\bi_wb_adr\b/m);
		expect(wrap).not.toMatch(/^\s*(input|output).*m_adr_i/m);
		const wide = Bus("wide_child", "wider than the window it is hung in", {
			addrWidth: 16,
			masters: [Master("cfg", "cascade")],
			slaves: [SlaveRegion("csr", "csr", 0, Size(16))],
		});
		expect(() =>
			Bus("narrow_parent", "4 KiB windows", {
				addrWidth: 32,
				masters: [Master("cpu", "CPU")],
				slaves: [SlaveBus(wide, 0, { size: Size(0x1000) })],
			}),
		).toThrow(/forwards 12 address bits/);
	});

	test("no cascade face: wrapper keeps the named decoder master", () => {
		// A decoder with an attached regfile but no .uplink() is a top fabric:
		// the wrapper keeps the same named master ports as the fabric instance.
		const leaf = Bus("cfgbus", "decoder + attached regfile, no cascade", {
			addrWidth: 16,
			masters: [Master("cfg", "config")],
			slaves: [SlaveRegfile(sha256, 0x0)],
		});
		const sv = emitBusSystemSv(leaf, ALIGNED) ?? "";
		expect(sv).toMatch(/^\tinput\s+logic\s+\[15:0\]\s*cfg_o_wb_adr,/m);
		expect(sv).not.toMatch(/^\s*(input|output).*\bi_wb_adr\b/m);
	});

	test("attached regfile ADR: slice a wider fabric, zero-fill a narrower one, reject aliasing windows", () => {
		// Fabric ADR is window-relative (adr & ~mask), so the bits dropped or
		// filled are always 0; a window wider than the leaf ADR would alias.
		const wide = Bus("wide_fab", "16-bit fabric, 8-bit leaf", {
			addrWidth: 16,
			masters: [Master("cfg", "config")],
			slaves: [SlaveRegfile(smoke_rw, 0x100)],
		});
		expect(emitBusSystemSv(wide, ALIGNED) ?? "").toMatch(
			/\.smoke_rw_i_wb_adr\s*\(\s*smoke_rw_i_wb_adr\[7:0\]\s*\)/,
		);
		const narrow = Bus("narrow_fab", "12-bit fabric, 32-bit leaf", {
			addrWidth: 12,
			masters: [Master("cfg", "config")],
			slaves: [SlaveRegfile(sha256, 0x40)],
		});
		expect(emitBusSystemSv(narrow, ALIGNED) ?? "").toMatch(
			/\.sha256_i_wb_adr\s*\(\s*\{20'd0, sha256_i_wb_adr\}\s*\)/,
		);
		Bus("fits", "256 B window = 8 forwarded bits", {
			addrWidth: 16,
			masters: [Master("cfg", "config")],
			slaves: [SlaveRegfile(smoke_rw, 0x100, { size: Size(0x100) })],
		});
		expect(() =>
			Bus("alias", "512 B window into an 8-bit leaf", {
				addrWidth: 16,
				masters: [Master("cfg", "config")],
				slaves: [SlaveRegfile(smoke_rw, 0x200, { size: Size(0x200) })],
			}),
		).toThrow(
			/forwards 9 address bits into "smoke_rw", but regfile "smoke_rw" addrWidth is 8/,
		);
	});
});
