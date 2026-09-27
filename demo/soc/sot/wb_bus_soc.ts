// SoC Wishbone fabric SoT. Top is a CPU + JTAG interconnect cascaded into two
// parallel sd_sha channel interconnects (one BusDef, two SlaveBus hangs).
// Generate → soc_wb_interconnect.sv + soc_wb_system.sv (smoke leaf, JTAG TDR
// + wb_cdc inside) + soc_wb_system.icl/.pdl. The chip TAP is rtl/demo_tap.v
// (DFT placeholder). Channel RTL is generated once (sd_sha_*); HTML
// instantiates sd_sha_ch ×2.

import {
	Bus,
	Master,
	Size,
	Slave,
	SlaveBus,
	SlaveRegfile,
	SlaveRegion,
	TagFromAddr,
} from "../../../src/plugins/wishbone-bus/dsl.ts";
import { sd_sha } from "./wb_bus_sd_sha.ts";
import { smoke } from "./wb_reg_smoke.ts";
import { bank } from "./wb_tag_domains.ts";

export const soc_wb = Bus(
	"soc_wb",
	"Demo SoC Wishbone interconnect (CPU + JTAG) cascaded into two sd_sha channels",
	{
		masters: [
			Master("cpu", "picorv32_wb"),
			Master("dbg", "External JTAG smoke (TDR behind demo_tap USER)", {
				jtag: true,
				pipe: 2,
			}),
		],
		addrWidth: 32,
		tags: [TagFromAddr(bank, "27:26")],
		// Mixed slave PIPE depths (0/1/2/3/4) — cascade windows plus local pipes.
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
			SlaveBus(sd_sha, 0x0300_0000, { id: "ch0", size: Size(0x1000), pipe: 2 }),
			SlaveBus(sd_sha, 0x0300_1000, { id: "ch1", size: Size(0x1000), pipe: 4 }),
			SlaveRegfile(smoke, 0x0300_6000, { pipe: 3 }),
		],
	},
);
