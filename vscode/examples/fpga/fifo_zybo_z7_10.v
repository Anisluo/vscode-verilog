`timescale 1ns/1ps

// Digilent Zybo Z7-10 demo. LED0 indicates pass; LED1 indicates failure.
module fifo_zybo_z7_10 (
    input wire sysclk,
    input wire reset_button,
    output reg led_pass = 1'b0,
    output reg led_fail = 1'b0
);
    (* ASYNC_REG = "TRUE" *) reg [1:0] reset_sync = 2'b11;
    always @(posedge sysclk)
        reset_sync <= {reset_sync[0], reset_button};

    reg [3:0] state = 0;
    wire [7:0] data_out;
    wire rd_valid;
    wire empty;
    wire [2:0] used;
    wire wr_en = state == 1 || state == 2;
    wire rd_en = state == 3 || state == 5;

    fifo_4x8 dut (
        .clk(sysclk), .reset(reset_sync[1]),
        .wr_en(wr_en), .rd_en(rd_en),
        .data_in(state == 1 ? 8'hA5 : 8'h3C),
        .data_out(data_out), .rd_valid(rd_valid), .empty(empty),
        .full(), .used(used)
    );

    always @(posedge sysclk) begin
        if (reset_sync[1]) begin
            state <= 0;
            led_pass <= 0;
            led_fail <= 0;
        end else begin
            case (state)
                0, 1, 2, 5: state <= state + 1'b1;
                3: begin
                    if (used != 2) led_fail <= 1;
                    state <= 4;
                end
                4: begin
                    if (!rd_valid || data_out != 8'hA5) led_fail <= 1;
                    state <= 5;
                end
                6: begin
                    if (rd_valid && data_out == 8'h3C && empty && used == 0 && !led_fail)
                        led_pass <= 1;
                    else
                        led_fail <= 1;
                    state <= 7;
                end
                default: state <= 7;
            endcase
        end
    end
endmodule
