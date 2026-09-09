/* SPDX-License-Identifier: MIT
 * Minimal RV32IMC crt0 for SoC flash XIP smoke firmware. */

	.section .text.init, "ax"
	.global _start
	.global main
	.type _start, @function

_start:
	/* Stack at top of SRAM (0x00010000). */
	la   sp, _stack_top

	/* Copy .data from flash LMA into SRAM VMA (may be empty). */
	la   a0, _sidata
	la   a1, _sdata
	la   a2, _edata
1:
	bgeu a1, a2, 2f
	lw   t0, 0(a0)
	sw   t0, 0(a1)
	addi a0, a0, 4
	addi a1, a1, 4
	j    1b
2:
	/* Clear .bss */
	la   a0, _sbss
	la   a1, _ebss
3:
	bgeu a0, a1, 4f
	sw   zero, 0(a0)
	addi a0, a0, 4
	j    3b
4:
	call main
5:
	j    5b
	.size _start, . - _start
