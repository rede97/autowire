# C++ harness build (tb_top + dt/verilator/tb_main.cpp).
# Paths are relative to the project root (demo/soc); dtsim flattens this list.
# Macro header first (EDA load pattern; analysis gets it via define_headers).
+incdir+dt
rtl/soc_macros.svh
# Generated connect wrappers; the generated TB is excluded because this
# filelist supplies the C++ harness's own tb_top.
-f rtl/soc.f
rtl/gen/connect/sha256wb.sv
rtl/gen/connect/sd_sha_ch.sv
rtl/gen/connect/macro_width_probe.sv
rtl/gen/connect/soc_top.sv

# Simulation-only harness
dt/verilator/spiflash_vl.sv
dt/verilator/tb_soc_vl.sv
