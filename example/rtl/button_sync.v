module button_sync (
    input wire clk,
    input wire button,
    output wire pressed
);
    (* ASYNC_REG = "TRUE" *) reg [1:0] stages = 2'b11;
    always @(posedge clk)
        stages <= {stages[0], button};
    assign pressed = stages[1];
endmodule
