import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Bus,
	isBridgedMaster,
	Master,
	Slave,
	SlaveBus,
	UPLINK_MASTER,
} from "../src/plugins/wishbone-bus/dsl.ts";
import { busModuleName, emitBusSv } from "../src/plugins/wishbone-bus/emit.ts";
import { emitBusSystemSv } from "../src/plugins/wishbone-bus/emit-attach.ts";
import {
	emitBusIcl,
	emitBusPdl,
	jtagDrWidth,
	MASTER_MODULES,
} from "../src/plugins/wishbone-bus/emit-master.ts";
import { generateMasterModules } from "../src/plugins/wishbone-bus/generate.ts";
import { verilatorSim, verilatorTest } from "./fixtures/verilator.ts";

function mb(tagWidth?: number) {
	return Bus("mb", "master bridge demo", {
		masters: [
			Master("cpu", "fabric-clock WB"),
			Master("host", "SoC APB", {
				apb: { pprot: { value: 0, mask: 0b001 } },
				cdc: true,
				timeout: 64,
			}),
			Master("dbg", "DFT JTAG", { jtag: true }),
			Master("wbx", "async WB", { cdc: true, timeout: 64 }),
		],
		slaves: [Slave("mem", "TB memory", 0x0000, 0xf000, tagWidth)],
		addrWidth: 16,
		...(tagWidth ? { tagWidth } : {}),
	});
}

