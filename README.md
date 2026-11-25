# vscode-verilog

在 VS Code 里编辑、综合和调试 Verilog/SystemVerilog。工作台提供 RTL 与门级电路图、交互式四态波形和实时诊断，界面跟随 VS Code 的当前主题。

![VS Code 中打开 FIFO 示例，切换电路图与波形、缩放波形、添加信号并查看综合日志](docs/media/vscode-verilog-demo.gif)

## 安装 VS Code 扩展

**[下载 0.2.4 单文件 VSIX（Windows x64）](https://github.com/Anisluo/vscode-verilog/releases/download/v0.2.4/verilog-workbench-win32-x64-0.2.4.vsix)**

Windows x64 只需下载上面这一个文件。在桌面版 VS Code 1.96 或更新版本中，按 `Ctrl+Shift+P`，执行 **Extensions: Install from VSIX…**（从 VSIX 安装），选中该文件。Yosys、slang、ABC 和 Icarus Verilog 随扩展安装，无需配置 PATH 或工具路径。

## 打开工作台

- **试用内置示例**：在受信任的 VS Code 窗口按 `Ctrl+Shift+P`，执行 **Verilog: 打开 FIFO 示例**。左侧打开 [4×8 同步 FIFO 的纯 Verilog 源码](vscode/examples/fifo_4x8.v)，右侧打开综合工作台，点击 **Synthesis** 开始综合。
- **打开自己的设计**：在受信任的工作区打开 `.v` 或 `.sv` 文件，执行 **Verilog: 打开综合工作台**，再点击 **Synthesis**。多文件设计路径可写入 `verilogWorkbench.additionalSources`，相对路径以工作区根目录为准。综合和语法检查会读取已打开文件中的未保存内容。

综合时界面显示阶段和已用时间，并保留上一次可用的电路图。公开版 0.2.4 的对应命令为「Verilog: 综合并打开工作台」，会直接开始综合。

综合工作台提供 **电路图** 和 **诊断与日志**，支持切换 RTL 与门级。波形和仿真回放位于 Testbench 工作台。语法诊断也会显示在 VS Code 的「问题」面板。

## 查看和编辑波形

切到「波形」，点击「信号 / 当前值」旁的 **＋**，搜索并勾选需要观察的信号。按住左侧信号名或当前值上下拖动，可调整波形顺序。点击信号当前值旁的格式按钮，可切换 BIN、HEX、无符号十进制或有符号十进制。32 位和 64 位信号还支持按 IEEE 754 显示为 Real，VCD 中的原生 `real` 信号默认以 Real 显示。

| 操作 | 效果 |
| --- | --- |
| 鼠标滚轮 | 以指针所在时间为中心缩放 |
| 左键横向拖选 | 放大选中的时间段，整列波形随之缩放 |
| 右键拖动 | 左右平移，保持当前缩放比例 |
| 空格 | 在波形区恢复全程显示 |
| 左键单击 | 移动仿真光标 |
| 拖动时间轴上的光标手柄 | 连续移动光标，靠近信号跳变时自动吸附 |

## FIFO 示例与自动仿真

FIFO Testbench 会自动执行复位、写入、读出和满空边界检查。波形页可观察 `used`、`empty`、`full`、`rd_valid` 和 `data_out`。

在 VS Code 中打开 `fifo_4x8.v` 或 `fifo_4x8_tb.v`，执行 **Verilog: 运行 Testbench**。扩展会识别同目录配对的 DUT 和 testbench，用 Icarus Verilog 执行行为仿真，并显示波形。切换到「电路图」可查看被测模块的 RTL，已记录的信号值随仿真光标更新。编译命令与 `PASS` 输出位于「诊断与日志」。需要使用自备版本时，可用 `verilogWorkbench.icarusPath` 指定包含 `iverilog` 和 `vvp` 的目录。

其他项目可使用 `模块名_tb.v` 或 `tb_模块名.v` 命名，`.sv` 同样适用。额外设计文件使用 `verilogWorkbench.additionalSources`，顶层模块名与文件名不同时可设置 `verilogWorkbench.testbenchTop`。Testbench 需使用 `$dumpfile` 和 `$dumpvars` 在仿真目录生成一个 VCD。

配套的 [testbench](vscode/examples/fifo_4x8_tb.v) 使用 [Icarus Verilog](https://steveicarus.github.io/iverilog/) 单独运行。在仓库根目录执行下面的命令，成功时会输出 `PASS` 并生成 `fifo_4x8_tb.vcd`。

```sh
iverilog -g2005 -s fifo_4x8_tb -o fifo_4x8_tb.vvp vscode/examples/fifo_4x8.v vscode/examples/fifo_4x8_tb.v
vvp -N fifo_4x8_tb.vvp
```

## 开发

```sh
npm ci
npm run typecheck
npm test
npm run build:vscode
```

`npm test` 需要已配置的 HDL 工具链。要在扩展开发宿主中调试，可从仓库根目录运行 `code --extensionDevelopmentPath="<仓库绝对路径>/vscode"`。

在 Windows x64 上生成带工具链的安装包时，准备带 Yosys、yosys-slang、slang 和 ABC 的 Windows 工具链，以及 Icarus Verilog Windows 分发目录。打包会保留这两个分发目录的许可证文件。运行以下命令后，在 `release/` 中取得单文件 VSIX。

```powershell
npm run package:vscode -- --hdl-root "C:/HDLTools" --icarus-root "C:/msys64/ucrt64"
```

由 [Anisluo](https://github.com/Anisluo) 开发和维护。原始实现的版权归属和许可详见 [MIT License](LICENSE)。
