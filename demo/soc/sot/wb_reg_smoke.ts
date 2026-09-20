// SoC wishbone-regfile smoke SoT (MMIO-tested from fw/regfile_smoke).
// Individual exports keep bun unit coverage; `smoke` is the on-bus leaf.
// Generate → gen/plugins/wishbone/smoke_regfile.sv;
// instantiate on soc_top; rtl/smoke_wb.v is sideband glue only.
// After generate + analysis: bus wrapper instantiates smoke_regfile; HTML keeps smoke_wb glue.
// No HTML register stub tags.

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

/** On-bus map @ 0x0300_6000 (byte ADR). Sidebands tied in connect HTML. */
export const smoke = Regfile(
	"smoke",
	"SoC regfile smoke bank (RC/RO/RW/RWW/RWE/W1P/W1C/shadow/wide)",
	RegfileDefault.align(4)
		.addrWidth(32)
		.readWriteBlock(true)
		.shadows(Shadow("bank", 4, "1:0")),
	[
		Cell("ID", "RC identity", CellDefault.offset(0x000), [
			Field("magic", Access.RC, 16, "Magic").reset(0xa55a),
			Field("version", Access.RC, 16, "Version").reset(0x0001),
		]),
		Cell("STATUS", "RO status", CellDefault.offset(0x004), [
			Field("busy", Access.RO, 1, "Busy (tied in HTML)"),
			Field("code", Access.RO, 8, "Status code").offset(8),
		]),
		Cell(
			"CFG",
			"RW config",
			CellDefault.offset(0x008).align(BitsAlign.Align8),
			[
				Field("enable", Access.RW, 1, "Enable").reset(0),
				Field("mode", Access.RW, 3, "Mode").reset(1),
			],
		),
		Cell("FEED", "RWW capture", CellDefault.offset(0x00c), [
			Field("capture", Access.RWW, 16, "Capture").reset(0),
		]),
		Cell("FIFO", "RWE window", CellDefault.offset(0x010), [
			Field("data", Access.RWE, 32, "External data"),
		]),
		Cell("CMD", "W1P pulse", CellDefault.offset(0x014), [
			Field("go", Access.W1P, 1, "Go pulse"),
		]),
		Cell("IRQ", "W1C sticky", CellDefault.offset(0x018), [
			Field("sticky", Access.W1C, 1, "Sticky IRQ").reset(0),
		]),
		Cell(
			"BANK",
			"Shadowed RW",
			CellDefault.offset(0x01c).align(BitsAlign.Align8).shadow("bank"),
			[
				Field("cfg", Access.RW, 8, "Per-bank cfg").reset({
					0: 0x10,
					1: 0x20,
					2: 0x30,
					3: 0x40,
				}),
			],
		),
		Cell("BANKSEL", "Shadow bank select (drives fabric TGA)", CellDefault.offset(0x02c), [
			Field("bank_sel", Access.RW, 2, "Shadow bank for WB accesses").reset(0),
		]),
		Cell("FABRIC", "Wishbone interconnect fabric controls", CellDefault.offset(0x030), [
			Field("rb_grant_en", Access.RW, 1, "Arbiter: 0=fixed prio, 1=round-robin").reset(0),
		]),
		Block("key", "Wide key", BlockDefault.offset(0x020).byteAlign(4), [
			Field("key", Access.RW, 96, "96-bit key").reset(0),
		]),
	],
);

// --- Per-Access leaves (bun unit smoke; not mapped on the SoC bus) ---

export const smoke_rc = Regfile(
	"smoke_rc",
	"Smoke: Access.RC ReadConst",
	RegfileDefault.align(4).addrWidth(8),
	[
		Cell("ID", "Identity", CellDefault, [
			Field("magic", Access.RC, 16, "Magic").reset(0xa55a),
			Field("version", Access.RC, 16, "Version").reset(0x0001),
		]),
	],
);

export const smoke_ro = Regfile(
	"smoke_ro",
	"Smoke: Access.RO functional in",
	RegfileDefault.align(4).addrWidth(8),
	[
		Cell("STATUS", "Status", CellDefault, [
			Field("busy", Access.RO, 1, "Busy"),
			Field("code", Access.RO, 8, "Status code").offset(8),
		]),
	],
);

export const smoke_rw = Regfile(
	"smoke_rw",
	"Smoke: Access.RW regbit",
	RegfileDefault.align(4).addrWidth(8),
	[
		Cell("CFG", "Config", CellDefault.align(BitsAlign.Align8), [
			Field("enable", Access.RW, 1, "Enable").reset(0),
			Field("mode", Access.RW, 3, "Mode").reset(1),
		]),
	],
);

export const smoke_rww = Regfile(
	"smoke_rww",
	"Smoke: Access.RWW + HW strb/hwdata",
	RegfileDefault.align(4).addrWidth(8),
	[
		Cell("FEED", "HW feed", CellDefault, [
			Field("capture", Access.RWW, 16, "Capture").reset(0),
		]),
	],
);

export const smoke_rwe = Regfile(
	"smoke_rwe",
	"Smoke: Access.RWE external window + ready",
	RegfileDefault.align(4).addrWidth(8).readWriteBlock(true),
	[
		Cell("FIFO", "External FIFO", CellDefault, [
			Field("data", Access.RWE, 32, "FIFO data"),
		]),
	],
);

export const smoke_w1p = Regfile(
	"smoke_w1p",
	"Smoke: Access.W1P pulse",
	RegfileDefault.align(4).addrWidth(8),
	[
		Cell("CMD", "Command", CellDefault, [
			Field("go", Access.W1P, 1, "Go pulse"),
		]),
	],
);

export const smoke_w1c = Regfile(
	"smoke_w1c",
	"Smoke: Access.W1C sticky clear",
	RegfileDefault.align(4).addrWidth(8),
	[
		Cell("IRQ", "IRQ", CellDefault, [
			Field("sticky", Access.W1C, 1, "Sticky IRQ").reset(0),
		]),
	],
);

export const smoke_shadow = Regfile(
	"smoke_shadow",
	"Smoke: Shadow bank via wb_tga + remaps",
	RegfileDefault.align(4)
		.addrWidth(8)
		.shadows(Shadow("bank", 4, "1:0").remaps({ 3: 0b1111 })),
	[
		Block("lane", "Per-bank", BlockDefault.byteAlign(4), [
			Cell(
				"CFG",
				"Banked config",
				CellDefault.align(BitsAlign.Align8).shadow("bank"),
				[
					Field("cfg", Access.RW, 8, "Per-bank cfg").reset({
						0: 1,
						1: 2,
						2: 3,
						3: 4,
					}),
				],
			),
		]),
	],
);

export const smoke_block_wide = Regfile(
	"smoke_block_wide",
	"Smoke: Block wide field auto-split",
	RegfileDefault.align(4).addrWidth(8),
	[
		Block("key", "Wide key", BlockDefault.byteAlign(4), [
			Field("key", Access.RW, 96, "96-bit key auto-split").reset(0),
		]),
	],
);
