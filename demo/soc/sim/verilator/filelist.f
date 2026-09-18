# Verilator filelist (paths relative to demo/soc).
# Generated connect wrappers must exist (web dump).

gen/connect/soc_top.sv
gen/connect/sha256wb.sv

rtl/wb_sram.v
rtl/wb_uart.v
rtl/wb_spiflash.v
rtl/wb_testout.v
rtl/soc_reset.v
rtl/soc_irqmerge.v
rtl/sd_rd_dma.v
rtl/sha256_wb_regs.v
rtl/smoke_wb.v

# Type-A plugins (bun ../../index.ts plugin generate all)
gen/plugins/wishbone-bus/wb_cfg_pipe.sv
gen/plugins/wishbone-bus/soc_wb_interconnect.sv
gen/plugins/wishbone-bus/soc_wb_system.sv
gen/plugins/wishbone-regfile/sha256_regfile.sv
gen/plugins/wishbone-regfile/smoke_regfile.sv

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
sim/verilator/tb_soc_vl.sv
