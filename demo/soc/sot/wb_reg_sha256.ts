// SoT for demo/soc sha256 Wishbone CSR (CTRL + HASH0..7).
// One RTL leaf (sha256_regfile); bus SlaveRegfile(sha256, base, { id }) hangs it twice
// inside soc_wb_system (sha256_0 / sha256_1). HTML does not re-declare the CSR.
// Glue (AXIS / sticky done) stays in rtl/sha256_wb_regs.v + sha256wb.
// Generate → gen/plugins/wishbone/sha256_regfile.sv + fw/gen/wishbone/sha256.h

export {
	Access,
	BitsAlign,
	Cell,
	CellDefault,
	Field,
	Regfile,
	RegfileDefault,
} from "../../../src/plugins/wishbone-regfile/dsl.ts";

import {
	Access,
	BitsAlign,
	Cell,
	CellDefault,
	Field,
	Regfile,
	RegfileDefault,
} from "../../../src/plugins/wishbone-regfile/dsl.ts";

/**
 * Register map (byte ADR):
 *   0x00 CTRL  bit0 soft_reset(RW) bit1 done_clear(W1P)
 *              bit8 busy(RO) bit9 done(RO sticky, HW-set in glue)
 *   0x04..0x20 HASH0..HASH7 (RO)
 */
export const sha256 = Regfile(
	"sha256",
	"SHA256 CSR (CTRL + HASH0..7); instantiate once per fabric lane",
	RegfileDefault.align(4).addrWidth(32),
	[
		Cell(
			"CTRL",
			"Control / status",
			CellDefault.align(BitsAlign.Align1),
			[
				Field("soft_reset", Access.RW, 1, "Soft reset hash core")
					.offset(0)
					.reset(0),
				Field(
					"done_clear",
					Access.W1P,
					1,
					"Write 1 → pulse; glue clears sticky done",
				).offset(1),
				Field("busy", Access.RO, 1, "Hash core busy").offset(8),
				Field("done", Access.RO, 1, "Sticky done (from glue)").offset(9),
			],
		),
		Cell("HASH0", "Digest word 0", CellDefault.offset(0x4), [
			Field("hash0", Access.RO, 32, "hash0"),
		]),
		Cell("HASH1", "Digest word 1", CellDefault.offset(0x8), [
			Field("hash1", Access.RO, 32, "hash1"),
		]),
		Cell("HASH2", "Digest word 2", CellDefault.offset(0xc), [
			Field("hash2", Access.RO, 32, "hash2"),
		]),
		Cell("HASH3", "Digest word 3", CellDefault.offset(0x10), [
			Field("hash3", Access.RO, 32, "hash3"),
		]),
		Cell("HASH4", "Digest word 4", CellDefault.offset(0x14), [
			Field("hash4", Access.RO, 32, "hash4"),
		]),
		Cell("HASH5", "Digest word 5", CellDefault.offset(0x18), [
			Field("hash5", Access.RO, 32, "hash5"),
		]),
		Cell("HASH6", "Digest word 6", CellDefault.offset(0x1c), [
			Field("hash6", Access.RO, 32, "hash6"),
		]),
		Cell("HASH7", "Digest word 7", CellDefault.offset(0x20), [
			Field("hash7", Access.RO, 32, "hash7"),
		]),
	],
);
