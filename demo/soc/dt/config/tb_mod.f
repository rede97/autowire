# aw-tb-mod dump top (rtl/gen/sim/tb_top.sv + dt/*.svh): pure SV, Verilator --binary.
# Paths are relative to the project root (demo/soc); dtsim flattens this list.
+incdir+dt
dt/tb_timescale.sv
rtl/soc_macros.svh
-f rtl/soc.f
-f rtl/gen.f
dt/verilator/spiflash_vl.sv
