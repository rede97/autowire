# VCS filelist (aw-tb-mod tb_top top, rtl/gen/sim/soc_tb.sv via rtl/gen.f).
# Paths are relative to the project root (demo/soc): dtsim passes this list to
# the simulator as `-f <abs path>` with the project root as cwd.
# Macro header first (EDA load pattern; analysis gets it via define_headers).
+incdir+dt
rtl/soc_macros.svh
# RTL universe = analysis filelist + generated wrappers/TB (connect run outputs).
-f rtl/soc.f
-f rtl/gen.f

# Simulation-only models
dt/verilator/spiflash_vl.sv
dt/tb_timescale.sv
