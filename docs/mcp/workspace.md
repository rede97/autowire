# 工作区 MCP（本地文件 / RtlIndex）

> 状态：**暂时不做**（2026-09-27）。这个阶段不实现节点级 HTML 编辑。Agent 通过 Playwright 操作 `connect web` 的活 DOM，再把可见源码保存到本地。索引检索用已落地的 `analysis search`、`analysis info`、`analysis deps`，不另做一套 MCP。  
> 总原则与双 MCP 分途：[`README.md`](./README.md)。  
> **禁止**在本 MCP 内实现 elaborate / 打印 RTL。需要 `.sv` 时走 `connect run`。页面只展示源码。

关键字「必须 / 应当 / 可以」按 RFC 2119。

## 1. 目的

在 **不糊工具边界** 的前提下，让 Agent 能：

1. **快速检索** `.autowire/hdxml`（及已有 connect 快照元数据）：模糊搜索、参数、端口、依赖、源文件路径。  
2. **触发** `autowire analysis` / 索引 **reload**（重新读盘，不偷偷 elaborate 连接）。  
3. **按节点** View / Edit 作者 HTML（`aw-content` 树）：列出、插入、删除、改属性，**自动格式化写回**——**禁止**以「文件行号」为唯一编辑模型。

面向：多层 `aw-submods`、多 `[connect.<id>]`、HTML 体积大到全文编辑失控的 SoC / IP。

## 2. 非目标（必须）

| 禁止 | 原因 |
|---|---|
| outline / apply / rewrite **连线一体机**（改完 MCP 内直接出网表） | 旧糊边界设计；见 `help dont` |
| 在本 MCP 内跑 aw.js elaborate 或写 `.sv` | 那是 **工具**路径（web / dump / cli） |
| 把 `.autowire/connect/` 快照当作者 SoT 编辑 | 快照是生成物；作者面只在 toml `html=` |
| 浏览器直写工作区 | 与 architecture 一致；dump 才写 RTL |
| 编辑后隐式 render/dump | 无显式 Web/工具调用则 **不**破坏、也 **不**更新运行时 |

不 Reload 索引、不跑 web：**磁盘上的作者修改可以存在，但调试页与网表不会变**——这是边界清晰的表现，不是缺陷。

## 3. 建议工具面（草案）

名称可调整；语义如下。

### 3.1 索引与工作区

| 工具 | 行为 |
|---|---|
| `rtlindex_search` | 模糊查模块 / 端口 / 参数名；返回路径、文件 XML 定位 |
| `rtlindex_module` | 按名取 params / ports / instances / 源路径（对齐 `/api/module`） |
| `rtlindex_deps` | 依赖树摘要（对齐 `analysis deps`） |
| `analysis_run` | 触发 `analysis run`（映射 toml→hdxml） |
| `index_reload` | 仅重新加载已有 `.autowire/hdxml` 进 MCP 侧缓存（不分析） |

缺失索引或 `definesFp` 过期 → **报错**并提示先 `analysis_run`（与 web 加载纪律一致）。

### 3.2 作者 HTML（节点模型）

定位键 **应当**是结构化路径，例如：

```text
connect-unit / aw-mod@name / aw-content / aw-insts / aw-inst@id
```

| 工具 | 行为 |
|---|---|
| `html_list` | 列出某父下子节点（标签、关键属性、`name`/`id`） |
| `html_get` | 取单节点属性与子摘要 |
| `html_insert` | 在父下插入合法 `aw-*`（或文本节点策略钉死） |
| `html_update` | 改属性；校验方言基本约束（dir、to 形态等可轻量） |
| `html_remove` | 删除节点 |
| `html_write` | 格式化写回 **作者文件**（toml `html=` 路径） |

纪律：

1. 只写 **`[connect.<id>] html=`** 指向的作者文件（及文档明确允许的附属文件）。  
2. 写回 **必须**格式化（缩进/换行稳定），便于 diff 与 Agent 复读。  
3. **可以**做轻量方言校验；完整合法性仍以 `autowire check` 为准。  
4. **禁止**直接改 `aw-render` 生成物或 dump 输出当编辑目标。

### 3.3 与 Web 的衔接（工具，非本 MCP 内嵌）

| 步骤 | 谁做 |
|---|---|
| Edit 作者 HTML | 本 MCP |
| check / elaborate | Agent **显式**调页面会话或 `connect check` / `connect run` |
| 看活 DOM | **A. Playwright MCP**（另一途径） |

本 MCP **可以**提供只读提示：`suggest_web_url`（拼 `?check=1` 等），但 **禁止**在同一工具调用里静默写 `.sv`。

## 4. 与 Playwright MCP 的协作

```text
B: html_update(inst) → 写盘
A: browser reload or GET ?elaborate=1 → 看 aw-render
A: session("run") → #aw-generated
工具: connect run → .sv
```

- A **不**把调试 DOM 写回作者 HTML，静态服务也没有保存端点。合回作者面由本地人工决定：浏览器下载，或 MCP 读取 `#aw-generated` 后自己存。

## 5. 实现提示（非规范）

- 优先复用现有：`loadRtlIndex`、`/api/*`、`autowire analysis`、HTML AST（与 check 同源解析更佳）。  
- MCP server **应当**只读/写工作区根内路径（与 web 同源安全策略对齐）。  
- 大型 HTML：list/get **应当**支持 depth / filter，避免一次吐整树。

## 6. 暂时不做

传输、节点路径语法、是否允许改 `aw-template` 内 rewrite、与插件 HTML 共用 Edit API：当前没有直接操作 HTML 节点的需求，全部搁置。有需求再打开本文并改 `help status`。
