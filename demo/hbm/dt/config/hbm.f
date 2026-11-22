# HBM VCS + UVM-1.2 filelist. Paths are relative to the project root
# (demo/hbm): dtsim passes this list to the simulator as `-f <abs path>`
# with the project root as cwd.
+incdir+dv/ral
+incdir+dv/ral/bus
+incdir+dt/uvm
-f rtl/hbm.f
dt/uvm/hbm_wb_if.sv
dt/uvm/hbm_apb_if.sv
dt/uvm/hbm_tb_pkg.sv
dt/uvm/tb_top.sv
