/* Linker script: XIP flash @ 0x0100_0000, SRAM @ 0x0000_0000 (64 KiB).
 * STACKADDR in connect HTML is 0x0001_0000 (top of SRAM). */

OUTPUT_ARCH(riscv)
ENTRY(_start)

MEMORY {
	FLASH (rx)  : ORIGIN = 0x01000000, LENGTH = 1M
	RAM   (rwx) : ORIGIN = 0x00000000, LENGTH = 64K
}

SECTIONS {
	.text : {
		KEEP(*(.text.init))
		*(.text .text.*)
		*(.rodata .rodata.*)
		*(.srodata .srodata.*)
		. = ALIGN(4);
	} > FLASH

	.data : {
		*(.data .data.*)
		*(.sdata .sdata.*)
		. = ALIGN(4);
	} > RAM AT > FLASH

	_sidata = LOADADDR(.data);
	_sdata = ADDR(.data);
	_edata = ADDR(.data) + SIZEOF(.data);

	.bss (NOLOAD) : {
		_sbss = .;
		*(.bss .bss.*)
		*(.sbss .sbss.*)
		*(COMMON)
		. = ALIGN(4);
		_ebss = .;
	} > RAM

	/* Leave low SRAM free for message buffers (e.g. 0x100); stack at top. */
	_stack_top = ORIGIN(RAM) + LENGTH(RAM);
}
