/* SPDX-License-Identifier: MIT
 * Soft-padded SHA-256 KAT at flash VMA 0x01001000 (see link.ld .kat).
 * Words match sim/gen_firmware.py MSG_WORDS (LE in memory / XIP).
 */
	.section .kat.sha_msg, "a", @progbits
	.balign 4
	.globl kat_sha_msg
	.type kat_sha_msg, @object
kat_sha_msg:
	.word 0x64343962, 0x39623732, 0x64343339, 0x38306533
	.word 0x65323561, 0x37643235, 0x64376164, 0x61666261
	.word 0x34383463, 0x33656665, 0x33356137, 0x65653038
	.word 0x38383039, 0x63613766, 0x66653265, 0x39656463
	.word 0x00000080
	.word 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
	.word 0x00020000
	.size kat_sha_msg, .-kat_sha_msg
