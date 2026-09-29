# VCS filelist (paths relative to demo/soc; sim/vcs/run.sh runs from there).
# Macro header first (EDA load pattern; analysis gets it via define_headers).
rtl/soc_macros.svh
# RTL universe = analysis filelist + generated wrappers/TB (connect run outputs).
-f rtl/soc.f
-f rtl/gen.f

# Simulation-only models
sim/verilator/spiflash_vl.sv
sim/tb_timescale.sv
