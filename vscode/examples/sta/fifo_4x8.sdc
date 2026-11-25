# Timing exercise for fifo_4x8 using the illustrative fifo_demo.lib.
create_clock -name fifo_clk -period 1.000 [get_ports clk]
set inputs [get_ports {reset wr_en rd_en data_in*}]
set_input_delay -clock fifo_clk -max 0.200 $inputs
set_input_delay -clock fifo_clk -min 0.060 $inputs
set_output_delay -clock fifo_clk -max 0.180 [all_outputs]
set_output_delay -clock fifo_clk -min -0.030 [all_outputs]
set_load 0.010 [all_outputs]
