# aw-tb-mod dump top (rtl/gen/sim/soc_tb.sv + dt/*.svh): pure SV, Verilator --binary.
# Paths are relative to the project root (demo/soc): dtsim passes this list to
# the simulator as `-f <abs path>` with the project root as cwd.
+incdir+dt
dt/tb_timescale.sv
rtl/soc_macros.svh
-f rtl/soc.f
-f rtl/gen.f
dt/verilator/spiflash_vl.sv
