# vscode-verilog

在 VS Code 中编辑 Verilog/SystemVerilog，并用工作台顶部的标签切换电路图、交互波形和诊断日志。工作台跟随 VS Code 的配色主题。

1. 在桌面版 VS Code 1.96 或更新版本中执行「从 VSIX 安装」，选择 Windows x64 的 VSIX 文件。Yosys、slang、ABC 和 Icarus Verilog 随包安装。
2. 使用自备工具时，可以在设置中指定 `verilogWorkbench.toolchainPath` 或 `verilogWorkbench.icarusPath`。
3. 在受信任的工作区打开 `.v` 或 `.sv`，执行 **Verilog: 打开综合工作台**，再点击 **Synthesis**。可切换 RTL 和门级电路图并查看诊断。波形和仿真回放在 Testbench 页使用。在波形图区滚动鼠标滚轮可按指针位置缩放，按住左键横向拖选可放大所选时间段，按住右键左右拖动可以平移波形。点击「信号 / 当前值」旁的「＋」，可搜索并添加观察信号。按住信号名或当前值上下拖动即可调整顺序。点击信号旁的格式按钮可切换 BIN、HEX 和十进制，32 位与 64 位信号也可切换 Real。VCD 原生 `real` 信号默认显示为 Real。在波形区按空格可恢复全程显示，拖动时间轴顶部的光标手柄可查看不同时间点的信号值。
4. 多文件设计可在 `verilogWorkbench.additionalSources` 中添加其他源文件。工作台读取 VS Code 中未保存的内容，语法诊断显示在编辑器和「问题」面板中。

执行 **Verilog: 打开 FIFO 示例** 可打开 Verilog-2005 写成的 4×8 同步 FIFO。点击 **Synthesis** 生成电路。用下面的 Testbench 功能观察复位、读写并行和指针回绕。

### FIFO 自动仿真

在 VS Code 中打开 `fifo_4x8.v` 或 `fifo_4x8_tb.v`，执行 **Verilog: 运行 Testbench**。扩展会识别同目录配对的 DUT 和 testbench，用 Icarus Verilog 执行行为仿真，并显示波形。切换到「电路图」可查看 DUT 方块、外部时钟与输入输出信号的连线，双击方块进入内部 RTL，点上方的 DUT 可返回。已记录的信号值随仿真光标更新。编译命令与 `PASS` 输出位于「诊断与日志」。如果命令找不到模拟器，在 `verilogWorkbench.icarusPath` 填入包含 `iverilog` 和 `vvp` 的目录。

其他项目可使用 `模块名_tb.v` 或 `tb_模块名.v` 命名，`.sv` 同样适用。额外设计文件使用 `verilogWorkbench.additionalSources`，顶层模块名与文件名不同时可设置 `verilogWorkbench.testbenchTop`。Testbench 需使用 `$dumpfile` 和 `$dumpvars` 在仿真目录生成一个 VCD。

