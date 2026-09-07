#!/usr/bin/env bash
# 用既有测试样本（hdxml/tests/projects/common_cells）刷新 RtlIndex 索引。
# 输出目录由 autowire 指定为固定临时目录 .autowire/hdxml（docs/workspace-toml.md）。
# 用法: ./gen_index.sh [额外 hdxml analysis 参数，如 --keep-raw WIDTH]
set -euo pipefail
ROOT=$(cd "$(dirname "$0")" && pwd)

BIN="$ROOT/hdxml/target/release/hdxml"
[ -x "$BIN" ] || BIN="$ROOT/hdxml/target/debug/hdxml"
if [ ! -x "$BIN" ]; then
    echo "hdxml 未构建，先执行: cargo build --manifest-path hdxml/Cargo.toml" >&2
    exit 1
fi

SAMPLE="$ROOT/hdxml/tests/projects/common_cells"
exec "$BIN" analysis \
    -w "$SAMPLE/src" \
    -I "$SAMPLE/include" \
    --xml "$ROOT/.autowire/hdxml" \
    --sub-bars \
    "$@"
