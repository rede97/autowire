# C++ harness build (tb_top + dt/verilator/tb_main.cpp).
# dtsim passes this list to the simulator as `-f <abs path>`; the simulator
# runs in the compile dir, so entries name files as $WORKSPACE/... (demo/soc).
# Macro header first (EDA load pattern; analysis gets it via define_headers).
+incdir+$WORKSPACE/dt
$WORKSPACE/rtl/soc_macros.svh
# Generated connect wrappers; the generated TB is excluded because this
# filelist supplies the C++ harness's own tb_top.
-f $WORKSPACE/rtl/soc.f
$WORKSPACE/rtl/gen/connect/sha256wb.sv
$WORKSPACE/rtl/gen/connect/sd_sha_ch.sv
$WORKSPACE/rtl/gen/connect/macro_width_probe.sv
$WORKSPACE/rtl/gen/connect/soc_top.sv

# Simulation-only harness
$WORKSPACE/dt/verilator/spiflash_vl.sv
$WORKSPACE/dt/verilator/tb_soc_vl.sv
