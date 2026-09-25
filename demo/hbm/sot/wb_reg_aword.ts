// HBM aword CSR (per channel). Shadowed cells replicate per pstate, so each
// frequency point keeps its own timing numbers. The pstate value itself is not
// stored here — it arrives as TGA (see sot/wb_bus_hbm.ts).

import {
	Access,
	BitsAlign,
	Cell,
	CellDefault,
	Field,
	Regfile,
	RegfileDefault,
} from "../../../src/plugins/wishbone-regfile/dsl.ts";
import { pstate } from "./wb_tag_pstate.ts";

export const aword = Regfile(
	"aword",
	"HBM aword CSR (command/address lane)",
	RegfileDefault.align(4)
		.addrWidth(32)
		.shadows(pstate)
		.note(`
			Per-pstate cells are replicated 4x. The bank is selected by the fabric
			TGA slice, not by an address bit inside this leaf, so software keeps
			using one offset per register and switches pstate on the way in.
			ID/STATUS are shared across pstates.
		`),
	[
		Cell("ID", "Lane identity", CellDefault.offset(0x00), [
			Field("magic", Access.RC, 16, "Magic").reset(0xa570),
			Field("version", Access.RC, 16, "Version").reset(0x0001),
		]),
		Cell("STATUS", "Lane status", CellDefault.offset(0x04), [
			Field("cal_done", Access.RO, 1, "Calibration done"),
			Field("err_code", Access.RO, 8, "Last error code").offset(8),
		]),
		Cell(
			"TIMING",
			"Per-pstate command timing",
			CellDefault.offset(0x08).align(BitsAlign.Align8).shadow(pstate),
			[
				Field("trcd", Access.RW, 8, "RAS-to-CAS delay (clk)").reset({
					0: 0x0c,
					1: 0x10,
					2: 0x14,
					3: 0x18,
				}),
				Field("trp", Access.RW, 8, "Row precharge (clk)").reset({
					0: 0x0c,
					1: 0x10,
					2: 0x14,
					3: 0x18,
				}),
			],
		),
		Cell(
			"DRIVE",
			"Per-pstate output drive",
			CellDefault.offset(0x0c).align(BitsAlign.Align8).shadow(pstate),
			[
				Field("ca_drive", Access.RW, 4, "CA driver strength").reset({
					0: 0x4,
					1: 0x6,
					2: 0x8,
					3: 0xa,
				}),
			],
		),
	],
);
