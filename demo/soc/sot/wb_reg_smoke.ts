// SoC wishbone-regfile smoke SoT (MMIO-tested from fw/regfile_smoke).
// On-bus leaf only. Bun Access/theme leaves live in test/fixtures/wb_reg_access.ts.
// Generate → rtl/gen/plugins/wishbone/smoke_regfile.sv;
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
