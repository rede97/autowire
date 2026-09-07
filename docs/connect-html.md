# 连接 HTML 方言（实现约束）

> 状态：**草稿，先约束后实现**。禁止据此假装 `aw.js` / `web` / `dump` 已落地。  
> 摘要切片：`bun index.ts help connect`。改本文时同步改 help。  
> 关键字「必须 / 应当 / 可以」按 RFC 2119。  
> 示例：[`examples/connect/`](./examples/connect/)。

## 1. 目标与边界

连接描述是一份 **HTML + `<script type="module">`**。

| 阶段 | 名称 | 内容 |
|---|---|---|
| 输入 | **作者 HTML（源）** | 模块名 + 可选参数；例化 / 信号链接 / param **模板** |
| 输出 | **渲染后活 DOM（结果）** | 具体 instance、连线、导出端口（**生成物**） |

渲染（elaboration）= 浏览器跑 `aw.js`（Custom Elements）+ 页内 script。  
打印机、`/api/dump`、Playwright golden **必须**只认渲染后 DOM（或与之字节/结构等价的快照），**禁止**把作者源 HTML 原文当 netlist。

对齐：emacs Verilog-mode **心智**（rewrite 捕获、`@`、`[]`、AUTO 子集语义）。  
不对齐：emacs 进程、平行连接 IR、连接专用 MCP。

## 2. 两层，禁止混淆

1. 作者面写**模板**；结果面看**实例 / 端口 / 连线**。  
2. **禁止**把手写「已展开 XML/HTML」当作作者 SoT。  
3. `aw-rewrite` / AUTO 子集 **只存在于作者面**；渲染后 **必须**落成一条条 `aw-connect`。  
4. 叶子端口方向/位宽等补全 **必须**只读 RtlIndex（见 `docs/hdxml/rtlindex-xml.md`）；连接页 **禁止**改 RTL 源。

## 3. 作者面（模板）

### 3.1 层级

- 一份文件 **可以**嵌多层。
- `aw-mod`：正在编写的包装模块；子节点为嵌套 `aw-mod`（层次）或 `aw-inst`（例化）。
- 层次路径 = 自外向内 `aw-mod@name` 拼接。
- `aw-inst@id` 在**同一父路径下**必须唯一。

### 3.2 标签与属性（未冻结名字，但语义冻结）

标签小写；属性加引号。

| 标签 | 作用 | 关键属性 |
|---|---|---|
| `aw-mod` | 包装 / 层次 | `name`（模块名，必须） |
| `aw-param` | 参数模板 | `name`；`expr`（表达式或上层参数名，尚未求值） |
| `aw-inst` | 例化模板 | `id`（实例名）；`mod`（被例化模块） |
| `aw-connect` | 显式端口连接模板 | `port`（子端口）；`to`（本层信号名） |
| `aw-rewrite` | 端口名改写模板（批量） | `port`（匹配）；`to`（替换，可含捕获、`$1`、`[]`） |

`aw-param` **可以**挂在 `aw-mod`（本模参数）或 `aw-inst`（例化覆盖）上。

可选（草稿，实现前可改名）：

| 属性 / 约定 | 说明 |
|---|---|
| `aw-inst[data-template]` | 标记为「待 script clone 的模板」；渲染后模板节点本身 **应当**移除或标记为非 dump 目标 |
| 作者显式 `aw-port` | **可以**预声明导出端口；未写的 **可以**由 elaboration 推导 |

### 3.3 脚本

- 使用 `<script type="module">`，放在父 `aw-mod` 内。
- **可以** clone 例化模板、改 `id`、补 `aw-connect`。
- **必须**只用 DOM / `aw.*`；**禁止**依赖 layout；**禁止**对外 `fetch`。
- 脚本产出的节点是渲染结果的一部分（生成实例）。

### 3.4 可访问性

节点 **应当**带可访问名字（来自 `name` / `id`），便于 Playwright snapshot。

## 4. 渲染后面（生成物 / dump 输入）

`aw.js` + script 跑完后，活 DOM **必须**能直接读出 netlist 形状（概念上类似 elaborated XML）：

| 节点 | 来源 | 含义 |
|---|---|---|
| `aw-mod` | 保留 | 包装模块；`aw-param` **可以**带求值后的 `value` |
| `aw-port` | **生成**（或作者显式保留） | 本模导出端口：`name`、`dir`（`input`/`output`/`inout`）、可选 `width` |
| `aw-inst` | 保留 + **生成** | 每个具体实例（含 clone 后的真实 `id`） |
| `aw-param`（例化下） | 保留 / 求值 | 该例化最终参数（**应当**尽量已是 `value`） |
| `aw-connect` | 保留 + **生成** | 该例化每个已连接端口：`port` → 本层 net（`to`） |

