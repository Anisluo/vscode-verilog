module top #(
    parameter TICK_CYCLES = 31250000
) (
    input wire clk,
    input wire reset_button,
    output wire [1:0] led
);
    wire reset;
    wire tick;
    button_sync sync (.clk(clk), .button(reset_button), .pressed(reset));
    tick_gen #(.CYCLES(TICK_CYCLES)) divider (.clk(clk), .reset(reset), .tick(tick));
    led_pattern pattern (.clk(clk), .reset(reset), .tick(tick), .led(led));
endmodule
