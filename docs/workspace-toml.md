# 工作区配置 `autowire.toml`（实现约束）

> 状态：**部分实现**（`autowire init` / `autowire analysis` 已落地，见 `help analysis`）；web / dump 侧未实现。  
> 摘要切片：`bun index.ts help workspace`。改本文时同步改 help。  
> 关键字「必须 / 应当 / 可以」按 RFC 2119。  
> 关联：[`connect-html.md`](./connect-html.md)（连接 elaboration）、[`hdxml/cli.md`](./hdxml/cli.md)、[`hdxml/rtlindex-xml.md`](./hdxml/rtlindex-xml.md)。

## 1. 为什么要有一份顶层配置

`deps`、将来的 `web` / `cli`、RtlIndex 重建 **必须**共享同一套 RTL 宇宙：

- 源码入口（`.f` / 目录 / 散文件）
- 宏定义（`-D` 与 define `.svh`）
- include 路径等分析选项

RtlIndex 用 `definesFp` 把宏集合绑进索引有效性（见 `rtlindex-xml.md`）。宏或 filelist 不一致 ⇒ 端口表与连接页对不上。

因此工作区 **应当**有一份统一的顶层配置：**`autowire.toml`**（文件名固定；查找见 §3）。

## 2. 边界：工程配置 ≠ 连接 SoT

| 放进 `autowire.toml` | **禁止**放进 toml |
|---|---|
| 源码入口 `.f` / walk / sources | 连接关系、rewrite、例化模板 |
| 宏：`defines` 与 define `.svh`（对齐 hdxml `--define-headers`） | 生成 `.sv` 的逐端口细节 |
| `-I` incdirs、排除文件名等分析选项 | 平行模块 IR / 旧 stune `mods_info.toml` 缓存 |
| RtlIndex 索引目录（固定 `.autowire/hdxml`）、dump RTL 输出目录、连接 HTML 文件清单（仅路径） | HTML 方言本身 |

- 连接 SoT **只有** HTML（`connect-html.md`）。  
- 本文件是 **autowire 工程配置**：喂给 hdxml `analysis` 与连接页只读索引，**不是** hdxml 内部缓存格式的回归。

## 3. 查找与作用域

- 从 CWD（或显式 `--workspace`）向上查找 **`autowire.toml`**，找到的最近一份生效（草稿；实现时可再定是否禁止嵌套多份）。  
- 同一工作区内：`deps` / `web` / `cli` **必须**读同一份配置再谈 RtlIndex。  
- CLI 显式参数（若有）**可以**覆盖 toml 单项；覆盖后用于 analysis 的宏集合 **必须**与写入 / 校验的 `definesFp` 一致。

## 4. 配置项（schema 已冻结，init/analysis 按此实现）

对应 hdxml CLI 见 `docs/hdxml/cli.md`。

```toml
# hdxml 不读本文件：autowire analysis 负责把配置映射为 hdxml CLI 参数。

[hdxml]
# hdxml 二进制路径（相对本文件解析）。不设置 = 默认查找：
# --hdxml CLI > toml [hdxml] bin > $HDXML_BIN > 仓库 hdxml/target/{release,debug} > PATH
# bin = "hdxml/target/release/hdxml"

[analysis]
# 保原文宏（端口表达式保留 `NAME 原文，`ifdef 判真，dump 时还原；经 --keep-raw 传入）
keep_raw = ["WIDTH", "ENV_MACRO"]

[analysis.rtl]
# 三种来源可并存，并集去重（与 hdxml 输入组一致）
filelists = ["rtl/chip.f"]
walk_dirs = []
sources = []
incdirs = ["rtl/include"]  # include 搜索路径（+incdir）
exclude_filenames = []

[analysis.defines]
# 带值 = 展开（经 hdxml -D 传入）；保原文宏不写在这里，列入上方 keep_raw
SYNTHESIS = "1"

[analysis.index]
# RtlIndex XML 目录；固定在工作区生成临时目录 .autowire 下（见下方说明）
dir = ".autowire/hdxml"

[dump]
# dump 写出的 RTL 目录（产物，交给 DV；不放 .autowire）
dir = "gen"

[connect]
# 连接 HTML 文件清单（filelist 语义：仅路径数组；禁止 top、禁止任何连线细节）
html = ["connect/phy_wrap.html"]
```

说明：

- **hdxml 不读 toml**：`autowire analysis` 把 `[analysis.*]` 映射为 hdxml CLI 参数（映射表见 `help analysis`）；hdxml 侧只认 CLI 旗标。
- **`[hdxml] bin`** 只给 autowire 定位二进制用，**不**映射为 hdxml 参数；设置了但文件不存在 ⇒ analysis 直接报错（不静默回退）。未设置时按默认链查找，最终落到 PATH。  
- **宏集合** = `[analysis.defines]`（展开）+ `keep_raw`（保原文哨兵）；二者 **必须**进入 hdxml，并反映到 `index.xml` 的 `<defines>` / `definesFp`。覆盖顺序 `[analysis.defines]` → `keep_raw`。空串保原文约定已**废弃**（空串值直接报错）。哨兵机制与还原规则见 `hdxml/module-info.md` §3 / B-6。
- **宏作用域**：CLI/toml 宏作为 pre_defines 对**每个文件**一致生效（编译单元级种子）；各文件内 `` `define `` 不外泄（按文件独立预处理）。跨文件一致的宏**必须**走本表，禁止依赖文件间宏传递。
- **`[connect] html`** 只是连接页文件清单（路径数组，filelist 语义）；**禁止** `top` 及任何连线细节（连接 SoT 在 HTML 内）。  

- **`.autowire/`** 是工作区**生成临时目录**（索引等缓存），可整体删除重建；**禁止**放入手写内容或任何 SoT。dump RTL 是**产物**目录（默认 `gen/`），供 DV 使用，与临时目录分开。

- **`.svh` 不进 filelist**（hdxml 跳过并警告）：宏头文件只有两条合法路径——源内 `` `include ``（预处理）或 `define_headers`（独立加载，等价 EDA「.f 头部 svh」的全局宏）。降级方案：EDA 侧用 `eda_load.f`（头部 svh + 共享 `rtl.f`），分析器只用纯源码 `rtl.f`，两侧行为一致。  
## 5. 与 elaboration 的衔接（总流水线）

宏 ≠ 模块 `aw-param`。顺序 **必须**为：

```text
autowire.toml（.f + svh/宏 + incdir …）
    →  hdxml → RtlIndex（叶子端口/参数声明，只读）
    →  作者 HTML（aw-content + aw-submods）
    →  ① 顶→底 param  ② 展开 aw-template+patch  ③ 底→顶连线 → aw-render
    →  dump（读 aw-render）→ .sv → DV
```

细节见 [`connect-html.md`](./connect-html.md)。

## 6. 开放项（实现前裁定）

1. 多包/多 chip 是否允许多份 toml，还是单工作区单文件 + profile 表？

裁定后改本文 + `help workspace`，再动代码。
