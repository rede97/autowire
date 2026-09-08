# CLI 设计（hdxml）

> hdxml 是 autowire 的 RTL 分析 sidecar：无子命令，唯一功能即只读层级分析（导出 RtlIndex XML 目录）。
> 数据模型与 XML schema 见同目录 `module-info.md` / `rtlindex-xml.md`。

## 1. 全局选项

| 选项 | 默认 | 说明 |
|---|---|---|
| `-t, --threads N` | CPU 核数 | rayon 工作线程数 |
| `--stack-size MiB` | 16 | 工作线程栈（深语法树递归） |
| `-v, --verbose` | warn | 日志级别（`-v`=info, `-vv`=debug）；非 TTY 自动降级进度条为日志行 |
| `--log-file PATH` | 无 | 写日志文件；不给则仅终端 |

## 2. 输入组

| 选项 | 说明 |
|---|---|
| `-f, --filelist FILE...` | 列表（`.f` / `.lst` / `.flst` / `.list`；`#`/`//` 注释、`-f` 嵌套、`$ENV` 整段展开——按 `/` 分段，整段以 `$` 开头时替换）。**`.svh` 条目不识别**：直接跳过并给警告——宏头文件只能源内 `` `include `` 或 `--define-headers` 独立加载，保证与 EDA 行为一致（降级方案：EDA 用 `eda_load.f` 头部加载 svh，与分析器共享纯源码 `rtl.f`） |
| `-s, --sources FILE...` | 散文件 |
| `-w, --walk-dirs DIR...` | 递归收集 `*.sv/*.v` |
| `--exclude-filenames NAME...` | 按文件名（不含目录）排除 |
| `--exclude-dirs NAME...` | 按目录名排除（任一路径分量命中即排除整棵子树，如 `dv`/`tb`；三来源并集后统一过滤） |
| `-D, --defines NAME=VALUE...` | 宏定义；**无 `=VALUE` 时视为 `NAME=1`**（EDA 工具惯例，vcs/verilator 同） |
| `--define-headers FILE...` | 宏定义头文件（提取其中 `` `define ``，默认转哨兵保原文；替代 EDA「.f 头部 svh」全局宏）。按给定顺序预处理合并；**`-D` 先作种子**——header 内 `` `ifdef `` 可见 `-D` 宏，同名 header 宏随后又被 `-D` 压顶 |
| `--keep-raw NAME...` | 登记宏保原文（哨兵 `__MACRO__DEFINE__NAME`，`` `ifdef `` 判真，dump 时还原 `` `NAME ``）；覆盖 `-D` 同名 |
| `-I, --incdirs DIR...` | include 搜索路径（+incdir；列表类选项均可空格分隔多值） |

## 3. 用法

hdxml 无子命令——唯一功能即层级分析，参数平铺顶层：

```
hdxml [输入组] [--tree] [-o DIR] [--refresh] [--summary FILE] [--fail-on-undef] [--sub-bars]
```

| 选项 | 说明 |
| `-o, --output-dir DIR` | 导出 RtlIndex XML 目录：每源文件一个 XML（镜像源码相对路径命名；模块参数/端口/实例 + 文件级错误，含行列定位）+ `index.xml`（文件清单、模块→XML 映射、顶层 DAG 层级树）。失效产物按旧 manifest 自动 GC（`module-info.md` §5）。**有 `-o` 即增量**：未变更文件直接由上次产物重建声明、不再解析（mtime+size 快路径、blake3 内容哈希仲裁；`` `include `` 闭包逐成员校验；`tool`/`definesFp`/`incdirsFp` 全局闸门任一变化整库重解析；含错误或宏计算 include 的文件不可缓存每次重解析，详见 `module-info.md` §5）。不给 `-o` 则纯终端分析，零写盘 |
| `--refresh` | 无视缓存强制全量重解析并重写缓存（hdxml 行为变更而版本号未升的开发场景用） |
| `--summary FILE` | 写机器可读运行摘要（`key: value` 行：`files`/`modules`/`tops`/`blackbox`/`error_files`，有 `-o` 时追加 `reused`/`parsed`）；供脚本/CI 采集，即使存在错误文件（退出码 1）也会落盘 |
| `--tree` | 终端打印依赖树（termtree；黑盒标 `[blackbox]`） |
| `--fail-on-undef` | 存在黑盒模块时退出码 1（CI 用；默认黑盒仅列出） |

行为：读入 → DesignDb（单文件失败**不中止**，错误收入 `db.errors`）→ 打印摘要（模块/顶层/黑盒/错误文件数与逐条错误）→ 可选依赖树 → 可选 XML 导出。

退出码：0 正常；1 任一文件分析失败，或 `--fail-on-undef` 且存在黑盒（XML 仍先落盘）。

示例：

```bash
hdxml -f ibex.f -o out/rtlindex              # 增量分析并导出（二次运行秒回）
hdxml -w rtl/ -I rtl/include --tree         # 目录扫描 + 依赖树（零写盘）
```

## 4. 输入解析优先级与冲突

1. 三种输入来源并集去重（filelist / walk-dirs / sources）；canonicalize 后判重。
2. 模块重复定义：后者覆盖前者，并在该文件记入一条错误（退出码 1）。
