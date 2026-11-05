// Author-facing SoT samples for wishbone-regfile (docs example).
// DSL: src/plugins/wishbone-regfile/dsl.ts — contract: docs/plugins/wishbone-regfile.md

export {
	Access,
	BitsAlign,
	Block,
	BlockDefault,
	Cell,
	CellDefault,
	Field,
	Regfile,
	RegfileDefault,
	Shadow,
} from "../../../src/plugins/wishbone-regfile/dsl.ts";

import {
	Access,
	BitsAlign,
	Block,
	BlockDefault,
	Cell,
	CellDefault,
	Field,
	Regfile,
	RegfileDefault,
	Shadow,
} from "../../../src/plugins/wishbone-regfile/dsl.ts";

export const sub_module_a = Regfile(
	"sub_module_a",
	"Sub-module A — omit offset, auto layout",
	RegfileDefault.align(4)
		.addrWidth(8)
		.readWriteBlock(true)
		.shadows(Shadow("lane", 4, "1:0").remaps({ 3: 0b1111 })),
	[
		Block("ctrl", "Control", BlockDefault.byteAlign(16), [
			Cell(
				"CFG0",
				"Main config",
				CellDefault.align(BitsAlign.Align8).shadow("lane"),
				[
					Field("enable", Access.RW, 1, "Soft enable").reset(0),
					Field("mode", Access.RW, 3, "Operating mode").reset(0),
					Field("lane_cfg", Access.RW, 8, "Per-lane config (shadowed)").reset({
						0: 0x10,
						1: 0x20,
						2: 0x30,
						3: 0x40,
					}),
				],
			),

			Cell("STATUS", "Status", CellDefault, [
				Field("busy", Access.RO, 1, "Busy"),
				Field(
					"irq_sticky",
					Access.W1C,
					1,
					"Sticky IRQ; write 1 to clear",
				).reset(0),
				Field("pulse_cmd", Access.W1P, 1, "Write 1 → one-cycle pulse out"),
			]),

			Field("key", Access.RW, 96, "96-bit key; auto-split + auto offset").reset(
				0,
			),
		]),

		Block("data", "Data path", BlockDefault.byteAlign(4), [
			Cell("SCRATCH", "Scratch pad", CellDefault, [
				Field("word", Access.RW, 32, "Scratch word").reset(0),
			]),
			Cell("HW_FEED", "Hardware feed", CellDefault, [
				Field(
					"capture",
					Access.RWW,
					16,
					"HW may update via capture_strb/capture_hwdata",
				).reset(0),
			]),
			Cell("EXT_FIFO", "External FIFO window", CellDefault, [
				Field("ext_data", Access.RWE, 32, "External FIFO data"),
			]),
		]),

		Cell("SOLO", "Independent cell", CellDefault, [
			Field("flag", Access.RW, 1, "Solo flag").reset(0),
		]),
	],
);

export const sub_module_b = Regfile(
	"sub_module_b",
	"Sub-module B (nested slot)",
	RegfileDefault.sheet("sub_module_b_regs").addrWidth(16).align(4),
	[
		Block("misc", "Misc registers", BlockDefault.byteAlign(8), [
			Cell("ID", "Identification", CellDefault, [
				Field("version", Access.RC, 16, "Chip / IP version (ReadConst)").reset(
					0x0001,
				),
				Field("magic", Access.RC, 16, "Magic ID (ReadConst)").reset(0xa55a),
			]),
		]),
	],
);

// Reset domains: cells bound off the fabric reset. "por_rst_n" is declared
// once per table, binds whole cells (cell → block default → table default),
// and exports as an i_por_rst_n input (merged by name at the bus wrapper).
export const sub_module_rst = Regfile(
	"sub_module_rst",
	"Sub-module R — power-domain reset cells",
	RegfileDefault.align(4).addrWidth(8).resetDomains("por_rst_n"),
	[
		Block("por", "Power domain", BlockDefault.resetDomain("por_rst_n"), [
			// Inherits the block default: storage flops reset by i_por_rst_n.
			Cell("POR_CFG", "Power config", CellDefault, [
				Field("keep", Access.RW, 4, "Survives soft reset").reset(0xa),
			]),
			// Explicit beats the block default.
			Cell("SOFT_CFG", "Soft config", CellDefault.resetDomain("rst_n"), [
				Field("mode", Access.RW, 2, "Mode, reset by i_rst_n").reset(0),
			]),
		]),
		// No .resetDomain(...) anywhere → i_rst_n (the implicit "rst_n" domain).
		Cell("SOLO", "Independent cell", CellDefault, [
			Field("flag", Access.RW, 1, "Solo flag").reset(0),
		]),
	],
);

// Cell-only permission: posted writes remain queued until i_ctrl_rdy is high.
export const sub_module_ready = Regfile(
	"sub_module_ready",
	"Cell access permission without changing posted pipe semantics",
	RegfileDefault.addrWidth(8),
	[
		Cell("CTRL", "Ready-gated control", CellDefault.ready("ctrl_rdy"), [
			Field("capture", Access.RWW, 8, "Hardware updates while bus waits").reset(
				0,
			),
			Field("events", Access.W1C, 8, "Sticky events while bus waits").reset(0),
		]),
		Cell(
			"STATUS",
			"Status sharing the permission",
			CellDefault.ready("ctrl_rdy"),
			[Field("status", Access.RO, 8, "Live status sampled at ACK")],
		),
		Cell("ID", "Ungated identity", CellDefault, [
			Field("identity", Access.RC, 8, "Readable while CTRL is blocked").reset(
				1,
			),
		]),
	],
);

// W1CC is distinct from W1C in Excel and has both hardware masks.
export const sub_module_w1cc = Regfile(
	"sub_module_w1cc",
	"State-conditional set and clear events",
	RegfileDefault.addrWidth(8),
	[
		Cell(
			"EVENTS",
			"Events with hardware clear",
			CellDefault.ready("events_rdy"),
			[
				Field("conditional", Access.W1CC, 8, "Old 1: clear; old 0: set").reset(
					0x55,
				),
				Field(
					"sticky",
					Access.W1C,
					8,
					"Ordinary sticky: set wins software clear",
				).reset(0),
			],
		),
	],
);
