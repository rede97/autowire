#!/usr/bin/env bash
# dtsim demo on fake tools: dt/bin holds mock vcs / simv / urg / verdi /
# verilator / bsub / srun (also used by test/dtsim). No EDA install needed.
# Usage (from anywhere):
#   demo/dtsim/run.sh list
#   demo/dtsim/run.sh run test_hello_world
#   demo/dtsim/run.sh run test_hello_world.cosim --num-seeds 3
#   demo/dtsim/run.sh regr base
# Mock switches (export before running): DTSIM_MOCK_VCS_FAIL=1,
# DTSIM_MOCK_SIMV_FAIL=1, DTSIM_MOCK_SIMV_ERROR=1, DTSIM_MOCK_SIMV_WAIVE=1.
# Outputs: dt/simout/. DTSIM overrides the dtsim command.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")" && pwd)
cd "$ROOT"
export PATH="$ROOT/dt/bin:$PATH"

if [[ -n "${DTSIM:-}" ]]; then
	read -ra CMD <<<"$DTSIM"
elif [[ -f ../../index.ts ]]; then
	CMD=(bun ../../index.ts dtsim)
else
	CMD=(dtsim)
fi
exec "${CMD[@]}" "$@"
