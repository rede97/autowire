import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Bus,
	Crossbar,
	Master,
	MasterGroup,
	masterGroupOf,
	Size,
	Slave,
	SlaveBus,
	SlaveGroup,
	SlaveRegion,
	slaveGroupOf,
} from "../src/plugins/wishbone-bus/dsl.ts";
import {
	busModuleKind,
	busModuleName,
	emitBusSv,
	listFabricPorts,
} from "../src/plugins/wishbone-bus/emit.ts";
import {
	emitBusSystemSv,
	type WrapperStyle,
} from "../src/plugins/wishbone-bus/emit-attach.ts";
import { emitBusMapC } from "../src/plugins/wishbone-bus/emit-map.ts";
import { generatePipeModule } from "../src/plugins/wishbone-bus/generate.ts";
import { verilatorSim, verilatorTest } from "./fixtures/verilator.ts";

const ALIGNED: WrapperStyle = {
	portAlign: true,
	signalAlign: true,
	instPortAlign: true,
	instParamAlign: true,
	netType: "logic",
};

/** The fixture topology of test/fixtures/wb_crossbar_tb.sv. */
function xb() {
	return Crossbar("xb", "grouped crossbar", {
		addrWidth: 16,
		masters: [
			MasterGroup("cpu", [Master("cpu_i", "ifetch"), Master("cpu_d", "data")]),
			Master("dma", "dma engine"),
		],
		slaves: [
			SlaveGroup("ctrl", [
				SlaveRegion("gpio", "gpio", 0x0000, Size(0x100)),
				SlaveRegion("uart", "uart", 0x0100, Size(0x100)),
			]),
			SlaveRegion("mem", "scratch", 0x8000, Size(0x8000), { pipe: 1 }),
		],
	});
}

