module led_pattern (
    input wire clk,
    input wire reset,
    input wire tick,
    output wire [1:0] led
);
    reg [1:0] phase = 0;

    always @(posedge clk) begin
        if (reset)
            phase <= 0;
        else if (tick)
            phase <= phase + 1'b1;
    end

    assign led = {phase[0] ^ phase[1], ~phase[1]};
endmodule
