#!/usr/bin/env bash
# 全量扫描测试：对 tests/projects/* 与 tests/corpus/* 逐一跑 hdxml 分析。
# 与 gen_index.sh（仓库工作区索引，只扫 common_cells）不同——本脚本面向 hdxml
# 自身：校验"每个目标都能产出索引"并汇总规模/错误基线；错误文件视为数据
# （语料含故意非法用例），仅当 index.xml 缺失（崩溃/中断）时判失败。
# 产物在 tests/out/scan/<group>-<name>/（增量缓存：重复跑只重解析变更文件）。
# 用法: tests/scan.sh [额外 hdxml 参数...]
set -u
ROOT=$(cd "$(dirname "$0")" && pwd)
HDXML="$ROOT/../target/debug/hdxml"
[ -x "$HDXML" ] || HDXML="$ROOT/../target/release/hdxml"
[ -x "$HDXML" ] || { echo "hdxml binary not found; run: cargo build" >&2; exit 1; }
OUT="$ROOT/out/scan"
mkdir -p "$OUT"

fail=0
printf '%-22s %6s %8s %6s %9s %7s  %s\n' target files modules tops blackbox errors note
for group in projects corpus; do
  for dir in "$ROOT/$group"/*/; do
    name="$group/$(basename "$dir")"
    dest="$OUT/$group-$(basename "$dir")"
    mapfile -t incdirs < <(find "$dir" -type d -name include -not -path '*/.git/*')
    args=(-w "$dir" -o "$dest")
    for i in ${incdirs[@]+"${incdirs[@]}"}; do args+=(-I "$i"); done
    log=$("$HDXML" "${args[@]}" "$@" 2>&1)
    code=$?
    if [ ! -f "$dest/index.xml" ]; then
      printf '%-22s %s\n' "$name" "FAILED (no index.xml, exit $code)"
      echo "$log" | tail -5
      fail=1
      continue
    fi
    stats=$(echo "$log" | grep '^modules:' || true)
    files=$(echo "$log" | sed -n 's/^XML written: .* (files \([0-9]*\),.*/\1/p')
    modules=$(echo "$stats" | sed -n 's/^modules: \([0-9]*\).*/\1/p')
    tops=$(echo "$stats" | sed -n 's/.*tops: \([0-9]*\).*/\1/p')
    blackbox=$(echo "$stats" | sed -n 's/.*blackbox: \([0-9]*\).*/\1/p')
    errors=$(echo "$stats" | sed -n 's/.*error files: \([0-9]*\).*/\1/p')
    note="ok"; [ "$code" -ne 0 ] && note="exit $code (error files)"
    printf '%-22s %6s %8s %6s %9s %7s  %s\n' \
      "$name" "$files" "$modules" "$tops" "$blackbox" "$errors" "$note"
  done
done
exit "$fail"
