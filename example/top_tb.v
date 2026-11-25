`timescale 1ns/1ps
module top_tb;
    reg clk = 0;
    reg reset_button = 1;
    wire [1:0] led;
    top #(.TICK_CYCLES(3)) dut (.clk(clk), .reset_button(reset_button), .led(led));

    always #4 clk = ~clk;

    task expect_led;
        input [1:0] expected;
        begin
            if (led !== expected) begin
                $display("FAIL at %0t: led=%b, expected=%b", $time, led, expected);
                $fatal(1);
            end
        end
    endtask

    task expect_next;
        input [1:0] expected;
        begin
            repeat (3) @(negedge clk);
            expect_led(expected);
        end
    endtask

    initial begin
        $dumpfile("top_tb.vcd");
        $dumpvars(0, top_tb);
        repeat (4) @(negedge clk);
        expect_led(2'b01);
        reset_button = 0;
        repeat (2) @(negedge clk);
        expect_next(2'b11);
        expect_next(2'b10);
        expect_next(2'b00);
        expect_next(2'b01);
        expect_next(2'b11);
        reset_button = 1;
        repeat (3) @(negedge clk);
        expect_led(2'b01);
        $display("PASS: LED pattern advances, wraps and resets");
        $finish;
    end
endmodule
