// Filled by wishbone-broadcast.test.ts for each public fabric configuration.
module tb;
    localparam int DEPTH = __DEPTH__;
    localparam int MASTER_PIPE = __MASTER_PIPE__;
    bit clk = 0;
    always #5 clk = ~clk;
    logic rst_n = 0;
    logic [15:0] adr = 0;
    logic [31:0] wdata = 0, rdata;
    logic [1:0] tag = 0;
    logic cyc = 0, stb = 0, we = 0, ack;
    wire [15:0] s_adr [0:2];
    wire [31:0] s_wdata [0:2], s_rdata [0:2];
    wire [3:0] s_sel [0:2];
    wire [1:0] s_tag [0:2];
    wire s_cyc [0:2], s_stb [0:2], s_we [0:2], s_ack [0:2];
    int writes [0:2], reads [0:2], age [0:2];
    int delay_cycles [0:2];
    int stall_a = 0;
    int failures = 0;
    string scenario;

    __DUT__

    // ACK and DAT are sampled at the accepting rising edge. DAT changes after
    // every read acceptance, modeling a FIFO/read-to-clear side effect.
    for (genvar i = 0; i < 3; i++) begin : leaf
        assign s_ack[i] = rst_n && s_cyc[i] && s_stb[i]
            && age[i] >= delay_cycles[i] && (i != 0 || stall_a == 0);
        assign s_rdata[i] = (32'h1 << (i * 8)) << (reads[i] % 4);
        always @(posedge clk) begin
            if (!rst_n) begin
                writes[i] <= 0;
                reads[i] <= 0;
                age[i] <= 0;
            end else begin
                if (!s_cyc[i] || !s_stb[i] || s_ack[i]) age[i] <= 0;
                else age[i] <= age[i] + 1;
                if (s_cyc[i] && s_stb[i] && s_ack[i]) begin
                    if (s_we[i]) writes[i] <= writes[i] + 1;
                    else reads[i] <= reads[i] + 1;
                    if (s_adr[i] != 16'h24 || s_sel[i] != 4'hf
                        || s_tag[i] != 2'b10
                        || (s_we[i] && s_wdata[i] != 32'h12345678)) begin
                        $display("FAIL %s leaf %0d payload adr=%h tag=%h",
                            scenario, i, s_adr[i], s_tag[i]);
                        failures++;
                    end
                end
            end
        end
    end
    always @(posedge clk)
        if (stall_a > 0) stall_a <= stall_a - 1;

    task automatic check(input bit condition, input string message);
        if (!condition) begin
            $display("FAIL %s: %s (writes=%0d,%0d,%0d reads=%0d,%0d,%0d)",
                scenario, message, writes[0], writes[1], writes[2],
                reads[0], reads[1], reads[2]);
            failures++;
        end
    endtask

    task automatic reset_bus(input string name);
        @(negedge clk);
        rst_n = 0;
        cyc = 0;
        stb = 0;
        stall_a = 0;
        scenario = name;
        for (int i = 0; i < 3; i++) delay_cycles[i] = 0;
        repeat (4) @(negedge clk);
        rst_n = 1;
        @(negedge clk);
    endtask

    // Called on a falling edge, drives until ACK is sampled at a rising edge.
    // Returns on the next falling edge, allowing a new beat with no CYC gap.
    task automatic transfer(input bit write_op, input logic [15:0] address,
                            input logic [31:0] expected_data = 0);
        bit completed;
        completed = 0;
        adr = address;
        wdata = 32'h12345678;
        tag = 2'b10;
        we = write_op;
        cyc = 1;
        stb = 1;
        for (int cycle = 0; cycle < 240; cycle++) begin
            @(posedge clk);
            if (ack) begin
                completed = 1;
                if (!write_op)
                    check(rdata === expected_data,
                        $sformatf("read OR expected=%h actual=%h", expected_data, rdata));
                break;
            end
        end
        check(completed, "Classic transaction timed out");
        @(negedge clk);
        stb = 0;
    endtask

    task automatic drain;
        cyc = 0;
        stb = 0;
        // Posted traffic must carry its captured payload, not these live pins.
        tag = 2'b01;
        adr = 16'hdead;
        wdata = 32'hbad0bad0;
        repeat (100) @(negedge clk);
    endtask

    initial begin
        reset_bus("unequal occupancy posted write");
        // Fill all A stages with direct posted writes while B remains empty.
        // PIPE=0 has no queue: delay A at the leaf instead.
        stall_a = 70;
        for (int n = 0; n < DEPTH; n++) begin
            transfer(1, 16'h0024);
            repeat (DEPTH + 2) @(negedge clk);
        end
        check(writes[0] == 0 && writes[1] == 0, "preload must remain stalled");
        transfer(1, 16'h0224);
        drain();
        check(writes[0] == DEPTH + 1 && writes[1] == 1 && writes[2] == 0,
            "broadcast must be accepted exactly once by each subscriber");

        reset_bus("staggered read with changing DAT");
        delay_cycles[0] = 17;
        delay_cycles[1] = 1;
        transfer(0, 16'h0224, 32'h00000101);
        drain();
        check(reads[0] == 1 && reads[1] == 1 && reads[2] == 0,
            "read side effects must occur exactly once");

        reset_bus("consecutive broadcasts with maintained CYC");
        delay_cycles[0] = 9;
        delay_cycles[1] = 1;
        transfer(0, 16'h0224, 32'h00000101);
        transfer(0, 16'h0224, 32'h00000202);
        transfer(1, 16'h0224);
        transfer(1, 16'h0224);
        drain();
        check(reads[0] == 2 && reads[1] == 2 && writes[0] == 2 && writes[1] == 2,
            "completion state must clear between consecutive beats");

        reset_bus("maintained CYC switches target groups and preserves tags");
        transfer(0, 16'h0024, 32'h00000001);
        transfer(0, 16'h1024, 32'h00010000);
        transfer(0, 16'h0124, 32'h00000100);
        transfer(0, 16'h1024, 32'h00020000);
        drain();
        check(reads[0] == 1 && reads[1] == 1 && reads[2] == 2,
            "target changes must route every beat once");

        if (MASTER_PIPE > 0) begin
            reset_bus("posted master preserves inherited tag after upstream release");
            stall_a = 40;
            transfer(1, 16'h0024);
            check(writes[0] == 0, "master ACK must precede stalled leaf acceptance");
            drain();
            check(writes[0] == 1 && writes[1] == 0 && writes[2] == 0,
                "posted master must deliver exactly one captured request");
        end

        reset_bus("reset during pending broadcast read");
        stall_a = 200;
        adr = 16'h0224;
        tag = 2'b10;
        we = 0;
        cyc = 1;
        stb = 1;
        repeat (30) @(negedge clk);
        check(reads[1] > 0 && reads[0] == 0 && !ack,
            "reset setup requires one completed and one pending branch");
        reset_bus("fresh broadcast after reset");
        delay_cycles[1] = 11;
        transfer(0, 16'h0224, 32'h00000101);
        drain();
        check(reads[0] == 1 && reads[1] == 1, "reset must clear saved completion/data");

        if (failures != 0)
            $fatal(1, "FAIL broadcast behavior: %0d checks, pipe=%0d master_pipe=%0d",
                failures, DEPTH, MASTER_PIPE);
        $display("PASS broadcast behavior pipe=%0d master_pipe=%0d", DEPTH, MASTER_PIPE);
        $finish;
    end
    initial begin
        #200000;
        $fatal(1, "FAIL global watchdog");
    end
endmodule
