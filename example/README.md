# Zybo Z7-10 Verilog 示例

用 VS Code 打开此目录。工作区已设置 Xilinx 7 系列目标、器件 `xc7z010clg400-1` 和三个子模块的源码路径。FPGA 编译工具路径沿用 VS Code 用户设置。

- [top.v](top.v) 连接按键同步器、节拍发生器和 LED 图案状态机。LED 每 250 ms 按 `01 → 11 → 10 → 00` 循环，按 BTN0 返回初始状态。
- [top_tb.v](top_tb.v) 覆盖启动、循环和复位。打开它后执行 **Verilog: 运行 Testbench**，可查看 VCD 波形和 RTL 电路图。
- [constraints/top.xdc](constraints/top.xdc) 约束 125 MHz 系统时钟、BTN0、LED0 和 LED1。打开 `top.v` 后执行 **Verilog: 打开综合工作台**，再点 **Run STA** 或 **Build Bitstream**。扩展会自动找到该 XDC。

板卡引脚依据 [Digilent Zybo Z7 主 XDC](https://github.com/Digilent/digilent-xdc/blob/master/Zybo-Z7-Master.xdc)。
