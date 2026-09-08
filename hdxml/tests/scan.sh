#!/usr/bin/env bash
# 全量扫描测试：对 tests/projects/* 与 tests/corpus/* 逐一跑 hdxml 分析。
# 与 gen_index.sh（仓库工作区索引，只扫 common_cells）不同——本脚本面向 hdxml
# 自身：每个目标独立 hdxml 进程、完整输出实时可见，跑完后统一打印统计汇总。
# 判失败仅当 index.xml 缺失（崩溃/中断）；错误文件作基线数据上报。
# 产物在 tests/out/scan/<group>-<name>/（增量缓存：重复跑只重解析变更文件）。
# 用法: tests/scan.sh [--refresh] [额外 hdxml 参数...]
set -u
ROOT=$(cd "$(dirname "$0")" && pwd)
HDXML="$ROOT/../target/debug/hdxml"
[ -x "$HDXML" ] || HDXML="$ROOT/../target/release/hdxml"
[ -x "$HDXML" ] || { echo "hdxml binary not found; run: cargo build" >&2; exit 1; }
OUT="$ROOT/out/scan"
LOGD="$OUT/logs"
mkdir -p "$LOGD"

refresh=()
extra=()
for a in "$@"; do
  if [ "$a" = "--refresh" ]; then refresh=(--refresh); else extra+=("$a"); fi
done

# 跨项目依赖（pulp 系 `include "common_cells/…"` 等）：projects 组共享全部 include 目录，
# 目标自身的 include 在前（同名头文件本地优先）
mapfile -t sibling_incdirs < <(find "$ROOT/projects" -type d -name include -not -path '*/.git/*')

names=() files_col=() modules_col=() tops_col=() blackbox_col=() errors_col=() notes=()
fail=0
for group in projects corpus; do
  for dir in "$ROOT/$group"/*/; do
    name="$group/$(basename "$dir")"
    dest="$OUT/$group-$(basename "$dir")"
    mapfile -t incdirs < <(find "$dir" -type d -name include -not -path '*/.git/*')
    args=(-w "$dir" -o "$dest")
    for i in ${incdirs[@]+"${incdirs[@]}"}; do args+=(-I "$i"); done
    if [ "$group" = projects ]; then
      for i in ${sibling_incdirs[@]+"${sibling_incdirs[@]}"}; do
        case " ${incdirs[*]-} " in *" $i "*) ;; *) args+=(-I "$i");; esac
      done
    fi
    echo "================ $name ================"
    echo "+ hdxml ${args[*]} ${refresh[*]+"${refresh[*]}"} ${extra[*]+"${extra[*]}"}"
    "$HDXML" "${args[@]}" ${refresh[@]+"${refresh[@]}"} ${extra[@]+"${extra[@]}"} 2>&1 | tee "$LOGD/$group-$(basename "$dir").log"
    code=${PIPESTATUS[0]}
    echo
    names+=("$name")
    if [ ! -f "$dest/index.xml" ]; then
      files_col+=("-"); modules_col+=("-"); tops_col+=("-"); blackbox_col+=("-"); errors_col+=("-")
      notes+=("FAILED (no index.xml, exit $code)")
      fail=1
      continue
    fi
    stats=$(grep '^modules:' "$LOGD/$group-$(basename "$dir").log" || true)
    files_col+=("$(sed -n 's/^XML written: .* (files \([0-9]*\),.*/\1/p' "$LOGD/$group-$(basename "$dir").log")")
    modules_col+=("$(echo "$stats" | sed -n 's/^modules: \([0-9]*\).*/\1/p')")
    tops_col+=("$(echo "$stats" | sed -n 's/.*tops: \([0-9]*\).*/\1/p')")
    blackbox_col+=("$(echo "$stats" | sed -n 's/.*blackbox: \([0-9]*\).*/\1/p')")
    errors_col+=("$(echo "$stats" | sed -n 's/.*error files: \([0-9]*\).*/\1/p')")
    note="ok"; [ "$code" -ne 0 ] && note="exit $code (error files)"
    notes+=("$note")
  done
done

echo "================ summary ================"
printf '%-22s %6s %8s %6s %9s %7s  %s\n' target files modules tops blackbox errors note
for i in "${!names[@]}"; do
  printf '%-22s %6s %8s %6s %9s %7s  %s\n' \
    "${names[$i]}" "${files_col[$i]}" "${modules_col[$i]}" "${tops_col[$i]}" \
    "${blackbox_col[$i]}" "${errors_col[$i]}" "${notes[$i]}"
done
exit "$fail"
