module tick_gen #(
    parameter CYCLES = 31250000
) (
    input wire clk,
    input wire reset,
    output wire tick
);
    reg [31:0] count = 0;
    assign tick = !reset && count == CYCLES - 1;

    always @(posedge clk) begin
        if (reset || tick)
            count <= 0;
        else
            count <= count + 1'b1;
    end
endmodule
