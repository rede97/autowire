#!/usr/bin/env bash
# dtsim preSim hook (demo/soc): build the case firmware ($FW, a fw/<dir>) and,
# for the SD case, the raw card image ($SD_IMAGE). Both come from case env.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)

export PATH="${HOME:-}/wch/Toolchain/RISC-V Embedded GCC15/bin:${HOME:-}/wch/Toolchain/RISC-V Embedded GCC/bin:${PATH}"

if [[ -n "${FW:-}" ]]; then
	make -C "$ROOT/fw/$FW"
	test -f "$ROOT/fw/$FW/build/firmware.hex"
fi
if [[ -n "${SD_IMAGE:-}" ]]; then
	python3 "$ROOT/dt/verilator/images/gen_zeros_sha_img.py" "$SD_IMAGE"
fi
