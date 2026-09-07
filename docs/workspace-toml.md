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
| RtlIndex 索引目录（固定 `.autowire/hdxml`）、dump RTL 输出目录、默认连接顶（可选） | HTML 方言本身 |

- 连接 SoT **只有** HTML（`connect-html.md`）。  
- 本文件是 **autowire 工程配置**：喂给 hdxml `analysis` 与连接页只读索引，**不是** hdxml 内部缓存格式的回归。

## 3. 查找与作用域

- 从 CWD（或显式 `--workspace`）向上查找 **`autowire.toml`**，找到的最近一份生效（草稿；实现时可再定是否禁止嵌套多份）。  
- 同一工作区内：`deps` / `web` / `cli` **必须**读同一份配置再谈 RtlIndex。  
- CLI 显式参数（若有）**可以**覆盖 toml 单项；覆盖后用于 analysis 的宏集合 **必须**与写入 / 校验的 `definesFp` 一致。

## 4. 配置项（schema 已冻结，init/analysis 按此实现）

对应 hdxml CLI 见 `docs/hdxml/cli.md`。

```toml
# 顶层键（必须在所有 [table] 之前）：

# 从头文件提取 `define（等价 --define-headers）；
# 默认保原文：头文件宏一律转哨兵不展开，需展开时用 [defines] 带值项覆盖同名
define_headers = ["rtl/include/project_defines.svh"]

# 额外保原文宏（未出现在 define_headers 中的名字，如环境宏）；与 [defines] 空串项并集，经 --keep-raw 传入
# keep_raw = ["ENV_MACRO"]

[rtl]
# 三种来源可并存，并集去重（与 hdxml 输入组一致）
filelists = ["rtl/chip.f"]
walk_dirs = []
sources = []
incdirs = ["rtl/include"]
exclude_filenames = []

[defines]
# 带值 = 展开（经 hdxml -D 传入）；空串 = 保原文（null 语义：TOML 无 null 字面量，空串即"登记不展开"）
SYNTHESIS = "1"
# WIDTH = ""   # 端口表达式保留 `WIDTH 原文

[index]
# RtlIndex XML 目录；固定在工作区生成临时目录 .autowire 下（见下方说明）
dir = ".autowire/hdxml"

[dump]
# dump 写出的 RTL 目录（产物，交给 DV；不放 .autowire）
dir = "gen"

[connect]
# 可选：默认作者 HTML / 连接树逻辑顶（不必是全芯片 RTL top）
# html = "connect/phy_wrap.html"
# top = "phy_wrap"
```

说明：

- **`define_headers`（.svh）** 与 **`[defines]`** 共同构成宏集合；二者 **必须**进入 hdxml，并反映到 `index.xml` 的 `<defines>` / `definesFp`。展开规则：**只有 `[defines]` 带值项真展开**；headers 宏与 `keep_raw`/空串项保原文（哨兵），覆盖顺序 headers → `[defines]` → `keep_raw`。  
- **`[defines]` 空串项 / `keep_raw`**（保原文宏）覆盖 `define_headers` 同名；哨兵机制与还原规则见 `hdxml/module-info.md` §3 / B-6。  
- **`[connect]`** 只点到 HTML 入口，**不**描述连线。

- **`.autowire/`** 是工作区**生成临时目录**（索引等缓存），可整体删除重建；**禁止**放入手写内容或任何 SoT。dump RTL 是**产物**目录（默认 `gen/`），供 DV 使用，与临时目录分开。

## 5. 与 elaboration 的衔接（总流水线）

宏 ≠ 模块 `aw-param`。顺序 **必须**为：

```text
autowire.toml（.f + svh/宏 + incdir …）
    →  hdxml analysis → RtlIndex（叶子端口/参数声明，只读）
    →  作者 HTML（aw-content + aw-submods）
    →  ① 顶→底 param  ② 展开 aw-template+patch  ③ 底→顶连线 → aw-render
    →  dump（读 aw-render）→ .sv → DV
```

细节见 [`connect-html.md`](./connect-html.md)。

## 6. 开放项（实现前裁定）

1. 多包/多 chip 是否允许多份 toml，还是单工作区单文件 + profile 表？  
2. `filelists` 与 CI 的 `.f` 是否要求符号链接/生成，避免双源？  
3. 配置变更后：自动失效并重建 RtlIndex，还是仅校验 `definesFp` 报错？  

裁定后改本文 + `help workspace`，再动代码。