describe("wishbone master bridges", () => {
	test("Master options: defaults and validation", () => {
		expect(Master("cpu", "x")).toEqual({ name: "cpu", desc: "x", pipe: 0 });
		expect(isBridgedMaster(Master("cpu", "x"))).toBe(false);
		const j = Master("dbg", "x", { jtag: true });
		expect(j).toMatchObject({ bridge: "jtag", cdc: true, idle: 16 });
		const a = Master("host", "x", { apb: true });
		expect(a).toMatchObject({ bridge: "apb", cdc: false });
		expect(isBridgedMaster(a)).toBe(true);
		expect(
			Master("host", "x", { apb: { pprot: { value: 0b010, mask: 0b010 } } })
				.pprot,
		).toEqual({ value: 0b010, mask: 0b010 });
		expect(() => Master("m", "x", { apb: true, jtag: true })).toThrow(
			/both apb and jtag/,
		);
		expect(() => Master("m", "x", { jtag: true, cdc: false })).toThrow(
			/always crosses/,
		);
		expect(() => Master("m", "x", { timeout: 8 })).toThrow(/needs cdc/);
		expect(() =>
			Master("m", "x", { apb: { pprot: { value: 0b100, mask: 0b001 } } }),
		).toThrow(/outside mask/);
		expect(() => Master("m", "x", { jtag: { idle: 0 } })).toThrow(/idle/);
	});

	test("Bus rejects duplicate masters and a bridged cascade face", () => {
		const slaves = [Slave("s", "s", 0, 0xffff0000)];
		expect(() =>
			Bus("b", "b", { masters: [Master("a", "a"), Master("a", "a")], slaves }),
		).toThrow(/duplicate master/);
		expect(() =>
			Bus("b", "b", {
				masters: [Master(UPLINK_MASTER, "u", { cdc: true })],
				slaves,
			}),
		).toThrow(/cascade face/);
		const child = Bus("child", "c", {
			masters: [Master("up2", "u", { apb: true })],
			slaves,
		});
		expect(() => SlaveBus(child, 0, { uplink: "up2" })).toThrow(/cascade face/);
	});

	test("wrapper hides bridged fabric ports and exposes native faces", () => {
		const def = mb();
		const sv = emitBusSystemSv(def) ?? "";
		expect(sv).toContain("module mb_system (");
		expect(sv).toContain("input  logic        host_pclk");
		expect(sv).toContain("output logic        host_pslverr");
		expect(sv).toContain("output logic        dbg_tdo");
		expect(sv).toContain("input  logic        dbg_en");
		expect(sv).toContain("output logic        wbx_i_wb_err");
		expect(sv).toContain("input  logic [15:0] cpu_o_wb_adr");
		expect(sv).not.toContain("input  logic [15:0] host_o_wb_adr");
		expect(sv).toContain(
			"wb_apb2wb #(.AW(16), .PPROT_MASK(3'b001), .PPROT_VAL(3'b000)) u_host_apb (",
		);
		expect(sv).toContain(
			"wb_cdc #(.AW(16), .TW(0), .TIMEOUT(64)) u_host_cdc (",
		);
		expect(sv).toContain("wb_jtag_tdr #(.AW(16)) u_dbg_jtag (");
		expect(sv).toContain(".s_clk  (dbg_tck),");
		expect(sv).toContain(".host_o_wb_adr(host_fab_adr),");
		expect(sv).toContain(".cpu_o_wb_adr (cpu_o_wb_adr),");
	});

	test("TGA: async WB forwards tag; bridges tie it to zero", () => {
		const sv = emitBusSystemSv(mb(4)) ?? "";
		expect(sv).toContain("input  logic [3:0]  wbx_o_wb_tga");
		expect(sv).toMatch(/\.s_tga\s*\(wbx_o_wb_tga\)/);
		expect(sv).toMatch(/\.s_tga\s*\(4'd0\)/);
		expect(sv).toMatch(/\.m_tga\s*\(host_fab_tga\)/);
		expect(sv).toContain(".host_o_wb_tga(host_fab_tga),");
	});

	test("APB without cdc runs on fabric clk and ties ERR", () => {
		const def = Bus("one", "single apb master", {
			masters: [Master("host", "APB", { apb: true })],
			slaves: [Slave("s", "s", 0, 0xffff0000)],
		});
		const sv = emitBusSystemSv(def) ?? "";
		expect(sv).not.toContain("host_pclk");
		expect(sv).not.toContain("wb_cdc #(");
		expect(sv).toContain(".pclk   (clk),");
		expect(sv).toContain(".wb_err (1'b0),");
		expect(sv).toMatch(/\.m_adr_i\s*\(host_fab_adr\),/);
	});

	test("ICL / PDL for JTAG masters only", () => {
		const def = mb();
		const icl = emitBusIcl(def) ?? "";
		expect(jtagDrWidth(def)).toBe(50);
		expect(icl).toContain("Module mb_system {");
		expect(icl).toContain("ScanInterface dbg {");
		expect(icl).toContain("ScanRegister dbg_dr[49:0] {");
		expect(icl).not.toContain("host_");
		const pdl = emitBusPdl(def) ?? "";
		expect(pdl).toContain("iProcsForModule mb_system");
		expect(pdl).toContain("iRunLoop 16 -tck");
		const plain = Bus("p", "p", {
			masters: [Master("host", "APB", { apb: true, cdc: true })],
			slaves: [Slave("s", "s", 0, 0xffff0000)],
		});
		expect(emitBusIcl(plain)).toBeNull();
		expect(emitBusPdl(plain)).toBeNull();
	});

	verilatorTest(
		"verilator: APB / JTAG / async WB masters through wb_cdc",
		async () => {
			const def = mb();
			const dir = mkdtempSync(join(tmpdir(), "aw-wbm-"));
			const fabric = join(dir, `${busModuleName(def)}.sv`);
			const system = join(dir, "mb_system.sv");
			writeFileSync(fabric, emitBusSv(def));
			writeFileSync(system, emitBusSystemSv(def) ?? "");
			const mods = await generateMasterModules(dir);
			expect(mods.length).toBe(MASTER_MODULES.length);
			const tb = join(import.meta.dir, "fixtures/wb_master_tb.sv");
			const r = verilatorSim({
				dir: join(dir, "obj"),
				top: "tb",
				sources: [tb, system, fabric, ...mods],
			});
			expect(r.buildLog).not.toContain("%Error");
			expect(r.buildOk).toBe(true);
			expect(r.stdout).not.toContain("FAIL");
			expect(r.stdout).toContain("PASS");
			expect(r.exitCode).toBe(0);
		},
		180_000,
	);
});
