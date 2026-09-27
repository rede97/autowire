# Verilator filelist (paths relative to demo/soc).
# Generated connect wrappers must exist (web dump).

rtl/gen/connect/soc_top.sv
rtl/gen/connect/sd_sha_ch.sv
rtl/gen/connect/sha256wb.sv

rtl/wb_sram.v
rtl/wb_uart.v
rtl/wb_spiflash.v
rtl/wb_testout.v
rtl/soc_reset.v
rtl/soc_irqmerge.v
rtl/sd_rd_dma.v
rtl/sha256_wb_regs.v
rtl/smoke_wb.v
rtl/demo_tap.v

# Type-A plugins (bun ../../index.ts plugin generate all)
rtl/gen/plugins/wishbone/wb_cfg_pipe.sv
rtl/gen/plugins/wishbone/wb_sync_cell.sv
rtl/gen/plugins/wishbone/wb_cdc.sv
rtl/gen/plugins/wishbone/wb_jtag_tdr.sv
rtl/gen/plugins/wishbone/soc_wb_interconnect.sv
rtl/gen/plugins/wishbone/soc_wb_system.sv
rtl/gen/plugins/wishbone/sd_sha_interconnect.sv
rtl/gen/plugins/wishbone/sd_sha_system.sv
rtl/gen/plugins/wishbone/sha256_regfile.sv
rtl/gen/plugins/wishbone/smoke_regfile.sv

ip/picorv32/picorv32.v
ip/picorv32/picosoc/simpleuart.v
ip/picorv32/picosoc/spimemio.v

ip/sdspi/rtl/spi/sdspi.v
ip/sdspi/rtl/spi/llsdspi.v
ip/sdspi/rtl/spi/spicmd.v
ip/sdspi/rtl/spi/spirxdata.v
ip/sdspi/rtl/spi/spitxdata.v

ip/sha256/sha256.v
ip/sha256/sha256_chunk_process.v
ip/sha256/sha256_chunk_compress.v
ip/sha256/sha256_k.v

sim/verilator/spiflash_vl.sv
sim/tb_timescale.sv
rtl/gen/sim/tb_soc.sv
