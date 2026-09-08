#!/usr/bin/env bash
# 全量扫描测试：对 tests/projects/* 与 tests/corpus/* 逐一跑 hdxml 分析。
# 与 gen_index.sh（仓库工作区索引，只扫 common_cells）不同——本脚本面向 hdxml
# 自身：每个目标独立 hdxml 进程、进度条直接渲染在终端，统计走 hdxml --summary
# 报告文件，跑完后统一打印汇总。判失败仅当 index.xml 缺失（崩溃/中断）；
# 错误文件作基线数据上报。产物在 tests/out/scan/<group>-<name>/（增量缓存）。
# 用法: tests/scan.sh [--refresh] [额外 hdxml 参数...]
set -u
ROOT=$(cd "$(dirname "$0")" && pwd)
HDXML="$ROOT/../target/debug/hdxml"
[ -x "$HDXML" ] || HDXML="$ROOT/../target/release/hdxml"
[ -x "$HDXML" ] || { echo "hdxml binary not found; run: cargo build" >&2; exit 1; }
OUT="$ROOT/out/scan"
mkdir -p "$OUT"

refresh=()
extra=()
for a in "$@"; do
  if [ "$a" = "--refresh" ]; then refresh=(--refresh); else extra+=("$a"); fi
done

# incdirs 探测：含 .svh 的目录**及其父目录**（同时覆盖 "regs.svh" 源相对式与
# "common_cells/regs.svh" 前缀式 include；sv-parser-pp 只做 CWD/incdirs 解析）。
# projects 组跨项目共享（pulp 系），目标自身在前（同名头文件本地优先）
mapfile -t sibling_incdirs < <(find "$ROOT/projects" -name '*.svh' -not -path '*/.git/*' -printf '%h\n%h/../\n' | xargs -n1 realpath -m | sort -u)

names=() files_col=() modules_col=() tops_col=() blackbox_col=() errors_col=() notes=()
fail=0
for group in projects corpus; do
  for dir in "$ROOT/$group"/*/; do
    name="$group/$(basename "$dir")"
    dest="$OUT/$group-$(basename "$dir")"
    mapfile -t incdirs < <(find "$dir" -name '*.svh' -not -path '*/.git/*' -printf '%h\n%h/../\n' | xargs -n1 realpath -m | sort -u)
    args=(-w "$dir" -o "$dest" --summary "$dest/summary.txt")
    for i in ${incdirs[@]+"${incdirs[@]}"}; do args+=(-I "$i"); done
    if [ "$group" = projects ]; then
      # 验证侧目录（UVM/FPV 库不在分析范围）—— sharpening：剩余错误即真 RTL 问题
      args+=(--exclude-dirs dv verif tb testbench)
      for i in ${sibling_incdirs[@]+"${sibling_incdirs[@]}"}; do
        case " ${incdirs[*]-} " in *" $i "*) ;; *) args+=(-I "$i");; esac
      done
    fi
    echo "+ hdxml ${args[*]} --sub-bars ${refresh[*]+"${refresh[*]}"} ${extra[*]+"${extra[*]}"}"
    # 进度条（Analyzing 聚合条 + --sub-bars 每线程 spinner）直接渲染终端；
    # 统计从 --summary 报告文件读取，无需重定向
    "$HDXML" "${args[@]}" --sub-bars ${refresh[@]+"${refresh[@]}"} ${extra[@]+"${extra[@]}"}
    code=$?
    echo
    names+=("$name")
    if [ ! -f "$dest/index.xml" ] || [ ! -f "$dest/summary.txt" ]; then
      files_col+=("-"); modules_col+=("-"); tops_col+=("-"); blackbox_col+=("-"); errors_col+=("-")
      notes+=("FAILED (exit $code)")
      fail=1
      continue
    fi
    files_col+=("$(sed -n 's/^files: //p' "$dest/summary.txt")")
    modules_col+=("$(sed -n 's/^modules: //p' "$dest/summary.txt")")
    tops_col+=("$(sed -n 's/^tops: //p' "$dest/summary.txt")")
    blackbox_col+=("$(sed -n 's/^blackbox: //p' "$dest/summary.txt")")
    errors_col+=("$(sed -n 's/^error_files: //p' "$dest/summary.txt")")
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
