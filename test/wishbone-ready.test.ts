import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus, Master, SlaveRegfile } from "../src/plugins/wishbone-bus/dsl.ts";
import { emitBusSv } from "../src/plugins/wishbone-bus/emit.ts";
import { emitBusSystemSv } from "../src/plugins/wishbone-bus/emit-attach.ts";
import {
	Access,
	Block,
	BlockDefault,
	Cell,
	CellDefault,
	Field,
	Regfile,
	RegfileDefault,
	Shadow,
} from "../src/plugins/wishbone-regfile/dsl.ts";
import {
	collectPorts,
	emitRegfileSv,
} from "../src/plugins/wishbone-regfile/emit.ts";
import { layoutRegfile } from "../src/plugins/wishbone-regfile/layout.ts";
import { verilatorSim, verilatorTest } from "./fixtures/verilator.ts";

const leaf = Regfile(
	"ready_case",
	"Cell acceptance smoke",
	RegfileDefault.addrWidth(8).readWriteBlock(true),
	[
		Cell("CTRL", "Mixed storage", CellDefault.ready("ctrl_rdy"), [
			Field("capture", Access.RWW, 8, "Hardware capture").reset(0),
			Field("sticky", Access.W1C, 8, "Sticky events").reset(0),
			Field("go", Access.W1P, 1, "Command pulse"),
			Field("value", Access.RW, 8, "Software value").offset(24).reset(0),
		]),
		Cell(
			"WINDOW",
			"External window and storage",
			CellDefault.ready("window_rdy"),
			[
				Field("data", Access.RWE, 8, "External FIFO"),
				Field("companion", Access.RW, 8, "Atomic companion").reset(0),
			],
		),
		Cell("STATUS", "Ready-gated status", CellDefault.ready("ctrl_rdy"), [
			Field("status", Access.RO, 8, "Live status"),
		]),
		Cell("PAIR", "Two external windows", CellDefault.ready("window_rdy"), [
			Field("left", Access.RWE, 8, "Left FIFO"),
			Field("right", Access.RWE, 8, "Right FIFO"),
			Field("pair_value", Access.RW, 8, "Pair companion"),
		]),
		Cell("FREE", "Ungated constant", CellDefault, [
			Field("id", Access.RC, 8, "Identity").reset(0x42),
		]),
	],
);

describe("cell transaction ready", () => {
	test("cell overrides remain independent and builder chains preserve ready", () => {
		const opts = CellDefault.ready("access_rdy")
			.align(8)
			.offset(4)
			.resetDomain("rst_n");
		const def = Regfile(
			"layout_ready",
			"Cell-only permissions",
			RegfileDefault.addrWidth(8),
			[
				Block("group", "No ready default", BlockDefault, [
					Cell("gated", "Gated", opts, [Field("a", Access.RW, 1, "A")]),
					Cell("free", "Ungated", CellDefault, [Field("b", Access.RW, 1, "B")]),
				]),
			],
		);
		expect(layoutRegfile(def).cells.map((c) => [c.name, c.ready])).toEqual([
			["gated", "access_rdy"],
			["free", undefined],
		]);
		expect(() => CellDefault.ready("bad-name")).toThrow(/identifier/);
	});

	test("ready inputs cannot alias clock, reset, or shadow control ports", () => {
		for (const name of ["clk", "rst_n", "por_n"]) {
			const def = Regfile(
				"clash",
				"Invalid input alias",
				RegfileDefault.addrWidth(8).resetDomains("por_n"),
				[
					Cell("C", "Cell", CellDefault.ready(name).resetDomain("por_n"), [
						Field("q", Access.RW, 1, "Q"),
					]),
				],
			);
			expect(() => collectPorts(layoutRegfile(def))).toThrow();
		}
		const shadowClash = Regfile(
			"shadow_clash",
			"Shadow role collision",
			RegfileDefault.addrWidth(8).shadows(Shadow("bank", 2, "0:0")),
			[
				Cell("C", "Cell", CellDefault.ready("bank_mux_sel").shadow("bank"), [
					Field("q", Access.RW, 1, "Q"),
				]),
			],
		);
		expect(() => collectPorts(layoutRegfile(shadowClash))).toThrow(/colli/);
	});

	test("wrapper rejects ready aliases of another leaf reset domain", () => {
		const resetLeaf = Regfile(
			"reset_leaf",
			"Reset owner",
			RegfileDefault.addrWidth(8).resetDomains("ctrl_rdy"),
			[
				Cell("C", "Reset cell", CellDefault.resetDomain("ctrl_rdy"), [
					Field("reset_value", Access.RW, 1, "Value"),
				]),
			],
		);
		for (const slaves of [
			[SlaveRegfile(leaf, 0), SlaveRegfile(resetLeaf, 0x100)],
			[SlaveRegfile(resetLeaf, 0), SlaveRegfile(leaf, 0x100)],
		]) {
			const bus = Bus("collision", "Ready and reset must not merge", {
				addrWidth: 12,
				slaves,
			});
			expect(() => emitBusSystemSv(bus, { netType: "logic" })).toThrow(/colli/);
		}
	});

	for (const pipe of [0, 2]) {
		verilatorTest(
			`RTL: ${pipe ? "posted pipe retains writes" : "direct accesses wait"}, hardware updates and RWE acceptance`,
			() => {
				const dir = mkdtempSync(join(tmpdir(), "aw-cell-ready-"));
				try {
					const bus = Bus("ready_bus", "Ready integration", {
						addrWidth: 12,
						masters: [Master("cfg", "Host")],
						slaves: [
							SlaveRegfile(leaf, 0, { id: "a", pipe }),
							SlaveRegfile(leaf, 0x100, { id: "b", pipe }),
						],
					});
					const files = [
						"ready_case_regfile.sv",
						"ready_bus_decoder.sv",
						"ready_bus_bus_cfg.sv",
						"wb_cfg_pipe.sv",
						"tb.sv",
					];
					const content = [
						emitRegfileSv(layoutRegfile(leaf)),
						emitBusSv(bus),
						emitBusSystemSv(bus, { netType: "logic" }) ?? "",
						readFileSync(
							join(
								import.meta.dir,
								"../docs/plugins/rtl/wb_cfg_pipe_template.sv",
							),
							"utf8",
						),
						readFileSync(
							join(import.meta.dir, "fixtures/wb_cell_ready_tb.sv"),
							"utf8",
						).replaceAll("__PIPE__", String(pipe)),
					];
					files.forEach((f, i) => {
						writeFileSync(join(dir, f), content[i] ?? "");
					});
					const run = verilatorSim({
						dir: join(dir, "obj"),
						top: "tb",
						sources: files.map((f) => join(dir, f)),
					});
					expect(run.buildOk, run.buildLog).toBe(true);
					expect(run.exitCode, run.stdout + run.stderr).toBe(0);
					expect(run.stdout).toContain("CELL READY PASS");
				} finally {
					rmSync(dir, { recursive: true, force: true });
				}
			},
			180_000,
		);
	}
});
