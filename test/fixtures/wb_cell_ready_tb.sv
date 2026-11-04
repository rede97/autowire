module tb;
  localparam int PIPE = __PIPE__;
  logic clk=0;
  always #5 clk=~clk;
  logic rst_n=0, cyc=0, stb=0, we=0;
  logic [11:0] adr=0;
  logic [31:0] wdat=0, rdat;
  logic [3:0] sel=15;
  wire ack;
  logic ctrl_rdy=0, window_rdy=0, available=0;
  logic capture_strb=0;
  logic [7:0] capture_hwdata=0, sticky_set=0;
  wire [7:0] capture, sticky, value, companion;
  wire go, ext_wren, ext_rden;
  wire [7:0] ext_wdata;
  wire ext_wstrb;
  wire ext_ready = available && (ext_wren || ext_rden);
  int accepted=0, upstream=0, pulses=0, consumed=0;
  logic [31:0] response;
  logic left_ready=1, right_ready=0;
  wire left_wren, right_wren;
  wire [7:0] pair_value;
  int left_count=0, right_count=0;

  ready_bus_bus_cfg dut (
    .clk(clk), .rst_n(rst_n),
    .cfg_o_wb_adr(adr), .cfg_o_wb_dat(wdat), .cfg_o_wb_sel(sel),
    .cfg_o_wb_cyc(cyc), .cfg_o_wb_stb(stb), .cfg_o_wb_we(we),
    .cfg_i_wb_dat(rdat), .cfg_i_wb_ack(ack),
    .i_ctrl_rdy(ctrl_rdy), .i_window_rdy(window_rdy),
    .a_rg_capture(capture), .a_rg_capture_strb(capture_strb), .a_rg_capture_hwdata(capture_hwdata),
    .a_c_rg_sticky(sticky), .a_c_rg_sticky_set(sticky_set), .a_p_rg_go(go), .a_rg_value(value),
    .a_ext_data(8'h5a), .a_ext_data_wdata(ext_wdata), .a_ext_data_wstrb(ext_wstrb),
    .a_ext_data_wren(ext_wren), .a_ext_data_rden(ext_rden), .a_ext_data_rst(), .a_ext_data_ready(ext_ready),
    .a_rg_companion(companion), .a_ro_status(8'hc3),
    .a_ext_left(8'h11), .a_ext_left_wdata(), .a_ext_left_wstrb(), .a_ext_left_wren(left_wren),
    .a_ext_left_rden(), .a_ext_left_rst(), .a_ext_left_ready(left_ready),
    .a_ext_right(8'h22), .a_ext_right_wdata(), .a_ext_right_wstrb(), .a_ext_right_wren(right_wren),
    .a_ext_right_rden(), .a_ext_right_rst(), .a_ext_right_ready(right_ready), .a_rg_pair_value(pair_value),
    .b_ext_left(8'h0), .b_ext_left_wdata(), .b_ext_left_wstrb(), .b_ext_left_wren(),
    .b_ext_left_rden(), .b_ext_left_rst(), .b_ext_left_ready(1'b1),
    .b_ext_right(8'h0), .b_ext_right_wdata(), .b_ext_right_wstrb(), .b_ext_right_wren(),
    .b_ext_right_rden(), .b_ext_right_rst(), .b_ext_right_ready(1'b1), .b_rg_pair_value(),
    .b_rg_capture(), .b_rg_capture_strb(1'b0), .b_rg_capture_hwdata(8'h0),
    .b_c_rg_sticky(), .b_c_rg_sticky_set(8'h0), .b_p_rg_go(), .b_rg_value(),
    .b_ext_data(8'h0), .b_ext_data_wdata(), .b_ext_data_wstrb(), .b_ext_data_wren(), .b_ext_data_rden(),
    .b_ext_data_rst(), .b_ext_data_ready(1'b1), .b_rg_companion(), .b_ro_status(8'h96)
  );

  always @(posedge clk) if (rst_n) begin
    if (cyc && stb && ack) upstream++;
    if (go) pulses++;
    if (left_wren && left_ready) left_count++;
    if (right_wren && right_ready) right_count++;
    if (ext_wren && ext_ready) begin
      consumed++;
      if (!window_rdy || ext_wdata != 8'hb7 || !ext_wstrb) $fatal(1,"bad window acceptance");
    end
    if (dut.a_i_wb_cyc && dut.a_i_wb_stb && dut.a_o_wb_ack && dut.a_i_wb_we && dut.a_i_wb_adr == 0) begin
      if (!ctrl_rdy) $fatal(1,"accepted blocked cell");
      if (accepted < 3 && dut.a_i_wb_dat != (32'h11010120 + (32'h01000001 * accepted)))
        $fatal(1,"lost/reordered posted payload %h at %0d",dut.a_i_wb_dat,accepted);
      accepted++;
    end
  end

  task automatic transfer(input bit write_op, input logic [11:0] addr, input logic [31:0] data, input logic [3:0] lanes);
    @(negedge clk); cyc=1; stb=1; we=write_op; adr=addr; wdat=data; sel=lanes;
    do @(posedge clk); while (!ack);
    response=rdat;
    @(negedge clk); cyc=0; stb=0;
  endtask

  initial begin
    #2; rst_n=0;
    repeat(3) @(negedge clk);
    rst_n=1;
    transfer(0,16,0,15);
    if(response != 32'h42) $fatal(1,"ready affected another cell");
    transfer(0,28,0,15);
    if(response != 0) $fatal(1,"ready affected address miss");
    upstream=0;
    capture_strb=1; capture_hwdata=8'h77; sticky_set=8'h80;
    fork
      begin
        transfer(1,0,32'h11010120,15);
        transfer(1,0,32'h12010121,15);
        transfer(1,0,32'h13010122,15);
        transfer(0,0,0,15);
      end
      begin
        repeat(18) @(negedge clk);
        if (accepted != 0 || value != 0 || pulses != 0 || capture != 8'h77 || sticky != 8'h80)
          $fatal(1,"blocked side effects or lost hardware update");
        if (PIPE == 0 && upstream != 0) $fatal(1,"direct write early ACK");
        if (PIPE == 2 && upstream != 2) $fatal(1,"posted queue did not fill/backpressure: %0d",upstream);
        if (!cyc || ack) $fatal(1,"missing backpressure");
        ctrl_rdy=1;
      end
    join
    // RWW hardware wins idle cycles, but read immediately following each SW
    // acceptance is checked below with continuous hardware writes disabled.
    @(negedge clk); capture_strb=0; sticky_set=0;
    if (accepted != 3 || pulses != 3 || value != 8'h13 || sticky != 8'h80)
      $fatal(1,"incorrect drain/pulses/sticky %0d %0d %h %h",accepted,pulses,value,sticky);
    capture_strb=1; capture_hwdata=8'he1;
    fork
      transfer(1,0,32'h00008055,4'b0011);
      begin
        wait(dut.a_i_wb_stb && dut.a_o_wb_ack && dut.a_i_wb_we);
        @(posedge clk); #1;
        if(capture != 8'h55 || sticky != 0) $fatal(1,"SW priority or W1C clear incorrect");
        @(negedge clk); capture_strb=0;
      end
    join
    transfer(0,0,0,15);
    // Omitted W1C lane still accepts hardware set.
    sticky_set=8'h04;
    transfer(1,0,32'hff000000,4'b1000);
    transfer(0,0,0,15);
    if(sticky != 4 || value != 8'hff) $fatal(1,"byte mask or W1C set fallback");
    sticky_set=8'h01;
    transfer(1,0,32'h00000500,4'b0010);
    transfer(0,0,0,15);
    if(sticky != 1) $fatal(1,"W1C set did not win clear");
    @(negedge clk); sticky_set=0; ctrl_rdy=0;
    fork
      begin transfer(0,8,0,15); if(response != 32'hc3) $fatal(1,"bad delayed RO data"); end
      begin repeat(10) @(negedge clk); if(ack) $fatal(1,"read early ACK"); ctrl_rdy=1; end
    join
    // Alias b shares the same exported permission input.
    ctrl_rdy=0;
    fork
      begin transfer(0,12'h108,0,15); if(response != 32'h96) $fatal(1,"bad alias read"); end
      begin repeat(10) @(negedge clk); if(ack) $fatal(1,"alias bypassed ready"); ctrl_rdy=1; end
    join
    fork
      begin transfer(1,4,32'h00006ab7,15); transfer(0,4,0,15); end
      begin
        repeat(10) @(negedge clk);
        if(ext_wren || consumed || companion) $fatal(1,"window bypassed cell gate");
        window_rdy=1;
        repeat(10) @(negedge clk);
        if(!ext_wren || consumed || companion) $fatal(1,"RWE request/commit not separated");
        available=1;
      end
    join
    if(consumed != 1 || companion != 8'h6a || response != 32'h6a5a) $fatal(1,"RWE repeat or partial update");
    fork
      begin transfer(1,12,32'h00334455,15); transfer(0,12,0,15); end
      begin
        repeat(12) @(negedge clk);
        if(left_count || right_count || pair_value) $fatal(1,"partial multi-window consumption");
        right_ready=1;
      end
    join
    if(left_count != 1 || right_count != 1 || pair_value != 8'h33 || response != 32'h332211)
      $fatal(1,"multi-window acceptance mismatch");
    $display("CELL READY PASS pipe=%0d accepted=%0d pulses=%0d consumed=%0d",PIPE,accepted,pulses,consumed);
    $finish;
  end
  initial begin #20000; $fatal(1,"timeout"); end
endmodule
