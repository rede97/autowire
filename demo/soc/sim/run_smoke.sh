#!/usr/bin/env bash
# Build + run SoC smoke via aw-tb-mod dump (gen/connect + gen/sim).
# Regenerates type-A plugin RTL; expects prior: analysis + web dump of
# sha256wb, soc_top, soc_tb.
# Usage: ./sim/run_smoke.sh
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

CONN=gen/connect
SIM=gen/sim
test -f "$CONN/soc_top.sv" || { echo "missing $CONN/soc_top.sv — dump soc_top first"; exit 1; }
test -f "$CONN/sha256wb.sv" || { echo "missing $CONN/sha256wb.sv — dump sha256wb first"; exit 1; }
test -f "$SIM/tb_soc.sv" || { echo "missing $SIM/tb_soc.sv — dump soc_tb first"; exit 1; }

# Regenerate plugin RTL (bus + regfiles) so the smoke matches the SoT.
bun ../../index.ts plugin generate all >/dev/null

PLUGINS="gen/plugins/wishbone-bus/wb_cfg_pipe.sv \
	gen/plugins/wishbone-bus/soc_wb_interconnect.sv \
	gen/plugins/wishbone-regfile/sha256_0_regfile.sv \
	gen/plugins/wishbone-regfile/sha256_1_regfile.sv \
	gen/plugins/wishbone-regfile/smoke_regfile.sv"
for f in $PLUGINS; do
	test -f "$f" || { echo "missing $f — plugin generate failed"; exit 1; }
done

iverilog -g2012 -o sim/tb_soc.vvp -s tb_soc \
	-I sim \
	sim/tb_timescale.sv \
	"$SIM/tb_soc.sv" "$CONN/soc_top.sv" "$CONN/sha256wb.sv" $PLUGINS rtl/*.v \
	ip/picorv32/picorv32.v \
	ip/picorv32/picosoc/simpleuart.v ip/picorv32/picosoc/spimemio.v ip/picorv32/picosoc/spiflash.v \
	ip/sdspi/rtl/spi/sdspi.v ip/sdspi/rtl/spi/llsdspi.v ip/sdspi/rtl/spi/spicmd.v \
	ip/sdspi/rtl/spi/spirxdata.v ip/sdspi/rtl/spi/spitxdata.v \
	ip/sha256/sha256.v ip/sha256/sha256_chunk_process.v \
	ip/sha256/sha256_chunk_compress.v ip/sha256/sha256_k.v

vvp -N sim/tb_soc.vvp +firmware=sim/firmware_smoke.hex
