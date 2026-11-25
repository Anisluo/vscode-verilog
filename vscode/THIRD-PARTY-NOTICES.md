# Bundled Windows tools

This extension uses third-party tools at runtime. The bundled versions and licenses are separate from the extension's MIT license.

- Yosys, yosys-slang, slang, ABC, and related libraries are supplied by the OSS CAD Suite distribution used for the package. Its license notices are under `tools/win32-x64/hdl/license`. The suite's build recipes and upstream sources are linked from [OSS CAD Suite](https://github.com/YosysHQ/oss-cad-suite-build).
- Icarus Verilog and its Windows runtime libraries are supplied by MSYS2 UCRT64. Their license notices are under `tools/win32-x64/icarus/share/licenses`. See the [Icarus Verilog source](https://github.com/steveicarus/iverilog/tree/v13_0) and [MSYS2 packaging sources](https://github.com/msys2/MINGW-packages).
