# vscode-verilog

在 VS Code 中编辑 Verilog/SystemVerilog，并用工作台顶部的标签切换电路图、交互波形和诊断日志。工作台跟随 VS Code 的配色主题。

1. 在桌面版 VS Code 1.96 或更新版本中执行「从 VSIX 安装」，选择 Windows x64 的 VSIX 文件。Yosys、slang、ABC 和 Icarus Verilog 随包安装。
2. 使用自备工具时，可以在设置中指定 `verilogWorkbench.toolchainPath` 或 `verilogWorkbench.icarusPath`。
3. 在受信任的工作区打开 `.v` 或 `.sv`，执行 **Verilog: 打开综合工作台**，再点击 **Synthesis**。可切换 RTL 和门级电路图并查看诊断。波形和仿真回放在 Testbench 页使用。在波形图区滚动鼠标滚轮可按指针位置缩放，按住左键横向拖选可放大所选时间段，按住右键左右拖动可以平移波形。点击「信号 / 当前值」旁的「＋」，可搜索并添加观察信号。按住信号名或当前值上下拖动即可调整顺序。点击信号旁的格式按钮可切换 BIN、HEX 和十进制，32 位与 64 位信号也可切换 Real。VCD 原生 `real` 信号默认显示为 Real。在波形区按空格可恢复全程显示，拖动时间轴顶部的光标手柄可查看不同时间点的信号值。
4. 多文件设计可在 `verilogWorkbench.additionalSources` 中添加其他源文件。工作台读取 VS Code 中未保存的内容，语法诊断显示在编辑器和「问题」面板中。

执行 **Verilog: 打开 FIFO 示例** 可打开 Verilog-2005 写成的 4×8 同步 FIFO。点击 **Synthesis** 生成电路。用下面的 Testbench 功能观察复位、读写并行和指针回绕。

### FIFO 自动仿真

在 VS Code 中打开 `fifo_4x8.v` 或 `fifo_4x8_tb.v`，执行 **Verilog: 运行 Testbench**。扩展会识别同目录配对的 DUT 和 testbench，用 Icarus Verilog 执行行为仿真，并显示波形。切换到「电路图」可查看 DUT 方块及其端口，双击方块进入内部 RTL，点上方的 DUT 可返回。已记录的信号值随仿真光标更新。编译命令与 `PASS` 输出位于「诊断与日志」。如果命令找不到模拟器，在 `verilogWorkbench.icarusPath` 填入包含 `iverilog` 和 `vvp` 的目录。

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
