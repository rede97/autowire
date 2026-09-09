#!/usr/bin/env python3
"""Build a tiny raw SD image for sd_sha256 Verilator smoke.

Sector 0 holds the same 32 soft-padded message *words* as basic_smoke SRAM KAT
(sha256 of 64 zero bytes). Words are stored big-endian on disk so that
sdspi with default OPT_LITTLE_ENDIAN=0 packs them into matching FIFO words.

Remaining sector bytes are zero. Image size is one 512-byte sector.
"""
from __future__ import annotations

import argparse
import struct
import sys
from pathlib import Path

MSG_WORDS = [0] * 16 + [0x00000080] + [0] * 14 + [0x00020000]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("out", help="output raw image path")
    args = ap.parse_args()

    sector = bytearray()
    for w in MSG_WORDS:
        sector.extend(struct.pack(">I", w & 0xFFFFFFFF))
    if len(sector) > 512:
        print("message exceeds sector", file=sys.stderr)
        return 1
    sector.extend(b"\x00" * (512 - len(sector)))

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(bytes(sector))
    print(f"wrote {out} ({len(sector)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
