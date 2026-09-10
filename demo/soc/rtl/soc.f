# SoC demo RTL universe (hdxml analysis input).
# Paths are relative to the workspace root (demo/soc). .svh entries are not allowed here.

# Integration leaves (hand-written, Wishbone/AXI-Stream glue)
rtl/wb_interconnect.v
rtl/wb_sram.v
rtl/wb_spiflash.v
rtl/wb_uart.v
rtl/wb_testout.v
rtl/sd_rd_dma.v
rtl/sha256_wb_regs.v
rtl/smoke_wb.v
rtl/soc_reset.v
rtl/soc_irqmerge.v

# Type-A wishbone-regfile leaves (autowire plugin generate wishbone-regfile)
gen/plugins/wishbone-regfile/sha256_wb_regfile.sv
gen/plugins/wishbone-regfile/smoke_regfile.sv

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
# AXI wrappers dropped, re-wrapped over Wishbone via connect/sha256wb.html)
ip/sha256/sha256.v
ip/sha256/sha256_chunk_process.v
ip/sha256/sha256_chunk_compress.v
ip/sha256/sha256_k.v
