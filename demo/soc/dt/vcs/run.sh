#!/usr/bin/env bash
# VCS SoC smoke (aw-tb-mod tb_soc top): thin wrapper over
# `dtsim run <case> --tool vcs` (dt/config/dtsim.config.ts). Usage (from anywhere):
#   ./dt/vcs/run.sh                # basic_smoke: cascade MMIO + smoke CSR + JTAG
#   ./dt/vcs/run.sh regfile_smoke  # wishbone-regfile MMIO smoke
# sd_sha256 / tb_mod / sv_reg_smoke are Verilator-only (Case tools).
# Outputs: dt/simout/vcs/<case>/. Arguments after the case go to `dtsim run`
# (e.g. -v, --wave). DTSIM overrides the dtsim command.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

CASE="${1:-basic_smoke}"
shift || true

if [[ -n "${DTSIM:-}" ]]; then
	read -ra CMD <<<"$DTSIM"
elif [[ -f ../../index.ts ]]; then
	CMD=(bun ../../index.ts dtsim)
else
	CMD=(dtsim)
fi
exec "${CMD[@]}" run "$CASE" --tool vcs "$@"
