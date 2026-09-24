# Windows 开发环境（MSYS2 UCRT64）

> 适用：在 Windows 上开发 / 跑测试 / 跑 demo/soc。Linux 与 macOS 不受本文约束。
> 通用约定仍以 `bun index.ts help agent` 与 [AGENTS.md](../../AGENTS.md) 为准；本文只规定 Windows 下**工具从哪来、怎么接进 PATH、行尾怎么处理**。

## 1. 分工：Windows 原生 vs UCRT64

| 工具 | 来源 | 用途 | 必需 |
|---|---|---|---|
| Bun | **Windows 原生**（`bun.sh` 安装器，默认 `%USERPROFILE%\.bun\bin`） | CLI / 测试 / 构建 | 是 |
| Biome | **Windows 原生**（`bun install` 自带 `@biomejs/cli-win32-x64`，MSVC 构建） | `bun run lint` | 是 |
| VC++ 2015+ x64 运行库 | **Windows 原生**（`winget install Microsoft.VCRedist.2015+.x64`） | Biome 依赖 `vcruntime140*.dll` / `msvcp140.dll` | 是 |
| Playwright Chromium | **Windows 原生**（`bunx playwright install chromium`） | e2e / Playwright MCP | 是 |
| Git | Git for Windows 或 MSYS2 `git` 均可 | — | 是 |
| Rust / cargo | **UCRT64** `mingw-w64-ucrt-x86_64-rust` | 构建 hdxml | 改 hdxml 时 |
| Verilator | **UCRT64** `mingw-w64-ucrt-x86_64-verilator` | 唯一仿真器：demo/soc 冒烟 + `bun test` RTL 仿真用例（`verilator_bin` + `mingw32-make`） | 否（缺则仿真用例 skip）；跑 demo 时是 |
| RISC-V GCC | **UCRT64** `mingw-w64-ucrt-x86_64-riscv32-unknown-elf-{gcc,newlib}` | demo/soc 固件 | 跑 demo 时 |
| Python / make | **UCRT64** `mingw-w64-ucrt-x86_64-{python,make}` | 固件 hex、镜像生成脚本 | 跑 demo 时 |
| Verible | 官方 GitHub Windows release（MSYS2 无包） | `hdxml/tests/smoke.ts` 交叉解析 | 否 |

## 2. 规则

1. **只用 UCRT64 环境**。MSYS2 包一律装 `mingw-w64-ucrt-x86_64-*`；bash 脚本在 **“MSYS2 UCRT64”** 终端里跑。**禁止**混装 MINGW64 / CLANG64 / MSYS 环境的同名工具（C 运行库不同，DLL 互相遮蔽）。
2. **不要用 MSYS2 里的 node / npm 替代 Bun**（仓库规则：一律 Bun）。Bun、Biome、Playwright 保持 Windows 原生。
3. **Windows PATH 只加 `C:\msys64\ucrt64\bin`**（用户 PATH）。PowerShell 里跑 `bun test` 时，`verilator_bin` / `mingw32-make` 等靠它被 `Bun.which` 找到；不加则相关用例被 skip。**禁止**把 `C:\msys64\usr\bin` 加进 Windows PATH（MSYS 版 bash / coreutils / find 会遮蔽系统命令，路径语义也不同）。
4. **UCRT64 终端要能找到 Windows 的 Bun**。二选一：
   - 在 `C:\msys64\ucrt64.ini` 打开 `MSYS2_PATH_TYPE=inherit`（继承 Windows PATH）；
   - 或在 `~/.bashrc` 加 `export PATH="$PATH:/c/Users/$USERNAME/.bun/bin"`。
5. **行尾一律 LF**。Git for Windows 默认在系统级设 `core.autocrlf=true`；仓库 `.gitattributes` 虽已 `* text=auto eol=lf`，仍须：

   ```powershell
   git config --global core.autocrlf false
   ```

   已经 checkout 成 CRLF 的工作区（`git ls-files --eol` 里出现 `w/crlf`），在**没有本地改动**的前提下重新 checkout 这些文件即可恢复；CRLF 工作区会让 golden 比对与 `web/` 新鲜度守卫全红。仓库里本身以 CRLF 存储的第三方 IP（`i/crlf`）不动。
6. **hdxml 在 UCRT64 终端构建**：`cd hdxml && cargo build --release`，产物 `hdxml/target/release/hdxml.exe` 只依赖系统 UCRT，可在 PowerShell 直接运行；autowire 自动查找 `hdxml/target/{release,debug}/hdxml(.exe)`，无需设 `HDXML_BIN`。
7. **RISC-V 前缀**：固件脚本默认探测含 `riscv32-unknown-elf-`，装 UCRT64 包后无需 `CROSS=`。
8. **写代码 / 测试时的路径纪律**：比较路径前先把 `\` 归一为 `/`（或用 `node:path` 的 `basename` / `join`）；toml 与文档里的路径写 `/`；需要外部工具的用例用 `Bun.which` 探测，缺失时 `test.skip`，不要报红。

## 3. 安装清单

```bash
# MSYS2 UCRT64 终端
pacman -S --needed \
  mingw-w64-ucrt-x86_64-rust \
  mingw-w64-ucrt-x86_64-verilator \
  mingw-w64-ucrt-x86_64-python \
  mingw-w64-ucrt-x86_64-make \
  mingw-w64-ucrt-x86_64-riscv32-unknown-elf-gcc \
  mingw-w64-ucrt-x86_64-riscv32-unknown-elf-newlib
```

```powershell
# PowerShell（Windows 原生部分）
winget install --id Microsoft.VCRedist.2015+.x64
bun install
bunx playwright install chromium
git config --global core.autocrlf false
```

## 4. 自检

```powershell
# 新开 PowerShell（PATH 已含 C:\msys64\ucrt64\bin）
verilator_bin --version
bun run lint      # Biome + tsc，零 error
bun test          # 无 fail；verilator 在 PATH 时无 skip
```
