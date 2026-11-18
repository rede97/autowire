#!/usr/bin/env bash
# dtsim preCompile hook (demo/soc): ZipCPU sdspi FIFO pointer patch, once per
# WB beat. Idempotent; the submodule stays at upstream dfb16c8 otherwise.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
bash "$ROOT/patches/apply.sh"
