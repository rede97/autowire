# VCS filelist (aw-tb-mod tb_soc top). Paths are relative to the project root
# (demo/soc); dtsim flattens this list into the compile dir.
# Macro header first (EDA load pattern; analysis gets it via define_headers).
+incdir+dt
rtl/soc_macros.svh
# RTL universe = analysis filelist + generated wrappers/TB (connect run outputs).
-f rtl/soc.f
-f rtl/gen.f

# Simulation-only models
dt/verilator/spiflash_vl.sv
dt/tb_timescale.sv
