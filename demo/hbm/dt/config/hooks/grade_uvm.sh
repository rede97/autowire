#!/usr/bin/env bash
# dtsim onGrade hook (demo/hbm): PASS only when the UVM report summary shows
# zero UVM_ERROR and zero UVM_FATAL. Prints the status as the first line.
set -uo pipefail
LOG=""
while [[ $# -gt 0 ]]; do
	case "$1" in
	--log) LOG="$2"; shift 2 ;;
	*) shift ;;
	esac
done
if [[ ! -f "$LOG" ]]; then
	echo "NO SIM LOG"
elif grep -q "UVM_ERROR :    0" "$LOG" && grep -q "UVM_FATAL :    0" "$LOG"; then
	echo "PASS"
else
	echo "FAIL"
fi
