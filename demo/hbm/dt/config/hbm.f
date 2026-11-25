# HBM VCS + UVM-1.2 filelist. dtsim passes it as `-f <abs path>`; VCS runs in
# the compile dir, so every entry names its file as $WORKSPACE/... (the
# project root, demo/hbm).
+incdir+$WORKSPACE/dv/ral
+incdir+$WORKSPACE/dv/ral/bus
+incdir+$WORKSPACE/dt/uvm
-f $WORKSPACE/rtl/hbm.f
$WORKSPACE/dt/uvm/hbm_wb_if.sv
$WORKSPACE/dt/uvm/hbm_apb_if.sv
$WORKSPACE/dt/uvm/hbm_tb_pkg.sv
$WORKSPACE/dt/uvm/tb_top.sv
