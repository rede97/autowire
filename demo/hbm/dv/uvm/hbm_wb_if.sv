// HBM demo UVM fabric: Wishbone Classic master face toward hbm_bus_cfg (cfg port).
// Fabric clock domain (800 MHz).

`ifndef HBM_WB_IF_SV
`define HBM_WB_IF_SV

interface hbm_wb_if (input logic clk, input logic rst_n);
	logic [18:0] adr;
	logic [31:0] dat_o; // master -> fabric (write data)
	logic [31:0] dat_i; // fabric -> master (read data)
	logic [3:0]  sel;
	logic        cyc;
	logic        stb;
	logic        we;
	logic        ack;
endinterface

`endif // HBM_WB_IF_SV