在仓库根目录用 [Icarus Verilog](https://steveicarus.github.io/iverilog/) 编译并运行配套 testbench。成功时会打印 `PASS`，并生成 `fifo_4x8_tb.vcd` 供波形查看器打开。

```sh
iverilog -g2005 -s fifo_4x8_tb -o fifo_4x8_tb.vvp vscode/examples/fifo_4x8.v vscode/examples/fifo_4x8_tb.v
vvp -N fifo_4x8_tb.vvp
```

工作台的「综合」使用 `fifo_4x8.v`。配套的 `fifo_4x8_tb.v` 用于独立的 HDL 仿真。

开发构建在仓库根目录运行 `npm ci`、`npm run typecheck` 和 `npm run build:vscode`。可用 `code --extensionDevelopmentPath=<仓库绝对路径>/vscode` 启动扩展开发宿主，或按项目首页说明打包带工具链的 VSIX。

扩展开发与维护由 [Anisluo](https://github.com/Anisluo) 负责。

完整安装步骤和当前版本的操作演示见 [项目首页](https://github.com/Anisluo/vscode-verilog#readme)。原始实现的版权归属见项目的 MIT 许可。

综合工作台的 **Target** 用来选择 ASIC（OpenSTA）或 Xilinx 7 系列 FPGA（openXC7）。扩展会记住当前工作区的选择。

## OpenSTA 静态时序分析

执行 **Verilog: 打开 FIFO 示例**，然后在综合工作台点击 **Run STA**。扩展用 Yosys 将 FIFO 映射到内置示例 Liberty，再按示例 SDC 调用 OpenSTA。**STA** 标签内显示 Setup 和 Hold 的最差 slack、路径明细与约束覆盖检查。示例使用 1 ns 时钟周期和教学用单元延迟模型，结果属于布局布线前的分析。

OpenSTA 需要单独安装。Windows 默认使用 WSL 的 `sta`（例如在 Debian 中执行 `sudo apt install opensta`），可用 `verilogWorkbench.staWslDistro` 指定发行版。也可用 `verilogWorkbench.staExecutable` 指定本机可执行文件的绝对路径。Linux 默认从 PATH 查找 `sta`。

分析自己的模块时，首次点击 **Run STA** 会提示选择缺少的 Liberty 和 SDC 文件。扩展会将选中的路径保存到当前工作区的 `verilogWorkbench.staLiberty` 和 `verilogWorkbench.staSdc`。两者可以使用绝对路径或相对于工作区的路径。SDC 应包含时钟与所需的 I/O 约束，并为自包含文件。检查报告中是否有未约束端点，再解读 slack。

## 生成 Xilinx 7 系列 FPGA 比特流

在 FPGA 目标下，点击 **Run STA** 可先运行 Yosys 和 nextpnr，查看目标器件布局布线后的时钟约束、Fmax 和关键路径。此操作只生成报告。**Build Bitstream** 会重新执行布局布线和时序检查，检查失败时停止生成 `.bit`。

在综合工作台将 **Target** 设为 **Xilinx 7 Series (openXC7)**，再点击 **Build Bitstream**，依次运行 Yosys、nextpnr-xilinx 和 openXC7 比特流工具。**Bitstream** 标签显示编译日志和 `.bit` 文件位置。

先解压 [openXC7 发布包](https://github.com/cavearr/toolchain-openxc7-releases/releases) 与该版本指定的 OSS CAD Suite。在 VS Code 设置中，将 `verilogWorkbench.fpgaToolchainPath` 和 `verilogWorkbench.fpgaYosysPath` 分别指向两个解压目录的根目录。Windows 使用 OSS CAD Suite 内的 Python。此流程使用工具包内已生成的器件数据库。

- **内置 FIFO 示例**。执行 **Verilog: 打开 FIFO 示例**，保留 FPGA 器件和 XDC 两项设置为空，然后点击 **Build Bitstream**。示例目标是 **Digilent Zybo Z7-10**（`xc7z010clg400-1`），时钟为 125 MHz。上板后 LED0 表示自检通过，LED1 表示失败，BTN0 重启自检。
- **自己的工程**。打开 FPGA 顶层源文件，设置 `verilogWorkbench.fpgaPart` 为器件、封装和速度等级的完整型号，把 XDC 放在顶层源码目录、工作区根目录或其中的 `constraints/`。存在多个候选时优先匹配顶层模块名或源码文件名。若无法唯一匹配，设置 `verilogWorkbench.fpgaXdc` 指定文件。XDC 应指定板卡引脚、I/O 标准和时钟周期。可通过 `additionalSources` 添加 HDL 文件。文件生成到工作区的 `build/`，单文件工程则生成到源码旁的 `build/`。

板卡约束依据 [Digilent Zybo Z7 主 XDC](https://github.com/Digilent/digilent-xdc/blob/master/Zybo-Z7-Master.xdc)。通过 J-Link 下载时，在 **Bitstream** 页点 **Detect J-Link** 扫描 JTAG 链。编译成功后点 **Program SRAM**，扩展会确认链上恰有一个与比特流目标匹配的 FPGA，并加载到 FPGA 的易失配置存储。

JTAG 功能使用 OSS CAD Suite 中启用了 J-Link 支持的 `openFPGALoader`。探针类型默认是 `jlink`（USB ID 1366:0105），也可以在 `verilogWorkbench.fpgaJtagCable` 选 `jlink_base`（1366:0101）。Windows 上探针的 JTAG USB 接口须可由 libusb 访问。
