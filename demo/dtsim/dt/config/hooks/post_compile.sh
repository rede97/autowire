#!/usr/bin/env bash
# postCompile hook (demo/dtsim): a compile-log policy the simulator does not
# enforce itself. Fails the compile when the log has more warnings than
# DTSIM_DEMO_MAX_WARN (default 50). Other uses: archive the build, check
# the produced executable, publish a compile report.
# Args: --phase --case --dir --tool --log <compile log>.
set -euo pipefail
while [[ $# -gt 0 ]]; do
	case "$1" in
	--log) LOG="$2"; shift 2 ;;
	*) shift 2 ;;
	esac
done
max=${DTSIM_DEMO_MAX_WARN:-50}
count=$(grep -c "Warning-\[" "$LOG" || true)
echo "post_compile: $count warning(s) in $LOG (limit $max)"
if ((count > max)); then
	echo "post_compile: too many compile warnings" >&2
	exit 1
fi
