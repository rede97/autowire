#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""ELF/bin → spiflash $readmemh byte hex (one byte per line, LE image order).

Usage: makehex.py firmware.bin > firmware.hex
"""

from pathlib import Path
from sys import argv, exit, stdout


def main() -> None:
	if len(argv) != 2:
		print("usage: makehex.py <firmware.bin>", file=__import__("sys").stderr)
		exit(2)
	data = Path(argv[1]).read_bytes()
	if len(data) % 4 != 0:
		# Pad to word boundary for cleaner flash images.
		data = data + bytes(4 - (len(data) % 4))
	for b in data:
		stdout.write(f"{b:02x}\n")


if __name__ == "__main__":
	main()
