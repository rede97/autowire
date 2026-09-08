// SPDX-License-Identifier: MIT
//
// soc_irqmerge.v
//
// Interrupt merge for the autowire SoC demo: packs the per-block interrupt
// sources into the picorv32 32-bit irq word. Bit map (picosoc leaves
// irq[4:0] for internal use):
//   i_ints[0] -> irq[5]  sd0 (sdspi)
//   i_ints[1] -> irq[6]  sd1 (sdspi)
//   i_ints[2] -> irq[7]  dma0 done
//   i_ints[3] -> irq[8]  dma1 done
//   i_ints[4] -> irq[9]  sha256_0 done
//   i_ints[5] -> irq[10] sha256_1 done

`timescale 1ns / 1ps
`default_nettype none

module soc_irqmerge (
	input  wire [5:0]  i_ints,
	output wire [31:0] o_irq
);

	assign o_irq = {21'b0, i_ints, 5'b0};

endmodule

`default_nettype wire
