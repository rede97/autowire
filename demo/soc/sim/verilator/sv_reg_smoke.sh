#!/usr/bin/env bash
# Smoke the generated sv_reg packages ([plugins.wishbone] sv_reg=) in Verilator.
# Non-UVM: no firmware, no connect dump, no bus RTL — it drives a register word
# through the field bit/mask localparams and checks the bus address map.
# Usage (from demo/soc):  ./sim/verilator/sv_reg_smoke.sh
# Needs verilator 5.x on PATH and `bun ../../index.ts plugin wishbone run` done.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

PKG_DIR=dv/sv_reg
test -f "$PKG_DIR/soc_pkg.sv" || {
	echo "missing $PKG_DIR/soc_pkg.sv — run: bun ../../index.ts plugin wishbone run" >&2
	exit 1
}

OBJ=sim/verilator/obj_dir_sv_reg
verilator --binary --timing -j 0 --timescale 1ns/1ps \
	--top-module sv_reg_smoke --Mdir "$OBJ" \
	-Wno-fatal -Wno-lint -Wno-style \
	"+incdir+$PKG_DIR" \
	sim/verilator/sv_reg_smoke.sv -o Vsv_reg_smoke

exec "$OBJ/Vsv_reg_smoke"
