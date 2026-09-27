// Channel fabric SoT: one BusDef reused as parallel SD+DMA+SHA lanes.
// Generate → rtl/gen/plugins/wishbone/sd_sha_interconnect.sv + sd_sha_system.sv
// Master("uplink") is the cascade face (wrapper remaps to i_wb_* / o_wb_*).
// Parent soc_wb hangs this bus in a 4 KiB window and forwards ADR[11:0].
// Child addresses are window-relative; parent SlaveBus forwards adr & ~mask.
// DMA SRC must be programmed with these relative addresses (not parent MMIO).

import {
	Bus,
	Master,
	Size,
	SlaveRegfile,
	SlaveRegion,
	UPLINK_MASTER,
} from "../../../src/plugins/wishbone-bus/dsl.ts";
import { sha256 } from "./wb_reg_sha256.ts";
import { bank } from "./wb_tag_domains.ts";

export const sd_sha = Bus(
	"sd_sha",
	"SD + DMA + SHA256 channel interconnect (uplink + engine)",
	{
		masters: [
			Master(UPLINK_MASTER, "Parent decoder cascade"),
			Master("eng", "sd_rd_dma engine"),
		],
		addrWidth: 12,
		tags: [bank],
		slaves: [
			SlaveRegion("sd", "sdspi CSR", 0x0, Size(16), { pipe: 2 }),
			SlaveRegion("dma", "sd_rd_dma CSR", 0x10, Size(16), { pipe: 3 }),
			SlaveRegfile(sha256, 0x40, { pipe: 2 }),
		],
	},
);
