// SoC Wishbone fabric SoT (wishbone-bus). Named slaves identity-match regfile ports.
// Generate → gen/plugins/wishbone-bus/soc_wb_interconnect.sv

import {
	Bus,
	Master,
	Slave,
} from "../../../src/plugins/wishbone-bus/dsl.ts";

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
			Slave("sram", "64 KiB SRAM", 0x0000_0000, 0xffff_0000, { pipe: 2 }),
			Slave("flash_xip", "SPI flash XIP", 0x0100_0000, 0xff00_0000, { pipe: 1 }),
			Slave("flash_cfg", "SPI flash cfg", 0x0200_0000, 0xffff_fffc),
			Slave("uart", "simpleuart", 0x0200_0004, 0xffff_fff8, { pipe: 3 }),
			Slave("testout", "test output", 0x0200_0010, 0xffff_fffc, { pipe: 1 }),
			Slave("sd0", "sdspi 0", 0x0300_0000, 0xffff_fff0, { pipe: 2 }),
			Slave("sd1", "sdspi 1", 0x0300_1000, 0xffff_fff0, { pipe: 4 }),
			Slave("dma0", "sd_rd_dma CSR 0", 0x0300_2000, 0xffff_fff0, { pipe: 3 }),
			Slave("dma1", "sd_rd_dma CSR 1", 0x0300_3000, 0xffff_fff0, { pipe: 1 }),
			Slave("sha256_0", "sha256wb lane 0", 0x0300_4000, 0xffff_ffc0, { pipe: 2 }),
			Slave("sha256_1", "sha256wb lane 1", 0x0300_5000, 0xffff_ffc0, { pipe: 4 }),
			Slave("smoke", "wishbone-regfile smoke (TGA 2 → shadow bank)", 0x0300_6000, 0xffff_f000, {
				tag: 2,
				pipe: 3,
			}),
		],
	},
);
