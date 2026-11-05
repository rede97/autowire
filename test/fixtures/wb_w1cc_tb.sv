// Generated leaf is connected by the TypeScript regression; no internal probes.
module tb;
    logic i_clk = 0;
    always #5 i_clk = ~i_clk;
    logic i_rst_n = 0, i_por_n = 0, i_gate = 1;
    logic [7:0] w1cc_i_wb_adr = 0;
    logic [31:0] w1cc_i_wb_dat = 0;
    logic [3:0] w1cc_i_wb_sel = 0;
    logic w1cc_i_wb_cyc = 0, w1cc_i_wb_stb = 0, w1cc_i_wb_we = 0;
    logic [1:0] w1cc_i_wb_tga_mux = 0, w1cc_i_wb_tga_raw = 0;
    wire w1cc_o_wb_ack;
    wire [31:0] w1cc_o_wb_dat;
    wire [15:0] c_rg_scalar;
    logic [15:0] c_rg_scalar_set = 0, c_rg_scalar_clr = 0;
    wire [7:0] c_rg_muxed;
    logic [7:0] c_rg_muxed_set = 0, c_rg_muxed_clr = 0;
    logic [1:0] i_mux_mux_sel = 0;
    wire [1:0] o_mux_sel, o_raw_sel;
    wire [7:0] c_rg_raw [4];
    logic [7:0] c_rg_raw_set [4], c_rg_raw_clr [4];
    wire c_rg_por, c_rg_legacy;
    logic c_rg_por_set = 0, c_rg_por_clr = 0, c_rg_legacy_set = 0;
    wire c_rg_mixed_conditional;
    logic c_rg_mixed_conditional_set = 0, c_rg_mixed_conditional_clr = 0;
    wire [7:0] rg_mixed_rw, rg_mixed_rww;
    logic rg_mixed_rww_strb = 0;
    logic [7:0] rg_mixed_rww_hwdata = 0;

    __DUT__

    task automatic check(input bit condition, input string message);
        if (!condition) $fatal(1, "W1CC FAIL: %s", message);
    endtask

    task automatic quiet_hw;
        c_rg_scalar_set = 0; c_rg_scalar_clr = 0;
        c_rg_muxed_set = 0; c_rg_muxed_clr = 0;
        c_rg_por_set = 0; c_rg_por_clr = 0; c_rg_legacy_set = 0;
        c_rg_mixed_conditional_set = 0; c_rg_mixed_conditional_clr = 0;
        rg_mixed_rww_strb = 0; rg_mixed_rww_hwdata = 0;
        for (int j = 0; j < 4; j++) begin
            c_rg_raw_set[j] = 0; c_rg_raw_clr[j] = 0;
        end
    endtask

    task automatic reset_all;
        quiet_hw();
        w1cc_i_wb_cyc = 0; w1cc_i_wb_stb = 0; w1cc_i_wb_we = 0;
        i_gate = 1; i_rst_n = 0; i_por_n = 0;
        repeat (2) @(negedge i_clk);
        i_rst_n = 1; i_por_n = 1;
        @(posedge i_clk); #1;
    endtask

    // Each call advances exactly one active edge and returns after NBA updates.
    // Callers drive HW at the previous return, so it is sampled only once.
    task automatic step(input bit request = 0, input bit writing = 0,
                        input logic [7:0] address = 0,
                        input logic [31:0] data = 0,
                        input logic [3:0] lanes = 4'hf,
                        input logic [1:0] tag = 0,
                        input bit accepted = 1);
        @(negedge i_clk);
        w1cc_i_wb_adr = address; w1cc_i_wb_dat = data;
        w1cc_i_wb_sel = lanes; w1cc_i_wb_we = writing;
        w1cc_i_wb_cyc = request; w1cc_i_wb_stb = request;
        w1cc_i_wb_tga_mux = tag; w1cc_i_wb_tga_raw = tag;
        #1;
        check(w1cc_o_wb_ack === (request && accepted), "ACK acceptance");
        @(posedge i_clk); #1;
    endtask

    task automatic read_word(input logic [7:0] address,
                             input logic [1:0] tag,
                             input logic [31:0] expected);
        quiet_hw();
        step(1, 0, address, 0, 4'hf, tag);
        check(w1cc_o_wb_dat === expected,
              $sformatf("read %h tag %d expected %h got %h", address, tag, expected, w1cc_o_wb_dat));
    endtask

    initial begin : tests
        bit expected;
        logic [15:0] old_word;
        // All 16 combinations, in each of 16 physical bits independently.
        for (int b = 0; b < 16; b++)
            for (int q = 0; q < 2; q++)
                for (int s = 0; s < 2; s++)
                    for (int c = 0; c < 2; c++)
                        for (int sw = 0; sw < 2; sw++) begin
                            reset_all();
                            c_rg_scalar_set = q ? (16'h1 << b) : 0;
                            step();
                            c_rg_scalar_set = s ? (16'h1 << b) : 0;
                            c_rg_scalar_clr = c ? (16'h1 << b) : 0;
                            step(sw != 0, 1, 0, 32'h1 << b);
                            expected = (q && !(sw || c)) || (!q && s);
                            check(c_rg_scalar === (expected ? (16'h1 << b) : 16'h0),
                                  $sformatf("truth bit=%0d q=%0d set=%0d clr=%0d sw=%0d", b,q,s,c,sw));
                        end

        // Mixed old bits catch a vector-wide ternary instead of per-bit logic.
        reset_all();
        c_rg_scalar_set = 16'ha5a5; step();
        old_word = c_rg_scalar;
        c_rg_scalar_set = 16'h0f0f; c_rg_scalar_clr = 16'h3333;
        step(1, 1, 0, 32'hf0f0);
        check(c_rg_scalar === ((old_word & ~(16'hf0f0 | 16'h3333)) |
                              (~old_word & 16'h0f0f)), "mixed vector arbitration");
        quiet_hw();
        c_rg_scalar_set = 16'hffff; c_rg_scalar_clr = 16'hffff;
        old_word = c_rg_scalar;
        repeat (4) begin
            step(); old_word = ~old_word;
            check(c_rg_scalar === old_word, "held set+clr toggles every bit each cycle");
        end

        // Independent byte lanes and the zero-lane fallback must retain HW.
        reset_all();
        c_rg_scalar_set = 16'hffff; step(); quiet_hw();
        step(1, 1, 0, 32'hffff, 4'b0001);
        check(c_rg_scalar === 16'hff00, "only low selected byte clears");
        c_rg_scalar_set = 16'h0005; c_rg_scalar_clr = 16'h8000;
        step(1, 1, 0, 32'hffff, 4'b0000);
        check(c_rg_scalar === 16'h7f05, "zero lanes preserve independent set and clear");
        quiet_hw(); c_rg_scalar_set = 16'h0002; c_rg_scalar_clr = 16'h0004;
        step(1, 1, 0, 32'hffff, 4'b0010);
        check(c_rg_scalar === 16'h0003, "high lane SW clear, low lane HW fallback");
        read_word(0, 0, 32'h3);
        // Inactive CYC/STB and read cycles cannot clear from live write data.
        quiet_hw(); step(0, 1, 0, 32'hffff);
        check(c_rg_scalar === 16'h3, "inactive request cannot clear");
        step(1, 0, 0, 32'hffff);
        check(c_rg_scalar === 16'h3, "read cannot clear");
        @(negedge i_clk); w1cc_i_wb_stb = 0; w1cc_i_wb_we = 1;
        @(posedge i_clk); #1;
        check(c_rg_scalar === 16'h3 && !w1cc_o_wb_ack, "CYC without STB cannot clear");

        // Hold one real write request through several blocked-ready edges.
        reset_all(); i_gate = 0;
        c_rg_scalar_set = 16'h3;
        step(1, 1, 0, 32'h1, 4'hf, 0, 0);
        check(c_rg_scalar === 16'h3, "blocked write still accepts HW set");
        quiet_hw(); c_rg_scalar_clr = 16'h2;
        step(1, 1, 0, 32'h1, 4'hf, 0, 0);
        check(c_rg_scalar === 16'h1, "blocked write still accepts HW clear");
        quiet_hw(); step(1, 1, 0, 32'h1, 4'hf, 0, 0);
        check(c_rg_scalar === 16'h1, "SW clear waits for acceptance");
        i_gate = 1; step(1, 1, 0, 32'h1);
        check(c_rg_scalar === 0, "SW clear commits when ready rises");

        // Mux copy is distinct from the SW tag; HW affects an unselected copy.
        reset_all();
        read_word(4, 0, 32'h10); read_word(4, 1, 32'h20);
        read_word(4, 2, 32'h40); read_word(4, 3, 32'h78);
        i_mux_mux_sel = 1; c_rg_muxed_set = 8'h01; c_rg_muxed_clr = 8'h20;
        step(1, 1, 4, 32'h10, 4'hf, 0);
        check(c_rg_muxed === 8'h01, "mux HW copy differs from SW copy");
        read_word(4, 0, 0); read_word(4, 1, 1);
        // Broadcast clears all copies but HW still addresses only copy 2.
        i_mux_mux_sel = 2; c_rg_muxed_set = 8'h80; c_rg_muxed_clr = 8'hff;
        step(1, 1, 4, 32'hff, 4'hf, 3);
        quiet_hw();
        // The mux inspection spans a clock edge; do not repeat the broadcast write.
        w1cc_i_wb_we = 0;
        for (int k = 0; k < 4; k++) begin
            i_mux_mux_sel = k[1:0]; #1;
            check(c_rg_muxed === ((k == 2) ? 8'h80 : 8'h00), "mux broadcast copy state");
        end
        read_word(4, 3, 32'h80);
        i_mux_mux_sel = 2; c_rg_muxed_set = 8'h02; c_rg_muxed_clr = 8'h80;
        step(1, 1, 4, 32'hff, 4'h0, 0);
        check(c_rg_muxed === 8'h02, "mux HW survives zero lanes and different SW target");
        quiet_hw(); c_rg_muxed_clr = 8'h02;
        step(1, 1, 0, 0);
        check(c_rg_muxed === 0, "mux HW runs while another cell is selected");
        quiet_hw(); c_rg_muxed_set = 8'h0f;
        step();
        c_rg_muxed_set = 8'hff; c_rg_muxed_clr = 8'hf0;
        step(1, 1, 4, 32'h0f, 4'hf, 2);
        check(c_rg_muxed === 8'hf0, "mux same-copy old ones clear and old zeros set");

        // Unmuxed arrays update every physical copy, not only the SW target.
        reset_all();
        c_rg_raw_set[0] = 8'h11; c_rg_raw_set[1] = 8'h22;
        c_rg_raw_set[2] = 8'h44; c_rg_raw_set[3] = 8'h88;
        step(); quiet_hw();
        c_rg_raw_set[1] = 8'h01; c_rg_raw_clr[1] = 8'h22;
        c_rg_raw_set[2] = 8'h80; c_rg_raw_clr[3] = 8'h08;
        step(1, 1, 8, 32'hff, 4'hf, 0);
        check(c_rg_raw[0] === 0 && c_rg_raw[1] === 8'h01 &&
              c_rg_raw[2] === 8'hc4 && c_rg_raw[3] === 8'h80, "per-copy HW ignores SW target");
        quiet_hw(); c_rg_raw_set[0] = 8'h02; c_rg_raw_clr[1] = 8'h01;
        step(1, 1, 8, 32'hff, 0, 2);
        check(c_rg_raw[0] === 2 && c_rg_raw[1] === 0 && c_rg_raw[2] === 8'hc4,
              "per-copy zero-lane fallback");
        quiet_hw(); c_rg_raw_set[0] = 8'h04; c_rg_raw_set[2] = 8'h01;
        c_rg_raw_clr[2] = 8'hff;
        step(1, 1, 8, 32'hff, 4'hf, 3);
        check(c_rg_raw[0] === 4 && c_rg_raw[1] === 0 &&
              c_rg_raw[2] === 1 && c_rg_raw[3] === 0, "per-copy broadcast arbitration");
        read_word(8, 3, 5);

        // A different async reset must preserve its own reset value and state.
        reset_all(); check(c_rg_por === 1, "nonzero independent reset value");
        step(1, 1, 8'h0c, 1); check(c_rg_por === 0, "POR software clear");
        quiet_hw(); step();
        @(negedge i_clk); i_rst_n = 0; #1;
        check(c_rg_por === 0, "fabric reset must not reset POR storage");
        c_rg_por_set = 1;
        @(posedge i_clk); #1;
        check(c_rg_por === 1, "POR HW continues during fabric reset");
        c_rg_por_set = 0; c_rg_por_clr = 1;
        @(posedge i_clk); #1; check(c_rg_por === 0, "POR hardware clear");
        c_rg_por_clr = 0;
        i_rst_n = 1; c_rg_scalar_set = 16'h55aa;
        step(); quiet_hw();
        @(negedge i_clk); i_por_n = 0; #1;
        check(c_rg_por === 1, "independent async reset restores reset value");
        check(c_rg_scalar === 16'h55aa, "independent reset leaves fabric-domain state unchanged");
        i_por_n = 1;

        reset_all(); c_rg_legacy_set = 1;
        step(); step(1, 1, 8'h10, 1);
        check(c_rg_legacy === 1, "legacy W1C set wins over SW clear");
        quiet_hw(); step(1, 1, 8'h10, 1);
        check(c_rg_legacy === 0, "legacy W1C clears without set");

        // Three storage groups in one cell retain independent arbitration.
        reset_all();
        c_rg_legacy_set = 1; c_rg_mixed_conditional_set = 1;
        rg_mixed_rww_strb = 1; rg_mixed_rww_hwdata = 8'ha5;
        step();
        check(c_rg_legacy && c_rg_mixed_conditional && rg_mixed_rww === 8'ha5,
              "mixed cell accepts independent hardware events");
        step(1, 1, 8'h10, 32'h005a3303);
        check(c_rg_legacy && !c_rg_mixed_conditional &&
              rg_mixed_rw === 8'h33 && rg_mixed_rww === 8'h5a,
              "W1C set wins, W1CC old one clears, RW/RWW accept software");
        c_rg_mixed_conditional_set = 0;
        step(1, 1, 8'h10, 32'h00ffff03, 4'h0);
        check(c_rg_legacy && !c_rg_mixed_conditional &&
              rg_mixed_rw === 8'h33 && rg_mixed_rww === 8'h5a,
              "zero lanes preserve sticky set and suppress software/RWW writes");
        quiet_hw(); rg_mixed_rww_strb = 0;
        step(1, 1, 8'h10, 1, 4'h1);
        check(!c_rg_legacy && rg_mixed_rw === 8'h33 && rg_mixed_rww === 8'h5a,
              "sticky clear leaves adjacent storage unchanged");
        $display("PASS W1CC RTL regression");
        $finish;
    end
    initial begin
        #300000;
        $fatal(1, "W1CC global watchdog");
    end
endmodule
