#!/usr/bin/env bash
# HBM demo VCS + UVM-1.2 regression: thin wrapper over dtsim
# (dt/config/dtsim.config.ts). Run from anywhere:
#   dt/vcs/run.sh              # all tests (one compile, one sim per test)
#   dt/vcs/run.sh hbm_rw_test  # listed tests only
# Outputs: dt/simout/. DTSIM overrides the dtsim command.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"

if [[ -n "${DTSIM:-}" ]]; then
	read -ra CMD <<<"$DTSIM"
elif [[ -f ../../index.ts ]]; then
	CMD=(bun ../../index.ts dtsim)
else
	CMD=(dtsim)
fi

if [[ $# -eq 0 ]]; then
	exec "${CMD[@]}" regr --no-wave --plain
fi
fail=0
for t in "$@"; do
	"${CMD[@]}" run "$t" --no-wave --plain || fail=1
done
exit $fail