内部 net 名由 `aw-connect@to` / 原 rewrite 结果推导即可；**不必**另引入 `aw-net`（若日后需要再加，属兼容扩展）。

渲染后 **禁止**再保留未展开的 `aw-rewrite` 作为 dump 语义来源（可删掉或忽略）。

## 5. Elaboration 顺序与总流水线

### 5.1 引擎顺序（语义冻结）

作者可在任意层写 `aw-connect` / `aw-rewrite`；**引擎**解析顺序 **必须**为：

1. **顶 → 底（param）**  
   自连接树根 `aw-mod` 向下绑定/求值 `aw-param`（`expr` → `value`，含例化覆盖）。  
   位宽、clone/`generate` 份数、端口是否存在等依赖参数的决策，**禁止**在 param 未绑定前做死。

2. **底 → 顶（连线）**  
   自叶子例化向上：用 RtlIndex 端口表展开 `aw-rewrite` → 逐条 `aw-connect`，汇总本层 net，推导或保留导出 `aw-port`。  
   父层导出端口是子连线的结果，与「渲染后才有 generated port/inst」一致。

边界：

- **宏 ≠ 模块 param**：`.svh` / `-D` 是 RtlIndex **前置条件**（见 [`workspace-toml.md`](./workspace-toml.md)）；`aw-param` 是连接树内绑定。  
- **连接顶不必是全芯片 RTL top**：HTML 可只包一个 wrap；对该子树内部仍按「param 向下、连线向上」。

### 5.2 端到端流水线

```text
autowire.toml（.f + svh/宏）
    →  hdxml → RtlIndex（只读）
    →  作者 HTML + script
    →  ① 顶→底 param  ② 底→顶连线（浏览器 / Playwright 中由 aw.js + script 完成）
    →  活 DOM = 连接关系（§4）
    →  POST /api/dump
    →  autowire 写 .sv
    →  DV
```

工作区配置约束：[`workspace-toml.md`](./workspace-toml.md)。

### 5.3 实现落地顺序（禁止跳步）

与 `help status` 一致：

1. `aw.js` + 约束自定义元素  
2. `autowire web` + `/api/dump`（及读取 `autowire.toml` / RtlIndex）  
3. Playwright 用例 / golden（同一作者 HTML → 同一 RTL）  
4. 才允许 `autowire cli`（必须被上述用例锁死）

## 6. 与 RtlIndex / 工作区配置的关系

- 分析用的 `.f`、宏、`.svh` **必须**来自同一份 [`autowire.toml`](./workspace-toml.md)（或与之等价且 `definesFp` 一致的显式覆盖）。  
- `aw-inst@mod` 对叶子模块时，端口表 **必须**来自 RtlIndex 只读查询。  
- 导出 `aw-port` 的 `dir` / `width` **应当**在可解析时与叶子端口或推导结果一致。  
- hdxml / RtlIndex **不**表达连接关系；连接 SoT 只有本方言 HTML。

## 7. 示例索引

| 文件 | 说明 |
|---|---|
| [`examples/connect/01-author-simple.html`](./examples/connect/01-author-simple.html) | 单层：param + 显式 connect + rewrite |
| [`examples/connect/01-rendered-simple.html`](./examples/connect/01-rendered-simple.html) | 上例渲染后**示意**形状（实现目标，非手写 SoT） |
| [`examples/connect/02-author-nested.html`](./examples/connect/02-author-nested.html) | 嵌套 `aw-mod` 表达层次 |
| [`examples/connect/03-author-template-clone.html`](./examples/connect/03-author-template-clone.html) | `data-template` + script 生成多实例 |
| [`examples/connect/03-rendered-template-clone.html`](./examples/connect/03-rendered-template-clone.html) | clone 后示意形状 |

## 8. 开放项（实现前裁定）

1. 导出端口：默认全推导，还是要求关键端口作者显式 `aw-port`？  
2. `data-template` 是否升为正式属性（如 `template`）？  
3. `aw-param@expr` → `value` 的求值范围（常量折叠 vs 原文透传进 SV）？  
4. dump 载荷：序列化 DOM 子树 vs 独立 JSON 快照（语义必须与 §4 同构）？  
5. 工作区 toml 的开放项见 [`workspace-toml.md`](./workspace-toml.md) §6。

裁定后改本文 + `help connect` / `help workspace`，再动代码。
