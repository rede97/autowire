# aw-tb-mod dump top (rtl/gen/sim/soc_tb.sv + dt/*.svh): pure SV, Verilator --binary.
# dtsim passes this list to the simulator as `-f <abs path>`; the simulator
# runs in the compile dir, so entries name files as $WORKSPACE/... (demo/soc).
+incdir+$WORKSPACE/dt
$WORKSPACE/dt/tb_timescale.sv
$WORKSPACE/rtl/soc_macros.svh
-f $WORKSPACE/rtl/soc.f
-f $WORKSPACE/rtl/gen.f
$WORKSPACE/dt/verilator/spiflash_vl.sv
