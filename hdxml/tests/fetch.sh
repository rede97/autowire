#!/usr/bin/env bash
# 拉取测试语料与 RTL 项目（tests/corpus + tests/projects）
# 全部使用 blobless + sparse 浅克隆，提交哈希记录到 tests/MANIFEST.txt 以便复现。
# 用法: tests/fetch.sh [名称...]   （无参数 = 全部）
set -u

ROOT=$(cd "$(dirname "$0")" && pwd)
MANIFEST="$ROOT/MANIFEST.txt"

fetch() {
    name=$1; url=$2; branch=$3; dest=$4; shift 4
    # 剩余参数: sparse 路径
    if [ -d "$dest/.git" ]; then
        echo "== $name: 已存在，跳过（删除后重拉）"
        return 0
    fi
    echo "== $name -> $dest"
    if ! git clone -q --depth 1 --filter=blob:none --sparse --branch "$branch" "$url" "$dest"; then
        echo "!! $name 克隆失败" >&2
        return 1
    fi
    (cd "$dest" && git sparse-checkout set "$@" >/dev/null 2>&1)
    sha=$(git -C "$dest" rev-parse HEAD)
    printf '%-16s %s  %s\n' "$name" "$sha" "$url" >> "$MANIFEST"
    echo "   $name @ $sha"
}

corpus()  { fetch "$1" "$2" "$3" "$ROOT/corpus/$1"   "${@:4}"; }
project() { fetch "$1" "$2" "$3" "$ROOT/projects/$1" "${@:4}"; }

targets_corpus="sv-parser slang verible verilog-mode"
targets_projects="ibex cv32e40p cva6 common_cells axi apb veer-el2 opentitan"

run_corpus() {
    corpus sv-parser   https://github.com/dalance/sv-parser.git        master sv-parser/testcases
    corpus slang       https://github.com/MikePopoloski/slang.git      master tests/unittests/data tests/regression
    corpus verible     https://github.com/chipsalliance/verible.git    master verible/verilog
    corpus verilog-mode https://github.com/veripool/verilog-mode.git   master tests tests_ok
}

run_projects() {
    project ibex         https://github.com/lowRISC/ibex.git              master rtl dv vendor/lowrisc_ip/ip/prim/rtl vendor/lowrisc_ip/dv/sv/dv_utils
    project cv32e40p     https://github.com/openhwgroup/cv32e40p.git      master rtl bhv
    project cva6         https://github.com/openhwgroup/cva6.git          master core
    project common_cells https://github.com/pulp-platform/common_cells.git master src include
    project axi          https://github.com/pulp-platform/axi.git         master src include
    project apb          https://github.com/pulp-platform/apb.git         master src include
    project veer-el2     https://github.com/chipsalliance/Cores-VeeR-EL2.git main design
    project opentitan    https://github.com/lowRISC/opentitan.git         master \
        hw/ip/uart hw/ip/tlul hw/ip/prim
}

if [ $# -eq 0 ]; then
    : > "$MANIFEST"
    run_corpus
    run_projects
else
    for t in "$@"; do
        sed -i "/^$t /d" "$MANIFEST" 2>/dev/null || true
        case $t in
            sv-parser)    corpus sv-parser   https://github.com/dalance/sv-parser.git        master sv-parser/testcases ;;
            slang)        corpus slang       https://github.com/MikePopoloski/slang.git      master tests/unittests/data tests/regression ;;
            verible)      corpus verible     https://github.com/chipsalliance/verible.git    master verible/verilog ;;
            verilog-mode) corpus verilog-mode https://github.com/veripool/verilog-mode.git   master tests tests_ok ;;
            ibex)         project ibex         https://github.com/lowRISC/ibex.git              master rtl dv vendor/lowrisc_ip/ip/prim/rtl vendor/lowrisc_ip/dv/sv/dv_utils ;;
            cv32e40p)     project cv32e40p     https://github.com/openhwgroup/cv32e40p.git      master rtl bhv ;;
            cva6)         project cva6         https://github.com/openhwgroup/cva6.git          master core ;;
            common_cells) project common_cells https://github.com/pulp-platform/common_cells.git master src include ;;
            axi)          project axi          https://github.com/pulp-platform/axi.git         master src include ;;
            apb)          project apb          https://github.com/pulp-platform/apb.git         master src include ;;
            veer-el2)     project veer-el2     https://github.com/chipsalliance/Cores-VeeR-EL2.git main design ;;
            opentitan)    project opentitan    https://github.com/lowRISC/opentitan.git         master \
                              hw/ip/uart hw/ip/tlul hw/ip/prim ;;
            *) echo "未知目标: $t（可选: $targets_corpus $targets_projects）" >&2; exit 2 ;;
        esac
    done
fi

echo
echo "== 完成，统计:"
for d in "$ROOT/corpus"/* "$ROOT/projects"/*; do
    [ -d "$d" ] || continue
    n=$(find "$d" -name '*.sv' -o -name '*.v' -o -name '*.svh' 2>/dev/null | wc -l)
    printf '   %-40s %s 个 SV 相关文件\n' "${d#"$ROOT"/}" "$n"
done
