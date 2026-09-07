#!/usr/bin/env bash
# Refresh the RtlIndex from the bundled test sample (hdxml/tests/projects/common_cells).
# Goes through the autowire entry: config lives in the repo-root autowire.toml
# (walk_dirs / incdirs / index dir); the hdxml binary is resolved by autowire
# (--hdxml > toml [hdxml] bin > $HDXML_BIN > repo target > PATH).
# Output dir is the fixed temp dir .autowire/hdxml (docs/workspace-toml.md).
# To change macros/incdirs etc., edit autowire.toml — hdxml args are no longer passed through.
# Usage: ./gen_index.sh [extra autowire analysis flags, e.g. --sub-bars]
#        analysis then prints the dependency tree via `autowire deps`
set -euo pipefail
ROOT=$(cd "$(dirname "$0")" && pwd)

bun "$ROOT/index.ts" analysis --workspace "$ROOT" --sub-bars "$@"
bun "$ROOT/index.ts" deps "$ROOT/.autowire/hdxml"
