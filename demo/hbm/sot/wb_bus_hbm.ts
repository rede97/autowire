// HBM two-level fabric SoT.
//
//   level 1  hbm     channel decoder; pstate is PRODUCED here from ADR[22:21]
//   level 2  hbm_ch  aword + dword0 + dword1; pstate PASSES THROUGH (bare name)
//
// Address map (byte ADR): channel = ADR[15:12], pstate = ADR[22:21].
// A channel block therefore appears at 4 aliases 0x20_0000 apart; one window
// declaration covers all of them because the tag bits are stripped from decode.
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
import { dword } from "./wb_reg_dword.ts";
import { pstate } from "./wb_tag_pstate.ts";

const CH_SIZE = 0x1000;
const CH_COUNT = 16;

/** Level 2: one channel. Bare `pstate` = inherit the tag from the uplink. */
export const hbm_ch = Bus("hbm_ch", "HBM channel: aword + 2x dword", {
	tags: [pstate],
	masters: [Master("uplink", "From the channel decoder")],
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

/** Level 1: channel decoder. `TagFromAddr` produces pstate and strips the bits. */
export const hbm = Bus("hbm", "HBM channel decoder (16 channels)", {
	tags: [TagFromAddr(pstate, "22:21")],
	masters: [Master("cfg", "Configuration port")],
	slaves: Array.from({ length: CH_COUNT }, (_, i) =>
		SlaveBus(hbm_ch, i * CH_SIZE, {
			id: `ch${i}`,
			size: Size(CH_SIZE),
			desc: `HBM channel ${i}`,
			broadcastBy: ["ch_all"],
		}),
	).concat(
		SlaveRegion("ch_bcast", "broadcast all 16 channels", CH_COUNT * CH_SIZE, Size(CH_SIZE), {
			broadcast: "ch_all",
		}),
	),
});
