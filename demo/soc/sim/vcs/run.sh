#!/usr/bin/env bash
# VCS SoC smoke (aw-tb-mod tb_soc top, mirrors sim/verilator/run.sh --tb-mod).
# Usage (from demo/soc):
#   ./sim/vcs/run.sh                # basic_smoke: cascade MMIO + smoke CSR + JTAG
#   ./sim/vcs/run.sh regfile_smoke  # wishbone-regfile MMIO smoke
# The --sd card-image case stays Verilator-only (sdspisim is a C++ model).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

FW_CASE="${1:-basic_smoke}"

# Dumps must be current: bun ../../index.ts analysis run && connect run
test -f rtl/gen/sim/tb_soc.sv || { echo "missing rtl/gen/sim/tb_soc.sv — connect run first"; exit 1; }

make -C "fw/${FW_CASE}"
HEX="fw/${FW_CASE}/build/firmware.hex"
test -f "$HEX"

WORK=sim/vcs/work
mkdir -p "$WORK"

# -timescale: generated wrappers carry no `timescale, hand RTL does (ITSFM).
# --no-as-needed: VCS O-2018.09 on binutils >= 2.34 drops its own shared libs.
vcs -full64 -sverilog -timescale=1ns/1ps +incdir+sim \
	-f sim/vcs/filelist.f -top tb_soc \
	-o "$WORK/simv" -Mdir="$WORK/csrc" \
	-LDFLAGS "-Wl,--no-as-needed" \
	-l "$WORK/compile.log"

exec "$WORK/simv" "+firmware=${HEX}" -l "$WORK/run.log"
