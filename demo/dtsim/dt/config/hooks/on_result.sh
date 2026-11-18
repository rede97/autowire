#!/usr/bin/env bash
# onResult hook (demo/dtsim): runs after grading with the final status. Here:
# append one CSV row per seed next to the case directories, and drop the
# waveform of passing seeds to save disk. Other uses: notify, push to a
# results database. Its exit code never changes the result.
# Args: --phase --case --seed --dir <seed dir> --tool --log --status <status>.
set -euo pipefail
while [[ $# -gt 0 ]]; do
	case "$1" in
	--case) CASE="$2"; shift 2 ;;
	--seed) SEED="$2"; shift 2 ;;
	--dir) DIR="$2"; shift 2 ;;
	--status) STATUS="$2"; shift 2 ;;
	*) shift 2 ;;
	esac
done
# <out>/<case>/<seed> for `run`, <out>/regression/<case>/<seed> for `regr`.
csv="$(dirname "$(dirname "$DIR")")/results.csv"
[[ -f "$csv" ]] || echo "case,seed,status,dir" >"$csv"
echo "$CASE,$SEED,$STATUS,$DIR" >>"$csv"
if [[ "$STATUS" == PASS ]]; then rm -f "$DIR/verilog.fsdb"; fi
