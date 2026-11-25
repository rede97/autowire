# SoC demo RTL universe (hdxml analysis input).
# Entries are $WORKSPACE/... (the workspace root, demo/soc): autowire analysis
# and the simulators, which compile outside the root, both expand it.
# .svh entries are not allowed here.

# Integration leaves (hand-written, Wishbone/AXI-Stream glue)
$WORKSPACE/rtl/wb_sram.v
$WORKSPACE/rtl/wb_spiflash.v
$WORKSPACE/rtl/wb_uart.v
$WORKSPACE/rtl/wb_testout.v
$WORKSPACE/rtl/sd_rd_dma.v
$WORKSPACE/rtl/sha256_wb_regs.v
$WORKSPACE/rtl/smoke_wb.v
$WORKSPACE/rtl/soc_reset.v
$WORKSPACE/rtl/soc_irqmerge.v
$WORKSPACE/rtl/demo_tap.v
# Connect probe leaf (macro-width port; not instantiated by the SoC)
$WORKSPACE/rtl/macro_probe.sv

# Type-A wishbone (CPU + JTAG interconnect + two sd_sha channel interconnects + leaves)
$WORKSPACE/rtl/gen/plugins/wishbone/bus/wb_cfg_pipe.sv
$WORKSPACE/rtl/gen/plugins/wishbone/bus/wb_sync_cell.sv
$WORKSPACE/rtl/gen/plugins/wishbone/bus/wb_async_fifo.sv
$WORKSPACE/rtl/gen/plugins/wishbone/bus/wb_cdc.sv
$WORKSPACE/rtl/gen/plugins/wishbone/bus/wb_jtag_tdr.sv
$WORKSPACE/rtl/gen/plugins/wishbone/bus/soc_wb_interconnect.sv
$WORKSPACE/rtl/gen/plugins/wishbone/bus/soc_wb_bus_cfg.sv
$WORKSPACE/rtl/gen/plugins/wishbone/bus/sd_sha_interconnect.sv
$WORKSPACE/rtl/gen/plugins/wishbone/bus/sd_sha_bus_cfg.sv
$WORKSPACE/rtl/gen/plugins/wishbone/regfile/sha256_regfile.sv
$WORKSPACE/rtl/gen/plugins/wishbone/regfile/smoke_regfile.sv

# picorv32: CPU + Wishbone wrapper (picorv32_wb lives in picorv32.v)
# plus the picosoc UART / QSPI flash controller
$WORKSPACE/ip/picorv32/picorv32.v
$WORKSPACE/ip/picorv32/picosoc/simpleuart.v
$WORKSPACE/ip/picorv32/picosoc/spimemio.v

# ZipCPU sdspi (SPI-mode SD card controller, Wishbone slave)
$WORKSPACE/ip/sdspi/rtl/spi/sdspi.v
$WORKSPACE/ip/sdspi/rtl/spi/llsdspi.v
$WORKSPACE/ip/sdspi/rtl/spi/spicmd.v
$WORKSPACE/ip/sdspi/rtl/spi/spirxdata.v
$WORKSPACE/ip/sdspi/rtl/spi/spitxdata.v

# sha256 streaming core (source: github.com/rede97/zynq_sha256;
# AXIS glue in sha256_wb_regs; CSR = sha256_regfile (one hang per sd_sha channel)
$WORKSPACE/ip/sha256/sha256.v
$WORKSPACE/ip/sha256/sha256_chunk_process.v
$WORKSPACE/ip/sha256/sha256_chunk_compress.v
$WORKSPACE/ip/sha256/sha256_k.v
