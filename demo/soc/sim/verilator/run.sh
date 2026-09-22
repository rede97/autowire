#!/usr/bin/env bash
# Verilator SoC smoke (primary DV path). Usage (from demo/soc):
#   ./sim/verilator/run.sh              # basic_smoke: cascade MMIO + smoke CSR
#   ./sim/verilator/run.sh --regfile    # wishbone-regfile MMIO smoke (FIFO/counter)
#   ./sim/verilator/run.sh --sd         # sd_sha256 + card image (channel DMA)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

export PATH="${HOME}/wch/Toolchain/RISC-V Embedded GCC15/bin:${HOME}/wch/Toolchain/RISC-V Embedded GCC/bin:${PATH}"

CONN=rtl/gen/connect
USE_SD=0
FW_CASE=basic_smoke
HEX=
EXTRA=()

while [[ $# -gt 0 ]]; do
	case "$1" in
	--sd)
		USE_SD=1
		FW_CASE=sd_sha256
		shift
		;;
	--regfile)
		FW_CASE=regfile_smoke
		shift
		;;
	*)
		echo "unknown arg: $1" >&2
		exit 2
		;;
	esac
done

# ZipCPU sdspi FIFO pointer: once per WB beat (idempotent).
bash patches/apply.sh

test -f "$CONN/soc_top.sv" || { echo "missing $CONN/soc_top.sv — dump first"; exit 1; }
test -f "$CONN/sha256wb.sv" || { echo "missing $CONN/sha256wb.sv — dump first"; exit 1; }
test -f "$CONN/sd_sha_ch.sv" || { echo "missing $CONN/sd_sha_ch.sv — dump first"; exit 1; }
test -f rtl/gen/plugins/wishbone/soc_wb_decoder.sv || {
	echo "missing rtl/gen/plugins/wishbone/soc_wb_decoder.sv — run: bun ../../index.ts plugin generate all" >&2
	exit 1
}
test -f rtl/gen/plugins/wishbone/sd_sha_interconnect.sv || {
	echo "missing rtl/gen/plugins/wishbone/sd_sha_interconnect.sv — run: bun ../../index.ts plugin generate all" >&2
	exit 1
}
test -f rtl/gen/plugins/wishbone/sd_sha_system.sv || {
	echo "missing rtl/gen/plugins/wishbone/sd_sha_system.sv — run: bun ../../index.ts plugin generate all" >&2
	exit 1
}
test -f rtl/gen/plugins/wishbone/sha256_regfile.sv || {
	echo "missing rtl/gen/plugins/wishbone/sha256_regfile.sv — run: bun ../../index.ts plugin generate all" >&2
	exit 1
}
test -f rtl/gen/plugins/wishbone/smoke_regfile.sv || {
	echo "missing rtl/gen/plugins/wishbone/smoke_regfile.sv — run: bun ../../index.ts plugin generate all" >&2
	exit 1
}
test -f fw/gen/wishbone/smoke.h || {
	echo "missing fw/gen/wishbone/smoke.h — run: bun ../../index.ts plugin generate wishbone" >&2
	exit 1
}
test -f fw/gen/wishbone/sha256.h || {
	echo "missing fw/gen/wishbone/sha256.h — run: bun ../../index.ts plugin generate wishbone" >&2
	exit 1
}
test -f fw/gen/wishbone/soc_wb_map.h || {
	echo "missing fw/gen/wishbone/soc_wb_map.h — run: bun ../../index.ts plugin generate wishbone" >&2
	exit 1
}
test -f rtl/gen/plugins/wishbone/soc_wb_system.sv || {
	echo "missing rtl/gen/plugins/wishbone/soc_wb_system.sv — run: bun ../../index.ts plugin generate wishbone" >&2
	exit 1
}

make -C "fw/${FW_CASE}"
HEX="fw/${FW_CASE}/build/firmware.hex"
test -f "$HEX"

if [[ "$USE_SD" == 1 ]]; then
	python3 sim/verilator/images/gen_zeros_sha_img.py \
		sim/verilator/images/zeros_sha.img
	EXTRA+=("+sdcard=sim/verilator/images/zeros_sha.img")
fi

make -C sim/verilator USE_SD="$USE_SD"
OBJ=sim/verilator/obj_dir
[[ "$USE_SD" == 1 ]] && OBJ=sim/verilator/obj_dir_sd
exec "${OBJ}/Vtb_soc_vl" "+firmware=${HEX}" "${EXTRA[@]}"
