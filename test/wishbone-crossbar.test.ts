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

	test("rejects normalized identifiers in their emitted scope", () => {
		const masters = [Master("m", "m")];
		const lower = SlaveRegion("gpio", "lowercase", 0, Size(0x100));
		const upper = SlaveRegion("GPIO", "uppercase", 0x100, Size(0x100));
		const slaves = [lower, upper];
		for (const ms of [masters, [...masters, Master("n", "n")]]) {
			expect(() =>
				Bus("b", "slot collision", { addrWidth: 16, masters: ms, slaves }),
			).toThrow(/collide as SLOT_GPIO/);
		}
		expect(() =>
			Crossbar("b", "slot collision", {
				addrWidth: 16,
				masters,
				slaves: [SlaveGroup("ctrl", slaves)],
			}),
		).toThrow(/collide as SLOT_GPIO/);
		expect(() =>
			Crossbar("b", "group collision", {
				addrWidth: 16,
				masters,
				slaves: [SlaveGroup("ctrl", [lower]), SlaveGroup("CTRL", [upper])],
			}),
		).toThrow(/collide as SG_CTRL/);
		// SLOT constants in separate generate scopes do not collide.
		const scoped = Crossbar("b", "separate slots", {
			addrWidth: 16,
			masters,
			slaves: [SlaveGroup("left", [lower]), SlaveGroup("right", [upper])],
		});
		expect(emitBusSv(scoped)).toContain("module b_crossbar");
	});

	test("a broadcast window and its subscribers must share one slave group", () => {
		Crossbar("bc", "broadcast inside a group", {
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
		expect(sys).toMatch(/^\s*input\s+logic\s+\[15:0\]\s+cpu_i_o_wb_adr\b/m);
		expect(sys).toMatch(/^\s*input\s+logic\s+host_psel\b/m);
		expect(sys).not.toMatch(/^\s*input\s+logic\s+\[15:0\]\s+host_o_wb_adr\b/m);
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
