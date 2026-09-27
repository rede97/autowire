// HBM dword CSR. One RegfileDef, two hangs per channel (dword0 / dword1) via
// distinct SlaveRegfile ids — the RTL leaf and the software header are emitted
// once. Shares the pstate domain with aword.

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

export const dword = Regfile(
	"dword",
	"HBM dword CSR (data lane)",
	RegfileDefault.align(4)
		.addrWidth(32)
		.shadows(pstate)
		.note(`
			Hung twice per channel (dword0 / dword1) from one RegfileDef, so the
			leaf RTL, the C header and the uvm_reg class exist once.
			VREF/EQ are per-pstate; ID/STATUS are shared.
		`),
	[
		Cell("ID", "Lane identity", CellDefault.offset(0x00), [
			Field("magic", Access.RC, 16, "Magic").reset(0xd010),
			Field("version", Access.RC, 16, "Version").reset(0x0001),
		]),
		Cell("STATUS", "Lane status", CellDefault.offset(0x04), [
			Field("train_done", Access.RO, 1, "Read training done"),
			Field("eye_width", Access.RO, 8, "Measured eye width").offset(8),
		]),
		Cell("TRAIN", "Per-lane train pass (active low)", CellDefault.offset(0x10), [
			Field("train_pass_n", Access.RO, 1, "0 = lane passed read training"),
		]),
		Cell(
			"VREF",
			"Per-pstate receiver reference",
			CellDefault.offset(0x08).align(BitsAlign.Align8).shadow(pstate),
			[
				Field("level", Access.RW, 7, "VREF DAC code").reset({
					0: 0x30,
					1: 0x38,
					2: 0x40,
					3: 0x48,
				}),
			],
		),
		Cell(
			"EQ",
			"Per-pstate equalisation",
			CellDefault.offset(0x0c).align(BitsAlign.Align8).shadow(pstate),
			[
				Field("tap0", Access.RW, 5, "DFE tap 0").reset({
					0: 0x02,
					1: 0x04,
					2: 0x06,
					3: 0x08,
				}),
				Field("tap1", Access.RW, 5, "DFE tap 1").reset({
					0: 0x01,
					1: 0x02,
					2: 0x03,
					3: 0x04,
				}),
			],
		),
	],
);
