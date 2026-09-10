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
