`timescale 1ns/1ps

module fifo_4x8_tb;
    reg        clk;
    reg        reset;
    reg        wr_en;
    reg        rd_en;
    reg  [7:0] data_in;
    wire [7:0] data_out;
    wire       rd_valid;
    wire       empty;
    wire       full;
    wire [2:0] used;
    integer    checks;

    fifo_4x8 dut (
        .clk(clk), .reset(reset), .wr_en(wr_en), .rd_en(rd_en),
        .data_in(data_in), .data_out(data_out), .rd_valid(rd_valid),
        .empty(empty), .full(full), .used(used)
    );

    always #5 clk = ~clk;

    // Drive on the falling edge and sample after the rising-edge NBA updates.
    task step;
        input [8*40-1:0] scenario;
        input             reset_next;
        input             write_next;
        input             read_next;
        input [7:0]       write_data;
        input [2:0]       expected_used;
        input             expected_valid;
        input [7:0]       expected_data;
        begin
            @(negedge clk);
            reset   = reset_next;
            wr_en   = write_next;
            rd_en   = read_next;
            data_in = write_data;
            @(posedge clk);
            #1;
            if (used !== expected_used || rd_valid !== expected_valid ||
                data_out !== expected_data || empty !== (expected_used == 3'd0) ||
                full !== (expected_used == 3'd4)) begin
                $display("FAIL at %0t: %0s", $time, scenario);
                $display("  actual:   used=%0d valid=%b data=%02h empty=%b full=%b",
                         used, rd_valid, data_out, empty, full);
                $display("  expected: used=%0d valid=%b data=%02h empty=%b full=%b",
                         expected_used, expected_valid, expected_data,
                         expected_used == 3'd0, expected_used == 3'd4);
                $stop;
                $finish;
            end
            checks = checks + 1;
        end
    endtask

    initial begin
        clk = 0;
        reset = 1;
        wr_en = 0;
        rd_en = 0;
        data_in = 0;
        checks = 0;
        $dumpfile("fifo_4x8_tb.vcd");
        $dumpvars(0, fifo_4x8_tb);

        // Scenario, reset, write, read, input, expected occupancy, valid, output.
        step("reset",                  1, 0, 0, 8'h00, 0, 0, 8'h00);
        step("read while empty",       0, 0, 1, 8'h00, 0, 0, 8'h00);
        step("write A",                0, 1, 0, 8'hA1, 1, 0, 8'h00);
        step("write B",                0, 1, 0, 8'hB2, 2, 0, 8'h00);
        step("write C",                0, 1, 0, 8'hC3, 3, 0, 8'h00);
        step("write D and fill FIFO",   0, 1, 0, 8'hD4, 4, 0, 8'h00);
        step("reject write while full", 0, 1, 0, 8'hFF, 4, 0, 8'h00);
        step("full: read A, write E",  0, 1, 1, 8'hE5, 4, 1, 8'hA1);
        step("read B",                 0, 0, 1, 8'h00, 3, 1, 8'hB2);
        step("read C",                 0, 0, 1, 8'h00, 2, 1, 8'hC3);
        step("read D",                 0, 0, 1, 8'h00, 1, 1, 8'hD4);
        step("read E after wrap",      0, 0, 1, 8'h00, 0, 1, 8'hE5);
        step("empty: write F only",    0, 1, 1, 8'hF6, 1, 0, 8'hE5);
        step("read F",                 0, 0, 1, 8'h00, 0, 1, 8'hF6);
        step("queue data before reset", 0, 1, 0, 8'h77, 1, 0, 8'hF6);
        step("reset discards data",    1, 1, 1, 8'h88, 0, 0, 8'h00);
        step("read after reset",       0, 0, 1, 8'h00, 0, 0, 8'h00);

        $display("PASS: fifo_4x8 (%0d checks)", checks);
        $finish;
    end
endmodule
