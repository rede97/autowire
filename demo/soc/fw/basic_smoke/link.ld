/* basic_smoke: XIP code + KAT message at flash offset 0x1000. */
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

	/* Soft-padded SHA message words (legacy gen_firmware.py KAT). */
	.kat 0x01001000 : {
		KEEP(*(.kat.sha_msg))
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

	_stack_top = ORIGIN(RAM) + LENGTH(RAM);
}
