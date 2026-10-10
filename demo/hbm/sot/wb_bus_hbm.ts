// HBM two-level fabric SoT.
//
//   level 1  hbm     center CSR + channel decoder; pstate is PRODUCED here
//                    from ADR[18:17]
//   level 2  hbm_ch  aword + dword0 + dword1; pstate PASSES THROUGH (bare name)
//
// Address map (byte ADR): center = 0x00000, channel i = (i + 1) * 0x1000, so the
// channel select is ADR[15:12] - 1 (0 selects the center block). pstate =
// ADR[18:17]. The tag sits directly above the windows (span 0x12000). Bits above
// it are discarded; decode keeps ADR[16:0].
// Contract: docs/plugins/wishbone-bus.md 2.1.

import {
	Bus,
	Master,
	Size,
	SlaveBus,
	SlaveRegfile,
	SlaveRegion,
	TagFromAddr,
} from "../../../src/plugins/wishbone-bus/dsl.ts";
import { aword } from "./wb_reg_aword.ts";
import { center } from "./wb_reg_center.ts";
import { dword } from "./wb_reg_dword.ts";
import { pstate } from "./wb_tag_pstate.ts";

const CH_SIZE = 0x1000;
const CH_COUNT = 16;

/** Level 2: one channel. Bare `pstate` = inherit the tag from the parent. */
export const hbm_ch = Bus("hbm_ch", "HBM channel: aword + 2x dword", {
	addrWidth: 12,
	tags: [pstate],
	masters: [Master("cfg", "Channel config from the decoder")],
	slaves: [
		SlaveRegfile(aword, 0x000, { size: Size(0x100) }),
		SlaveRegfile(dword, 0x100, {
			id: "dword0",
			size: Size(0x100),
			broadcastBy: ["dword_all"],
		}),
		SlaveRegfile(dword, 0x200, {
			id: "dword1",
			size: Size(0x100),
			broadcastBy: ["dword_all"],
		}),
		SlaveRegion("dword_bcast", "broadcast dword0 and dword1", 0x300, Size(0x100), {
			broadcast: "dword_all",
		}),
	],
});

/** Level 1: channel interconnect. `TagFromAddr` produces pstate and strips the bits. */
export const hbm = Bus("hbm", "HBM channel interconnect (16 channels)", {
	addrWidth: 19,
	tags: [TagFromAddr(pstate, "18:17")],
	masters: [
		Master("cfg", "Configuration port (fabric clk, 800 MHz)"),
		Master("host", "SoC APB host (100 MHz PCLK)", {
			apb: true,
			cdc: true,
			timeout: 64,
		}),
	],
	slaves: [
		SlaveRegfile(center, 0x000, { size: Size(CH_SIZE) }),
		...Array.from({ length: CH_COUNT }, (_, i) =>
			SlaveBus(hbm_ch.uplink(), (i + 1) * CH_SIZE, {
				id: `ch${i}`,
				size: Size(CH_SIZE),
				desc: `HBM channel ${i}`,
				broadcastBy: ["ch_all"],
			}),
		),
		SlaveRegion(
			"ch_bcast",
			"broadcast all 16 channels",
			(CH_COUNT + 1) * CH_SIZE,
			Size(CH_SIZE),
			{ broadcast: "ch_all" },
		),
	],
});
