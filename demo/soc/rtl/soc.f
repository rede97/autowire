# SoC demo RTL universe (hdxml analysis input).
# Paths are relative to the workspace root (demo/soc). .svh entries are not allowed here.

# Integration leaves (hand-written, Wishbone/AXI-Stream glue)
rtl/wb_sram.v
rtl/wb_spiflash.v
rtl/wb_uart.v
rtl/wb_testout.v
rtl/sd_rd_dma.v
rtl/sha256_wb_regs.v
rtl/smoke_wb.v
rtl/soc_reset.v
rtl/soc_irqmerge.v

# Type-A wishbone (CPU decoder + two sd_sha channel interconnects + leaves)
rtl/gen/plugins/wishbone/wb_cfg_pipe.sv
rtl/gen/plugins/wishbone/soc_wb_decoder.sv
rtl/gen/plugins/wishbone/soc_wb_system.sv
rtl/gen/plugins/wishbone/sd_sha_interconnect.sv
rtl/gen/plugins/wishbone/sd_sha_system.sv
rtl/gen/plugins/wishbone/sha256_regfile.sv
rtl/gen/plugins/wishbone/smoke_regfile.sv

# picorv32: CPU + Wishbone wrapper (picorv32_wb lives in picorv32.v)
# plus the picosoc UART / QSPI flash controller
ip/picorv32/picorv32.v
ip/picorv32/picosoc/simpleuart.v
ip/picorv32/picosoc/spimemio.v

# ZipCPU sdspi (SPI-mode SD card controller, Wishbone slave)
ip/sdspi/rtl/spi/sdspi.v
ip/sdspi/rtl/spi/llsdspi.v
ip/sdspi/rtl/spi/spicmd.v
ip/sdspi/rtl/spi/spirxdata.v
ip/sdspi/rtl/spi/spitxdata.v

# sha256 streaming core (source: github.com/rede97/zynq_sha256;
# AXIS glue in sha256_wb_regs; CSR = sha256_regfile (one hang per sd_sha channel)
ip/sha256/sha256.v
ip/sha256/sha256_chunk_process.v
ip/sha256/sha256_chunk_compress.v
ip/sha256/sha256_k.v
