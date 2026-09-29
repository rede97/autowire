// HBM demo UVM top: hbm_bus_cfg (interconnect + wb_apb2wb + wb_cdc) and
// 16 channel systems. Fabric 800 MHz, APB host 100 MHz.
// RO sidebands carry a deterministic per-channel pattern; train_pass_n lanes
// are driven from UVM (hbm_bcast_read_seq) via uvm_hdl_deposit.

`timescale 1ns/1ps

module tb_top;
	import uvm_pkg::*;
	import hbm_tb_pkg::*;

	logic clk  = 1'b0; // 800 MHz fabric
	logic pclk = 1'b0; // 100 MHz APB host
	logic rst_n   = 1'b0;
	logic presetn = 1'b0;
	logic rb_grant_en = 1'b1; // round-robin between cfg (WB) and host (APB)
	// Per-lane train status: bit[2*ch+dw]; 0 = lane passed. UVM-driven.
	logic [31:0] train_pass_n = 32'h0;

	always #0.625 clk  = ~clk;
	always #5.0   pclk = ~pclk;

	initial begin
		repeat (8) @(negedge clk);
		rst_n = 1'b1;
	end
	initial begin
		repeat (3) @(negedge pclk);
		presetn = 1'b1;
	end

	hbm_wb_if  wb_if  (.clk(clk),   .rst_n(rst_n));
	hbm_apb_if apb_if (.pclk(pclk), .presetn(presetn));

	// Fabric <-> channel nets
	logic [18:0] ch_adr  [16];
	logic [31:0] ch_wdat [16];
	logic [3:0]  ch_sel  [16];
	logic [1:0]  ch_tga  [16];
	logic        ch_cyc  [16];
	logic        ch_stb  [16];
	logic        ch_we   [16];
	logic [31:0] ch_rdat [16];
	logic        ch_ack  [16];

	// center CSR sidebands (CH_EN drives nothing in this TB; RO tied below)
	logic [15:0] center_enable;

	hbm_bus_cfg u_sys (
		.clk               (clk),
		.rst_n             (rst_n),
		.rb_grant_en       (rb_grant_en),
		.cfg_o_wb_adr      (wb_if.adr),
		.cfg_o_wb_dat      (wb_if.dat_o),
		.cfg_o_wb_sel      (wb_if.sel),
		.cfg_o_wb_cyc      (wb_if.cyc),
		.cfg_o_wb_stb      (wb_if.stb),
		.cfg_o_wb_we       (wb_if.we),
		.cfg_i_wb_dat      (wb_if.dat_i),
		.cfg_i_wb_ack      (wb_if.ack),
		.host_pclk         (apb_if.pclk),
		.host_presetn      (apb_if.presetn),
		.host_paddr        (apb_if.paddr),
		.host_psel         (apb_if.psel),
		.host_penable      (apb_if.penable),
		.host_pwrite       (apb_if.pwrite),
		.host_pwdata       (apb_if.pwdata),
		.host_pstrb        (apb_if.pstrb),
		.host_pprot        (apb_if.pprot),
		.host_prdata       (apb_if.prdata),
		.host_pready       (apb_if.pready),
		.host_pslverr      (apb_if.pslverr),
		.ch0_i_wb_adr       (ch_adr[0]),
		.ch0_i_wb_dat       (ch_wdat[0]),
		.ch0_i_wb_sel       (ch_sel[0]),
		.ch0_i_wb_tga_pstate(ch_tga[0]),
		.ch0_i_wb_cyc       (ch_cyc[0]),
		.ch0_i_wb_stb       (ch_stb[0]),
		.ch0_i_wb_we        (ch_we[0]),
		.ch0_o_wb_dat       (ch_rdat[0]),
		.ch0_o_wb_ack       (ch_ack[0]),
		.ch1_i_wb_adr       (ch_adr[1]),
		.ch1_i_wb_dat       (ch_wdat[1]),
		.ch1_i_wb_sel       (ch_sel[1]),
		.ch1_i_wb_tga_pstate(ch_tga[1]),
		.ch1_i_wb_cyc       (ch_cyc[1]),
		.ch1_i_wb_stb       (ch_stb[1]),
		.ch1_i_wb_we        (ch_we[1]),
		.ch1_o_wb_dat       (ch_rdat[1]),
		.ch1_o_wb_ack       (ch_ack[1]),
		.ch2_i_wb_adr       (ch_adr[2]),
		.ch2_i_wb_dat       (ch_wdat[2]),
		.ch2_i_wb_sel       (ch_sel[2]),
		.ch2_i_wb_tga_pstate(ch_tga[2]),
		.ch2_i_wb_cyc       (ch_cyc[2]),
		.ch2_i_wb_stb       (ch_stb[2]),
		.ch2_i_wb_we        (ch_we[2]),
		.ch2_o_wb_dat       (ch_rdat[2]),
		.ch2_o_wb_ack       (ch_ack[2]),
		.ch3_i_wb_adr       (ch_adr[3]),
		.ch3_i_wb_dat       (ch_wdat[3]),
		.ch3_i_wb_sel       (ch_sel[3]),
		.ch3_i_wb_tga_pstate(ch_tga[3]),
		.ch3_i_wb_cyc       (ch_cyc[3]),
		.ch3_i_wb_stb       (ch_stb[3]),
		.ch3_i_wb_we        (ch_we[3]),
		.ch3_o_wb_dat       (ch_rdat[3]),
		.ch3_o_wb_ack       (ch_ack[3]),
		.ch4_i_wb_adr       (ch_adr[4]),
		.ch4_i_wb_dat       (ch_wdat[4]),
		.ch4_i_wb_sel       (ch_sel[4]),
		.ch4_i_wb_tga_pstate(ch_tga[4]),
		.ch4_i_wb_cyc       (ch_cyc[4]),
		.ch4_i_wb_stb       (ch_stb[4]),
		.ch4_i_wb_we        (ch_we[4]),
		.ch4_o_wb_dat       (ch_rdat[4]),
		.ch4_o_wb_ack       (ch_ack[4]),
		.ch5_i_wb_adr       (ch_adr[5]),
		.ch5_i_wb_dat       (ch_wdat[5]),
		.ch5_i_wb_sel       (ch_sel[5]),
		.ch5_i_wb_tga_pstate(ch_tga[5]),
		.ch5_i_wb_cyc       (ch_cyc[5]),
		.ch5_i_wb_stb       (ch_stb[5]),
		.ch5_i_wb_we        (ch_we[5]),
		.ch5_o_wb_dat       (ch_rdat[5]),
		.ch5_o_wb_ack       (ch_ack[5]),
		.ch6_i_wb_adr       (ch_adr[6]),
		.ch6_i_wb_dat       (ch_wdat[6]),
		.ch6_i_wb_sel       (ch_sel[6]),
		.ch6_i_wb_tga_pstate(ch_tga[6]),
		.ch6_i_wb_cyc       (ch_cyc[6]),
		.ch6_i_wb_stb       (ch_stb[6]),
		.ch6_i_wb_we        (ch_we[6]),
		.ch6_o_wb_dat       (ch_rdat[6]),
		.ch6_o_wb_ack       (ch_ack[6]),
		.ch7_i_wb_adr       (ch_adr[7]),
		.ch7_i_wb_dat       (ch_wdat[7]),
		.ch7_i_wb_sel       (ch_sel[7]),
		.ch7_i_wb_tga_pstate(ch_tga[7]),
		.ch7_i_wb_cyc       (ch_cyc[7]),
		.ch7_i_wb_stb       (ch_stb[7]),
		.ch7_i_wb_we        (ch_we[7]),
		.ch7_o_wb_dat       (ch_rdat[7]),
		.ch7_o_wb_ack       (ch_ack[7]),
		.ch8_i_wb_adr       (ch_adr[8]),
		.ch8_i_wb_dat       (ch_wdat[8]),
		.ch8_i_wb_sel       (ch_sel[8]),
		.ch8_i_wb_tga_pstate(ch_tga[8]),
		.ch8_i_wb_cyc       (ch_cyc[8]),
		.ch8_i_wb_stb       (ch_stb[8]),
		.ch8_i_wb_we        (ch_we[8]),
		.ch8_o_wb_dat       (ch_rdat[8]),
		.ch8_o_wb_ack       (ch_ack[8]),
		.ch9_i_wb_adr       (ch_adr[9]),
		.ch9_i_wb_dat       (ch_wdat[9]),
		.ch9_i_wb_sel       (ch_sel[9]),
		.ch9_i_wb_tga_pstate(ch_tga[9]),
		.ch9_i_wb_cyc       (ch_cyc[9]),
		.ch9_i_wb_stb       (ch_stb[9]),
		.ch9_i_wb_we        (ch_we[9]),
		.ch9_o_wb_dat       (ch_rdat[9]),
		.ch9_o_wb_ack       (ch_ack[9]),
		.ch10_i_wb_adr       (ch_adr[10]),
		.ch10_i_wb_dat       (ch_wdat[10]),
		.ch10_i_wb_sel       (ch_sel[10]),
		.ch10_i_wb_tga_pstate(ch_tga[10]),
		.ch10_i_wb_cyc       (ch_cyc[10]),
		.ch10_i_wb_stb       (ch_stb[10]),
		.ch10_i_wb_we        (ch_we[10]),
		.ch10_o_wb_dat       (ch_rdat[10]),
		.ch10_o_wb_ack       (ch_ack[10]),
		.ch11_i_wb_adr       (ch_adr[11]),
		.ch11_i_wb_dat       (ch_wdat[11]),
		.ch11_i_wb_sel       (ch_sel[11]),
		.ch11_i_wb_tga_pstate(ch_tga[11]),
		.ch11_i_wb_cyc       (ch_cyc[11]),
		.ch11_i_wb_stb       (ch_stb[11]),
		.ch11_i_wb_we        (ch_we[11]),
		.ch11_o_wb_dat       (ch_rdat[11]),
		.ch11_o_wb_ack       (ch_ack[11]),
		.ch12_i_wb_adr       (ch_adr[12]),
		.ch12_i_wb_dat       (ch_wdat[12]),
		.ch12_i_wb_sel       (ch_sel[12]),
		.ch12_i_wb_tga_pstate(ch_tga[12]),
		.ch12_i_wb_cyc       (ch_cyc[12]),
		.ch12_i_wb_stb       (ch_stb[12]),
		.ch12_i_wb_we        (ch_we[12]),
		.ch12_o_wb_dat       (ch_rdat[12]),
		.ch12_o_wb_ack       (ch_ack[12]),
		.ch13_i_wb_adr       (ch_adr[13]),
		.ch13_i_wb_dat       (ch_wdat[13]),
		.ch13_i_wb_sel       (ch_sel[13]),
		.ch13_i_wb_tga_pstate(ch_tga[13]),
		.ch13_i_wb_cyc       (ch_cyc[13]),
		.ch13_i_wb_stb       (ch_stb[13]),
		.ch13_i_wb_we        (ch_we[13]),
		.ch13_o_wb_dat       (ch_rdat[13]),
		.ch13_o_wb_ack       (ch_ack[13]),
		.ch14_i_wb_adr       (ch_adr[14]),
		.ch14_i_wb_dat       (ch_wdat[14]),
		.ch14_i_wb_sel       (ch_sel[14]),
		.ch14_i_wb_tga_pstate(ch_tga[14]),
		.ch14_i_wb_cyc       (ch_cyc[14]),
		.ch14_i_wb_stb       (ch_stb[14]),
		.ch14_i_wb_we        (ch_we[14]),
		.ch14_o_wb_dat       (ch_rdat[14]),
		.ch14_o_wb_ack       (ch_ack[14]),
		.ch15_i_wb_adr       (ch_adr[15]),
		.ch15_i_wb_dat       (ch_wdat[15]),
		.ch15_i_wb_sel       (ch_sel[15]),
		.ch15_i_wb_tga_pstate(ch_tga[15]),
		.ch15_i_wb_cyc       (ch_cyc[15]),
		.ch15_i_wb_stb       (ch_stb[15]),
		.ch15_i_wb_we        (ch_we[15]),
		.ch15_o_wb_dat       (ch_rdat[15]),
		.ch15_o_wb_ack       (ch_ack[15]),
		// center CSR (attached leaf inside hbm_bus_cfg, offset 0x00000)
		.rg_enable           (center_enable),
		.ro_all_cal_done     (1'b1),
		.ro_err_ch           (4'h5)
	);

	for (genvar i = 0; i < 16; i++) begin : g_ch
		hbm_ch_bus_cfg u_ch (
			.clk                    (clk),
			.rst_n                  (rst_n),
			.i_wb_adr               (ch_adr[i][11:0]),
			.i_wb_dat               (ch_wdat[i]),
			.i_wb_sel               (ch_sel[i]),
			.i_wb_tga_pstate        (ch_tga[i]),
			.i_wb_cyc               (ch_cyc[i]),
			.i_wb_stb               (ch_stb[i]),
			.i_wb_we                (ch_we[i]),
			.o_wb_dat               (ch_rdat[i]),
			.o_wb_ack               (ch_ack[i]),
			// Deterministic per-channel RO pattern (wiring check)
			.ro_cal_done            (i[0]),
			.ro_err_code            (8'h40 + 8'(i)),
			.rg_trcd                (),
			.o_pstate_sel           (),
			.i_pstate_mux_sel       (2'b0),
			.rg_trp                 (),
			.rg_ca_drive            (),
			.dword0_ro_train_done   (i[1]),
			.dword0_ro_eye_width    (8'h80 + 8'(i)),
			.dword0_ro_train_pass_n (train_pass_n[2*i]),
			.dword0_rg_level        (),
			.dword0_o_pstate_sel    (),
			.dword0_i_pstate_mux_sel(2'b0),
			.dword0_rg_tap0         (),
			.dword0_rg_tap1         (),
			.dword1_ro_train_done   (~i[0]),
			.dword1_ro_eye_width    (8'hC0 + 8'(i)),
			.dword1_ro_train_pass_n (train_pass_n[2*i+1]),
			.dword1_rg_level        (),
			.dword1_o_pstate_sel    (),
			.dword1_i_pstate_mux_sel(2'b0),
			.dword1_rg_tap0         (),
			.dword1_rg_tap1         ()
		);
	end

	initial begin
		uvm_config_db #(virtual hbm_wb_if)::set(null, "uvm_test_top.env.wb_agt*", "vif", wb_if);
		uvm_config_db #(virtual hbm_apb_if)::set(null, "uvm_test_top.env.apb_agt*", "vif", apb_if);
		uvm_config_db #(virtual hbm_wb_if)::set(null, "uvm_test_top", "wb_vif", wb_if);
		uvm_config_db #(virtual hbm_apb_if)::set(null, "uvm_test_top", "apb_vif", apb_if);
		run_test();
	end
endmodule