describe("wishbone crossbar", () => {
	test("Crossbar flattens groups into a classic BusDef plus group metadata", () => {
		const def = xb();
		expect(def.kind).toBe("wishbone-bus");
		expect(def.masters.map((m) => m.name)).toEqual(["cpu_i", "cpu_d", "dma"]);
		expect(def.slaves.map((s) => s.name)).toEqual(["gpio", "uart", "mem"]);
		expect(def.crossbar).toEqual({
			masters: [
				{ name: "cpu", members: ["cpu_i", "cpu_d"] },
				{ name: "dma", members: ["dma"] },
			],
			slaves: [
				{ name: "ctrl", members: ["gpio", "uart"] },
				{ name: "mem", members: ["mem"] },
			],
		});
		expect(masterGroupOf(def, "cpu_d")).toBe("cpu");
		expect(slaveGroupOf(def, "uart")).toBe("ctrl");
		expect(slaveGroupOf(def, "mem")).toBe("mem");
		expect(busModuleKind(def)).toBe("crossbar");
		expect(busModuleName(def)).toBe("xb_crossbar");
		// Classic Bus() is untouched.
		const classic = Bus("cl", "classic", {
			addrWidth: 16,
			masters: [Master("a", "a"), Master("b", "b")],
			slaves: [Slave("s", "s", 0, 0xff00)],
		});
		expect(classic.crossbar).toBeUndefined();
		expect(busModuleKind(classic)).toBe("interconnect");
	});

	test("group constructors validate members and names", () => {
		expect(() => MasterGroup("g", [])).toThrow(/at least one Master/);
		expect(() => SlaveGroup("g", [])).toThrow(/at least one slave/);
		expect(() =>
			MasterGroup("g", [Slave("s", "s", 0, 0xff00) as never]),
		).toThrow(/must be Master/);
		expect(() => SlaveGroup("g", [Master("m", "m") as never])).toThrow(
			/must be Slave/,
		);
		expect(() => MasterGroup("bad name", [Master("m", "m")])).toThrow();
		const slaves = [Slave("s", "s", 0, 0xff00)];
		expect(() =>
			Crossbar("x", "x", {
				addrWidth: 16,
				masters: [
					MasterGroup("g", [Master("a", "a")]),
					MasterGroup("g", [Master("b", "b")]),
				],
				slaves,
			}),
		).toThrow(/duplicate master group "g"/);
		expect(() =>
			Crossbar("x", "x", {
				addrWidth: 16,
				masters: [Master("a", "a")],
				slaves: [
					SlaveGroup("s", [Slave("s1", "s", 0, 0xff00)]),
					Slave("s", "s", 0x100, 0xff00),
				],
			}),
		).toThrow(/duplicate slave group "s"/);
		expect(() =>
			Crossbar("x", "x", { addrWidth: 16, masters: [], slaves }),
		).toThrow(/at least one master/);
		// Classic checks still run on the flattened lists.
		expect(() =>
			Crossbar("x", "x", {
				addrWidth: 16,
				masters: [MasterGroup("g", [Master("a", "a"), Master("a", "a")])],
				slaves,
			}),
		).toThrow(/duplicate master/);
		expect(() =>
			Crossbar("x", "x", {
				addrWidth: 16,
				masters: [Master("a", "a")],
				slaves: [
					SlaveGroup("g1", [SlaveRegion("s1", "s", 0, Size(0x100))]),
					SlaveGroup("g2", [SlaveRegion("s2", "s", 0x80, Size(0x80))]),
				],
			}),
		).toThrow(/overlap/);
	});

	test("a broadcast window and its subscribers must share one slave group", () => {
		const good = Crossbar("bc", "broadcast inside a group", {
			addrWidth: 16,
			masters: [Master("m", "m")],
			slaves: [
				SlaveGroup("g", [
					SlaveRegion("a", "a", 0x000, Size(0x100), { broadcastBy: ["all"] }),
					SlaveRegion("b", "b", 0x100, Size(0x100), { broadcastBy: ["all"] }),
					SlaveRegion("win", "win", 0x200, Size(0x100), { broadcast: "all" }),
				]),
				SlaveRegion("other", "other", 0x1000, Size(0x100)),
			],
		});
		const sv = emitBusSv(good);
		expect(sv).toContain("logic broadcast_all;");
		expect(sv).toContain("(broadcast_all & a_o_wb_ack & b_o_wb_ack)");
		expect(() =>
			Crossbar("bc", "broadcast across groups", {
				addrWidth: 16,
				masters: [Master("m", "m")],
				slaves: [
					SlaveGroup("g1", [
						SlaveRegion("a", "a", 0x000, Size(0x100), { broadcastBy: ["all"] }),
						SlaveRegion("win", "win", 0x200, Size(0x100), { broadcast: "all" }),
					]),
					SlaveRegion("b", "b", 0x100, Size(0x100), { broadcastBy: ["all"] }),
				],
			}),
		).toThrow(/cannot cross slave groups/);
	});

	test("emitted crossbar: per-group arbiters, target decode, parallel paths", () => {
		const def = xb();
		const sv = emitBusSv(def);
		expect(sv).toContain("module xb_crossbar (");
		expect(sv).toContain("input  logic        rb_grant_en,");
		expect(sv).toContain("//  Crossbar: 2 master group(s) x 2 slave group(s)");
		// Slave-group slots and master-side target decode.
		expect(sv).toContain("localparam int unsigned SG_CTRL = 0;");
		expect(sv).toContain("localparam int unsigned SG_MEM  = 1;");
		expect(sv).toContain("mg_cpu_tgt      = 2'd1 << SG_MEM;");
		expect(sv).toContain("mg_dma_tgt      = 2'd1 << SG_CTRL;");
		// Multi-master group has an arbiter; a singleton does not.
		expect(sv).toContain("logic [1:0] mg_cpu_grant;");
		expect(sv).toContain(
			"assign mg_cpu_m_cyc = {cpu_d_o_wb_cyc, cpu_i_o_wb_cyc};",
		);
		expect(sv).not.toContain("mg_dma_grant");
		expect(sv).toContain("assign mg_dma_cyc   = dma_o_wb_cyc;");
		// Each slave group arbitrates among master groups and decodes its own slots.
		expect(sv).toContain(
			"assign sg_ctrl_req   = {mg_dma_cyc & mg_dma_tgt[SG_CTRL], mg_cpu_cyc & mg_cpu_tgt[SG_CTRL]};",
		);
		expect(sv).toContain("logic [1:0] sg_mem_grant;");
		expect(sv).toContain("logic [1:0] sg_ctrl_slot_sel;");
		expect(sv).toContain("logic [0:0] sg_mem_slot_sel;");
		expect(sv).toContain(
			"assign gpio_i_wb_cyc = sg_ctrl_slot_sel[SLOT_GPIO] & sg_ctrl_cyc;",
		);
		expect(sv).toContain(
			"wb_cfg_pipe #(.PIPE(1), .AW(16), .TW(0)) u_mem_pipe (",
		);
		expect(sv).toContain(".m_cyc(sg_mem_slot_sel[SLOT_MEM] & sg_mem_cyc)");
		// Responses: slave group -> master group -> granted member; unmapped ACKs at the group.
		expect(sv).toContain(
			"assign mg_cpu_rsp_ack = (mg_cpu_unmapped & mg_cpu_stb)",
		);
		expect(sv).toContain("| (sg_mem_gsel[0] & sg_mem_rsp_ack);");
		expect(sv).toContain(
			"assign cpu_d_i_wb_ack = mg_cpu_gsel[1] & mg_cpu_rsp_ack;",
		);
		expect(sv).toContain("assign dma_i_wb_ack   = mg_dma_rsp_ack;");
		// No global slot_sel / g_* nets: nothing is shared between slave groups.
		expect(sv).not.toMatch(/\bslot_sel\b/);
		expect(sv).not.toMatch(/\bg_adr\b/);
	});

	test("ports match the interconnect shape; wrapper and software map keep working", () => {
		const def = xb();
		const ports = listFabricPorts(def).map((p) => p.name);
		expect(ports.slice(0, 3)).toEqual(["clk", "rst_n", "rb_grant_en"]);
		expect(ports).toContain("cpu_i_o_wb_adr");
		expect(ports).toContain("mem_o_wb_ack");
		expect(ports).not.toContain("m_adr_i");
		// No leaves, cascade or bridges: no wrapper, same as a plain interconnect.
		expect(emitBusSystemSv(def, ALIGNED)).toBeNull();
		expect(emitBusMapC(def)).toContain("#define XB_MAP_H");
		// A bridged master inside a group gets the usual Type-A wrapper.
		const bridged = Crossbar("wx", "wrapped crossbar", {
			addrWidth: 16,
			masters: [
				MasterGroup("cpu", [
					Master("cpu_i", "ifetch"),
					Master("host", "APB", { apb: true }),
				]),
				Master("dma", "dma engine"),
			],
			slaves: [
				SlaveGroup("ctrl", [SlaveRegion("gpio", "gpio", 0x0000, Size(0x100))]),
				SlaveRegion("mem", "scratch", 0x8000, Size(0x8000)),
			],
		});
		const sys = emitBusSystemSv(bridged, ALIGNED) ?? "";
		expect(sys).toContain("module wx_bus_cfg (");
		expect(sys).toContain("wx_crossbar u_crossbar (");
		expect(sys).toMatch(/\.cpu_i_o_wb_adr\s*\(\s*cpu_i_o_wb_adr\s*\)/);
		expect(sys).toMatch(/\.host_o_wb_adr\s*\(\s*host_fab_adr\s*\)/);
		expect(sys).toMatch(/\.rb_grant_en\s*\(\s*rb_grant_en\s*\)/);
	});

	test("piped masters inside a group and inherited tags unpack m<i>_tga_q", () => {
		const child = Bus("leaf", "child", {
			addrWidth: 8,
			masters: [Master("up", "uplink")],
			slaves: [Slave("r", "r", 0, 0xf0, 2)],
			tagWidth: 2,
		});
		const def = Crossbar("tx", "tagged crossbar", {
			addrWidth: 16,
			tagWidth: 2,
			masters: [
				MasterGroup("g", [
					Master("fast", "piped", { pipe: 1 }),
					Master("slow", "combo"),
				]),
			],
			slaves: [
				SlaveGroup("a", [
					SlaveBus(child.uplink(), 0x0000, { size: Size(0x100) }),
				]),
				SlaveGroup("b", [Slave("raw", "raw", 0x1000, 0xff00, 2)]),
			],
		});
		const sv = emitBusSv(def);
		expect(sv).toContain(
			"wb_cfg_pipe #(.PIPE(1), .AW(16), .TW(2)) u_fast_mpipe (",
		);
		expect(sv).toContain("({2{mg_g_gsel[0]}} & m0_tga_q[1:0])");
		expect(sv).toContain("({2{mg_g_gsel[1]}} & slow_o_wb_tga_tag)");
		expect(sv).toContain("assign mg_g_tga_tag = mg_g_up_tag;");
		expect(sv).toContain(
			"assign sg_b_tga_tag = ({2{sg_b_gsel[0]}} & mg_g_tga_tag);",
		);
		expect(sv).toContain("assign raw_i_wb_tga_tag = sg_b_tga_tag;");
		expect(sv).toContain(
			"assign m0_rdat_q = {32{mg_g_gsel[0]}} & mg_g_rsp_dat;",
		);
	});

	test("interconnect with piped masters muxes inherited tags from m<i>_tga_q", () => {
		const def = Bus("ic", "piped interconnect", {
			addrWidth: 16,
			tagWidth: 2,
			masters: [Master("fast", "piped", { pipe: 1 }), Master("slow", "combo")],
			slaves: [Slave("raw", "raw", 0x1000, 0xff00, 2)],
		});
		const sv = emitBusSv(def);
		expect(sv).toContain("({2{gsel[0]}} & m0_tga_q[1:0])");
		expect(sv).not.toContain("m0_tga_tag_q");
	});

	verilatorTest(
		"verilator: parallel groups, in-group exclusion, mixed burst",
		async () => {
			const def = xb();
			const dir = mkdtempSync(join(tmpdir(), "aw-xb-"));
			const fabric = join(dir, `${busModuleName(def)}.sv`);
			writeFileSync(fabric, emitBusSv(def));
			const pipe = await generatePipeModule(dir);
			expect(pipe).not.toBeNull();
			const tb = join(import.meta.dir, "fixtures/wb_crossbar_tb.sv");
			const r = verilatorSim({
				dir: join(dir, "obj"),
				top: "tb",
				sources: [tb, fabric, pipe ?? ""],
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
