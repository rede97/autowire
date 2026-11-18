# C++ harness build (tb_soc_vl top + dt/verilator/tb_main.cpp).
# Paths are relative to the project root (demo/soc); dtsim flattens this list.
# Macro header first (EDA load pattern; analysis gets it via define_headers).
+incdir+dt
rtl/soc_macros.svh
# RTL universe = analysis filelist + generated wrappers/TB (connect run outputs).
# rtl/gen/sim/tb_soc.sv comes along and is pruned: --top-module is tb_soc_vl.
-f rtl/soc.f
-f rtl/gen.f

# Simulation-only harness
dt/verilator/spiflash_vl.sv
dt/verilator/tb_soc_vl.sv
