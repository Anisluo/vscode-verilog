`timescale 1ns/1ps

// 4-entry, 8-bit synchronous FIFO. Requests are accepted on clk's rising edge.
module fifo_4x8 (
    input  wire       clk,
    input  wire       reset,
    input  wire       wr_en,
    input  wire       rd_en,
    input  wire [7:0] data_in,
    output reg  [7:0] data_out,
    output reg        rd_valid,
    output wire       empty,
    output wire       full,
    output reg  [2:0] used
);
    reg [7:0] storage [0:3];
    reg [1:0] wr_ptr;
    reg [1:0] rd_ptr;

    assign empty = (used == 3'd0);
    assign full  = (used == 3'd4);

    wire do_read;
    wire do_write;
    assign do_read  = rd_en && !empty;
    // A read frees a slot for a simultaneous write, even while full.
    // When empty, concurrent requests only enqueue; there is no bypass.
    assign do_write = wr_en && (!full || do_read);

    always @(posedge clk) begin
        if (reset) begin
            wr_ptr   <= 2'd0;
            rd_ptr   <= 2'd0;
            used     <= 3'd0;
            data_out <= 8'd0;
            rd_valid <= 1'b0;
        end else begin
            rd_valid <= do_read;
            if (do_read) begin
                data_out <= storage[rd_ptr];
                rd_ptr   <= rd_ptr + 2'd1;
            end
            if (do_write) begin
                storage[wr_ptr] <= data_in;
                wr_ptr          <= wr_ptr + 2'd1;
            end
            case ({do_write, do_read})
                2'b10: used <= used + 3'd1;
                2'b01: used <= used - 3'd1;
                default: ;
            endcase
        end
    end
endmodule
