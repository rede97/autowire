// Bun unit leaves for wishbone-regfile Access / theme coverage.
// Not demo/soc SoT — do not hang these on soc_wb or pack into fw/gen.

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
} from "../../src/plugins/wishbone-regfile/dsl.ts";

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
