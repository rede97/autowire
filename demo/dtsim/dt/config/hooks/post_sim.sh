#!/usr/bin/env bash
# postSim hook (demo/dtsim): post-process one seed before grading. Here: pull
# a few numbers out of sim.log into metrics.json for dashboards. Other uses:
# compare a dumped output file with a golden model (exit 1 fails the seed),
# convert waves, collect per-seed coverage.
# Args: --phase --case --seed --dir <seed dir> --tool --log <sim log>.
set -euo pipefail
while [[ $# -gt 0 ]]; do
	case "$1" in
	--case) CASE="$2"; shift 2 ;;
	--seed) SEED="$2"; shift 2 ;;
	--dir) DIR="$2"; shift 2 ;;
	--log) LOG="$2"; shift 2 ;;
	*) shift 2 ;;
	esac
done
lines=$(wc -l <"$LOG" 2>/dev/null || echo 0)
errors=$(grep -c "Error" "$LOG" 2>/dev/null || true)
cat >"$DIR/metrics.json" <<EOF
{"case": "$CASE", "seed": "$SEED", "log_lines": ${lines// /}, "error_lines": ${errors:-0}}
EOF
echo "post_sim: wrote $DIR/metrics.json"
