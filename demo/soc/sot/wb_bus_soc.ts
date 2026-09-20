// SoC Wishbone fabric SoT. Named slaves identity-match regfile ports.
// Generate → rtl/gen/plugins/wishbone/soc_wb_interconnect.sv + soc_wb_system.sv
// Attached RegfileDef hangs (sha256 ×2, smoke) live inside soc_wb_system.

import {
	Bus,
	Master,
	Size,
	Slave,
	SlaveRegfile,
	SlaveRegion,
} from "../../../src/plugins/wishbone-bus/dsl.ts";
import { sha256 } from "./wb_reg_sha256.ts";
import { smoke } from "./wb_reg_smoke.ts";

export const soc_wb = Bus(
	"soc_wb",
	"Demo SoC Wishbone interconnect (3 masters, named slaves)",
	{
		masters: [
			Master("cpu", "picorv32_wb"),
			Master("dma0m", "sd_rd_dma engine lane 0"),
			Master("dma1m", "sd_rd_dma engine lane 1"),
		],
		// Mixed slave PIPE depths (0/1/2/3/4) — SoC smoke covers combo + unequal hops.
		slaves: [
			SlaveRegion("sram", "64 KiB SRAM", 0x0000_0000, Size(0x1_0000), {
				pipe: 2,
			}),
			SlaveRegion("flash_xip", "SPI flash XIP", 0x0100_0000, Size(0x0100_0000), {
				pipe: 1,
			}),
			SlaveRegion("flash_cfg", "SPI flash cfg", 0x0200_0000, Size(4)),
			// Unaligned 8-byte match mask (not a 2^N region at this base).
			Slave("uart", "simpleuart", 0x0200_0004, 0xffff_fff8, { pipe: 3 }),
			SlaveRegion("testout", "test output", 0x0200_0010, Size(4), { pipe: 1 }),
			SlaveRegion("sd0", "sdspi 0", 0x0300_0000, Size(16), { pipe: 2 }),
			SlaveRegion("sd1", "sdspi 1", 0x0300_1000, Size(16), { pipe: 4 }),
			SlaveRegion("dma0", "sd_rd_dma CSR 0", 0x0300_2000, Size(16), {
				pipe: 3,
			}),
			SlaveRegion("dma1", "sd_rd_dma CSR 1", 0x0300_3000, Size(16), {
				pipe: 1,
			}),
			SlaveRegfile(sha256, 0x0300_4000, { id: "sha256_0", pipe: 2 }),
			SlaveRegfile(sha256, 0x0300_5000, { id: "sha256_1", pipe: 4 }),
			SlaveRegfile(smoke, 0x0300_6000, { pipe: 3 }),
		],
	},
);
