// HBM demo UVM fabric: APB master face toward hbm_system (host port).
// APB clock domain (100 MHz PCLK), behind wb_apb2wb + wb_cdc inside the wrapper.

`ifndef HBM_APB_IF_SV
`define HBM_APB_IF_SV

interface hbm_apb_if (input logic pclk, input logic presetn);
	logic [18:0] paddr;
	logic        psel;
	logic        penable;
	logic        pwrite;
	logic [31:0] pwdata;
	logic [3:0]  pstrb;
	logic [2:0]  pprot;
	logic [31:0] prdata;
	logic        pready;
	logic        pslverr;
endinterface

`endif // HBM_APB_IF_SV
