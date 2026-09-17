#!/usr/bin/env python3
"""Regenerate sim/firmware_smoke.hex (source of truth for the smoke firmware).

Layout in the spiflash model image (byte addressed):
  0x0000  RV32I program (see below)
  0x1000  SHA-256 known-answer vector: the software-padded message words
          from zynq_sha256's bench/sha256_axi_stream_tb.v (32 words).

Program flow (picorv32, PROGADDR_RESET = 0x0100_0000 = flash offset 0):
  1. testout <- 1 (alive marker)
  2. copy 32 message words flash XIP 0x0100_1000 -> SRAM 0x0000_0100
  3. dma0 (0x0300_2000): SRC=0x100, LEN=32 words, CTRL.start
  4. poll dma0 STATUS.done, then sha256_0 (0x0300_4000) STATUS.busy==0
  5. compare hash0..7 against the expected digest (byte order per the
     zynq_sha256 bench dump: each word byte-reversed)
  6. pass: testout <- 0x600d600d (loop); fail: testout <- 0xdead0001
"""

MSG_WORDS = [
    0x64343962, 0x39623732, 0x64343339, 0x38306533,
    0x65323561, 0x37643235, 0x64376164, 0x61666261,
    0x34383463, 0x33656665, 0x33356137, 0x65653038,
    0x38383039, 0x63613766, 0x66653265, 0x39656463,
    0x00000080,
] + [0] * 14 + [0x00020000]

EXPECTED = [
    0x52A09D04, 0x56EB4F63, 0xBCC06ECE, 0x20678C64,
    0x1CFFED11, 0x31B572B2, 0x0AC9BB13, 0x9C24008F,
]


def lui(rd, imm20):
    return (imm20 << 12) | (rd << 7) | 0x37


def addi(rd, rs1, imm):
    return ((imm & 0xFFF) << 20) | (rs1 << 15) | (rd << 7) | 0x13


def lw(rd, rs1, imm):
    return ((imm & 0xFFF) << 20) | (rs1 << 15) | (2 << 12) | (rd << 7) | 0x03


def sw(rs2, rs1, imm):
    return (((imm >> 5) & 0x7F) << 25) | (rs2 << 20) | (rs1 << 15) | \
        (2 << 12) | ((imm & 0x1F) << 7) | 0x23


def btype(f3, rs1, rs2, off):
    imm = off & 0x1FFF
    return (((imm >> 12) & 1) << 31 | ((imm >> 5) & 0x3F) << 25 | rs2 << 20
            | rs1 << 15 | f3 << 12 | ((imm >> 1) & 0xF) << 8
            | ((imm >> 11) & 1) << 7 | 0x63)


def beq(rs1, rs2, off):
    return btype(0, rs1, rs2, off)


def bne(rs1, rs2, off):
    return btype(1, rs1, rs2, off)


def andr(rd, rs1, rs2):
    return (rs2 << 20) | (rs1 << 15) | (7 << 12) | (rd << 7) | 0x33


def build():
    prog = []

    def li(rd, val):
        hi = (val + 0x800) >> 12
        prog.append(lui(rd, hi))
        prog.append(addi(rd, rd, val - (hi << 12)))

    prog.append(lui(1, 0x02000))            # x1 = io base
    prog.append(lui(4, 0x03000))            # x4 = periph base
    prog.append(addi(9, 0, 1))
    prog.append(sw(9, 1, 0x10))             # alive marker -> testout
    prog.append(lui(6, 0x01001))            # src = flash xip 0x0100_1000
    prog.append(addi(5, 0, 0x100))          # dst = sram 0x100
    prog.append(addi(7, 0, 32))             # count
    cpy = len(prog)
    prog.append(lw(9, 6, 0))
    prog.append(sw(9, 5, 0))
    prog.append(addi(6, 6, 4))
    prog.append(addi(5, 5, 4))
    prog.append(addi(7, 7, -1))
    prog.append(bne(7, 0, (cpy - len(prog)) * 4))
    prog.append(lw(9, 5, -4))               # drain posted SRAM writes
    fail_patches = []
    for lane in range(2):
        dma_base = 0x03002000 + lane * 0x1000
        sha_base = 0x03004000 + lane * 0x1000
        li(8, dma_base)
        prog.append(addi(9, 0, 0x100))
        prog.append(sw(9, 8, 8))                # SRC
        prog.append(addi(9, 0, 32))
        prog.append(sw(9, 8, 12))               # LEN (words)
        prog.append(addi(9, 0, 3))
        prog.append(sw(9, 8, 0))                # CTRL.start | src_inc
        prog.append(addi(9, 0, 2))              # done mask
        pdma = len(prog)
        prog.append(lw(10, 8, 4))               # STATUS
        prog.append(andr(10, 10, 9))
        prog.append(beq(10, 0, (pdma - len(prog)) * 4))
        li(11, sha_base)
        prog.append(addi(9, 0, 0x100))          # busy mask (bit8)
        pbusy = len(prog)
        prog.append(lw(10, 11, 0))
        prog.append(andr(10, 10, 9))
        prog.append(bne(10, 0, (pbusy - len(prog)) * 4))
        for i, exp in enumerate(EXPECTED):
            prog.append(lw(13, 11, 4 + 4 * i))  # hash i at +4..+32
            prog.append(sw(13, 1, 0x10))        # print hash word -> testout
            li(12, exp)
            fail_patches.append(len(prog))
            prog.append(0)                      # bne x13, x12, fail (patched)

    fail_pos = len(prog)
    # branch over the compare loop lands on a jump-to-pass placeholder;
    # the fail block itself starts one word later
    for idx in fail_patches:
        prog[idx] = bne(13, 12, (fail_pos + 1 - idx) * 4)
    pass_jmp = len(prog)
    prog.append(0)                          # beq x0, x0, pass (patched)
    # fail path lands exactly at fail_pos + 1
    prog.append(lui(9, 0xDEAD0))
    prog.append(addi(9, 9, 1))              # 0xdead0001
    fmark = len(prog)
    prog.append(sw(9, 1, 0x10))
    prog.append(beq(0, 0, (fmark - len(prog)) * 4))
    # pass path
    prog[pass_jmp] = beq(0, 0, (len(prog) - pass_jmp) * 4)
    li(9, 0x600D600D)                       # pass marker
    pmark = len(prog)
    prog.append(sw(9, 1, 0x10))
    prog.append(beq(0, 0, (pmark - len(prog)) * 4))
    return prog


def main():
    prog = build()
    lines = []
    for w in prog:
        lines += [f"{(w >> (8 * k)) & 0xFF:02x}" for k in range(4)]
    lines.append("@1000")
    for w in MSG_WORDS:
        lines += [f"{(w >> (8 * k)) & 0xFF:02x}" for k in range(4)]
    out = "\n".join(lines) + "\n"
    path = __file__.rsplit("/", 1)[0] + "/firmware_smoke.hex"
    with open(path, "w") as f:
        f.write(out)
    print(f"wrote {path}: {len(prog)} program words, {len(MSG_WORDS)} msg words")


if __name__ == "__main__":
    main()
