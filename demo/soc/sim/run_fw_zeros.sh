#!/usr/bin/env bash
# Legacy alias name (was iverilog zeros_sha256). Prefer:
#   ./sim/verilator/run.sh
exec "$(cd "$(dirname "$0")" && pwd)/verilator/run.sh" "$@"
