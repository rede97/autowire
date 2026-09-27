#!/usr/bin/env bash
# HBM demo VCS + UVM-1.2 regression. Run from anywhere:
#   demo/hbm/sim/vcs/run.sh              # all tests
#   demo/hbm/sim/vcs/run.sh hbm_rw_test  # one test
set -euo pipefail

HBM="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(cd "$(dirname "$0")" && pwd)/work"
mkdir -p "$WORK"
cd "$WORK"

# hbm.f paths are relative to the workspace root; make them absolute here.
grep -v '^\s*#' "$HBM/rtl/hbm.f" | sed "s|^|$HBM/|" > hbm_abs.f

TESTS="hbm_reset_test hbm_ro_test hbm_rw_test hbm_bcast_write_test hbm_bcast_read_test hbm_concurrent_test"
if [ $# -ge 1 ]; then TESTS="$*"; fi

vcs -sverilog -full64 -ntb_opts uvm-1.2 -timescale=1ns/1ps \
	+incdir+"$HBM/dv/ral" \
	+incdir+"$HBM/dv/uvm" \
	-f hbm_abs.f \
	"$HBM/dv/uvm/hbm_wb_if.sv" \
	"$HBM/dv/uvm/hbm_apb_if.sv" \
	"$HBM/dv/uvm/hbm_tb_pkg.sv" \
	"$HBM/dv/uvm/tb_top.sv" \
	-debug_access+all \
	-LDFLAGS "-Wl,--no-as-needed -Wl,--allow-shlib-undefined" \
	-l compile.log

fail=0
for t in $TESTS; do
	./simv +UVM_TESTNAME="$t" -l "sim_$t.log" || true
	if grep -q "UVM_ERROR :    0" "sim_$t.log" && grep -q "UVM_FATAL :    0" "sim_$t.log"; then
		echo "PASS $t"
	else
		echo "FAIL $t (see sim_$t.log)"
		fail=1
	fi
done
exit $fail
