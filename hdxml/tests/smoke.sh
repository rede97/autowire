#!/usr/bin/env bash
# 测试环境冒烟验证：
#   1. 工具链存在性
#   2. 语料抽样用 verible-verilog-syntax / verilator lint / iverilog 交叉解析
#   3. 报告各 oracle 的解析成功率（语料本身含故意非法文件，100% 不是目标；
#      本脚本验证的是"环境可用 + 各 oracle 产出合理的成功率基线"）
# 用法: tests/smoke.sh [抽样数，默认 60]
set -u
ROOT=$(cd "$(dirname "$0")" && pwd)
N=${1:-60}

echo "== 工具链"
ok=1
for t in verilator iverilog verible-verilog-syntax verible-verilog-lint git; do
    if command -v "$t" >/dev/null; then printf '   [ok] %s\n' "$t"
    else printf '   [MISSING] %s\n' "$t"; ok=0; fi
done
python3 -c 'import pyslang' 2>/dev/null && echo "   [ok] pyslang (slang)" || { echo "   [MISSING] pyslang"; ok=0; }
[ $ok -eq 1 ] || { echo "工具链不完整，中止"; exit 1; }

echo
echo "== 语料抽样交叉解析 (n=$N/oracle)"
mapfile -t files < <(find "$ROOT/corpus" -name '*.sv' -not -path '*/.git/*' | shuf -n "$N" --random-source=<(yes))
total=${#files[@]}
v_ok=0; vl_ok=0; iv_ok=0
for f in "${files[@]}"; do
    verilator --lint-only -Wno-fatal -Wno-lint --timing "$f" >/dev/null 2>&1 && vl_ok=$((vl_ok+1))
    verible-verilog-syntax "$f" >/dev/null 2>&1 && v_ok=$((v_ok+1))
    iverilog -g2012 -t null "$f" >/dev/null 2>&1 && iv_ok=$((iv_ok+1))
done
printf '   verible-verilog-syntax: %d/%d 解析成功\n' "$v_ok" "$total"
printf '   verilator --lint-only:  %d/%d 通过\n' "$vl_ok" "$total"
printf '   iverilog -g2012:        %d/%d 通过\n' "$iv_ok" "$total"
echo "   （语料含单文件不可独立编译/故意非法的用例，三 oracle 成功率不必一致；"
echo "    该基线用于校验环境，后续 CI 用固定清单而非随机抽样）"
