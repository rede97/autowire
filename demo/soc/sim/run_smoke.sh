#!/usr/bin/env bash
# Build + run the SoC smoke simulation (gen/ RTL from autowire dump +
# integration leaves + IP + spiflash model). Expects "SMOKE PASS".
# Usage: ./sim/run_smoke.sh
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

iverilog -g2012 -o sim/tb_soc_smoke.vvp -s tb_soc_smoke \
	sim/tb_soc_smoke.v gen/soc_top.sv gen/sha256wb.sv rtl/*.v \
	ip/picorv32/picorv32.v \
	ip/picorv32/picosoc/simpleuart.v ip/picorv32/picosoc/spimemio.v ip/picorv32/picosoc/spiflash.v \
	ip/sdspi/rtl/spi/sdspi.v ip/sdspi/rtl/spi/llsdspi.v ip/sdspi/rtl/spi/spicmd.v \
	ip/sdspi/rtl/spi/spirxdata.v ip/sdspi/rtl/spi/spitxdata.v \
	ip/sha256/sha256.v ip/sha256/sha256_chunk_process.v \
	ip/sha256/sha256_chunk_compress.v ip/sha256/sha256_k.v

vvp -N sim/tb_soc_smoke.vvp +firmware=sim/firmware_smoke.hex
