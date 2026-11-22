#!/usr/bin/env bash
# Verilator SoC smoke (primary DV path): thin wrapper over dtsim
# (dt/config/dtsim.config.ts). Usage (from anywhere):
#   ./dt/verilator/run.sh              # basic_smoke: cascade MMIO + smoke CSR
#   ./dt/verilator/run.sh --regfile    # regfile_smoke: wishbone-regfile MMIO (FIFO/counter)
#   ./dt/verilator/run.sh --sd         # sd_sha256 + card image (channel DMA)
#   ./dt/verilator/run.sh --tb-mod     # tb_mod: aw-tb-mod dump top rtl/gen/sim/soc_tb.sv
#   ./dt/verilator/run.sh --sv-reg     # sv_reg_smoke: sv_reg packages only
# The harness cases also run the external JTAG smoke (jtag_host.h) with the
# firmware. Other arguments go to `dtsim run` (e.g. -v to print the logs
# under the live status, --plain for one line per step). Outputs:
# dt/simout/<case>/. DTSIM overrides the dtsim command.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

CASE=basic_smoke
EXTRA=()
while [[ $# -gt 0 ]]; do
	case "$1" in
	--regfile) CASE=regfile_smoke ;;
	--sd) CASE=sd_sha256 ;;
	--tb-mod) CASE=tb_mod ;;
	--sv-reg) CASE=sv_reg_smoke ;;
	*) EXTRA+=("$1") ;;
	esac
	shift
done

if [[ -n "${DTSIM:-}" ]]; then
	read -ra CMD <<<"$DTSIM"
elif [[ -f ../../index.ts ]]; then
	CMD=(bun ../../index.ts dtsim)
else
	CMD=(dtsim)
fi
exec "${CMD[@]}" run "$CASE" "${EXTRA[@]}"
