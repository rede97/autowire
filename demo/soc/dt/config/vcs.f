# VCS filelist (aw-tb-mod tb_top top, rtl/gen/sim/soc_tb.sv via rtl/gen.f).
# dtsim passes this list to the simulator as `-f <abs path>`; VCS runs in the
# compile dir, so entries name files as $WORKSPACE/... (demo/soc).
# Macro header first (EDA load pattern; analysis gets it via define_headers).
+incdir+$WORKSPACE/dt
$WORKSPACE/rtl/soc_macros.svh
# RTL universe = analysis filelist + generated wrappers/TB (connect run outputs).
-f $WORKSPACE/rtl/soc.f
-f $WORKSPACE/rtl/gen.f

# Simulation-only models
$WORKSPACE/dt/verilator/spiflash_vl.sv
$WORKSPACE/dt/tb_timescale.sv
