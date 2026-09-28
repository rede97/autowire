// HBM center CSR (one per fabric, in front of the channels). Global identity
// plus per-channel enables; no pstate shadow (the center block is shared by
// every frequency point). Hangs at hbm offset 0x000 (see sot/wb_bus_hbm.ts).

import {
	Access,
	Cell,
	CellDefault,
	Field,
	Regfile,
	RegfileDefault,
} from "../../../src/plugins/wishbone-regfile/dsl.ts";

export const center = Regfile(
	"center",
	"HBM center CSR (fabric-global control)",
	RegfileDefault.align(4).addrWidth(19).note(`
			Shared by all 16 channels and all pstates: the center block sits in
			front of channel 0 and is not replicated by the pstate TGA slice.
		`),
	[
		Cell("ID", "Fabric identity", CellDefault.offset(0x00), [
			Field("magic", Access.RC, 16, "Magic").reset(0xc0de),
			Field("version", Access.RC, 16, "Version").reset(0x0001),
		]),
		Cell("CH_EN", "Per-channel enable", CellDefault.offset(0x04), [
			Field("enable", Access.RW, 16, "One bit per channel").reset(0xffff),
		]),
		Cell("STATUS", "Fabric status", CellDefault.offset(0x08), [
			Field("all_cal_done", Access.RO, 1, "Every enabled channel calibrated"),
			Field("err_ch", Access.RO, 4, "First channel reporting an error").offset(
				8,
			),
		]),
	],
);
