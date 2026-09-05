# CLI 设计（hdxml）

> hdxml 是 autowire 的 RTL 分析 sidecar：唯一子命令 `analysis`（只读分析，导出 RtlIndex XML 目录）。
> 数据模型与 XML schema 见 `module-info.md`。

## 1. 全局选项（clap `global(true)`，子命令前后均可）

| 选项 | 默认 | 说明 |
|---|---|---|
| `-t, --threads N` | CPU 核数 | rayon 工作线程数 |
| `--stack-size MiB` | 16 | 工作线程栈（深语法树递归） |
| `-v, --verbose` | warn | 日志级别（`-v`=info, `-vv`=debug）；非 TTY 自动降级进度条为日志行 |
| `--log-file PATH` | 无 | 写日志文件；不给则仅终端 |

## 2. 输入组

| 选项 | 说明 |
|---|---|
| `-f, --filelist FILE...` | `.f` 列表（`#`/`//` 注释、`-f` 嵌套、`$ENV` 整段展开——按 `/` 分段，整段以 `$` 开头时替换） |
| `-s, --sources FILE...` | 散文件 |
| `-w, --walk-dirs DIR...` | 递归收集 `*.sv/*.v` |
| `--exclude-filenames NAME...` | 按文件名（不含目录）排除 |
| `-D, --defines NAME=VALUE...` | 宏定义；**无 `=VALUE` 时视为 `NAME=1`**（EDA 工具惯例，vcs/verilator 同） |
| `--define-headers FILE...` | 从头文件提取 `` `define ``（`SV_COV*` 过滤保留） |
| `-I, --incdirs DIR...` | include 搜索路径（+incdir；列表类选项均可空格分隔多值） |

## 3. `hdxml analysis` — 层级分析/导出

```
hdxml analysis [输入组] [--tree] [--xml DIR] [--fail-on-undef]
```

| 选项 | 说明 |
| `--xml DIR` | 导出 RtlIndex XML 目录：每源文件一个 XML（镜像源码相对路径命名；模块参数/端口/实例 + 文件级错误，含行列定位）+ `index.xml`（文件清单、模块→XML 映射、顶层 DAG 层级树）。失效产物按旧 manifest 自动 GC（`module-info.md` §5） |
| `--tree` | 终端打印依赖树（termtree；黑盒标 `[blackbox]`） |
| `--fail-on-undef` | 存在黑盒模块时退出码 1（CI 用；默认黑盒仅列出） |

行为：读入 → DesignDb（单文件失败**不中止**，错误收入 `db.errors`）→ 打印摘要（模块/顶层/黑盒/错误文件数与逐条错误）→ 可选依赖树 → 可选 XML 导出。

退出码：0 正常；1 任一文件分析失败，或 `--fail-on-undef` 且存在黑盒（XML 仍先落盘）。

示例：

```bash
hdxml analysis -f ibex.f --xml out/rtlindex          # 全量分析并导出 XML
hdxml analysis -w rtl/ -I rtl/include --tree         # 目录扫描 + 依赖树
```

## 4. 输入解析优先级与冲突

1. 三种输入来源并集去重（filelist / walk-dirs / sources）；canonicalize 后判重。
2. 模块重复定义：后者覆盖前者，并在该文件记入一条错误（退出码 1）。
