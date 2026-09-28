# Agent MCP 与工具边界

> 状态：**Playwright 调试已落地；工作区节点编辑暂时不做**（2026-09-27）。  
> 这个阶段 Agent 用浏览器 MCP 操作页面上的活 DOM，再把 `#aw-generated` 保存到本地。不需要直接改作者 HTML 节点的 MCP。  
> 核心原则：**工具**负责生成与流水线；**MCP**负责交互面，二者边界不得糊成「改完立刻出网表」。

关键字「必须 / 应当 / 可以」按 RFC 2119。

## 1. 根本原则：工具 vs MCP

| | **工具（Tooling）** | **MCP（交互面）** |
|---|---|---|
| 职责 | elaborate、check、`connect run`、analysis、打印机、`plugin wishbone run` | 让 Agent **查询 / 导航 / 编辑作者面 / 调试运行时** |
| 产出 | RtlIndex、`aw-render`、`.sv`、快照 | 不单独定义第二种网表语义 |
| 禁止 | 把 MCP 当成隐式 elaborate 引擎 | MCP 内「改节点 → 实时网表/RTL」一体机（旧 outline/apply/rewrite） |

流水线（工具）不变：

```text
作者 HTML / toml
  → analysis → RtlIndex
  → check → connect run → .sv
```

页面可以展示同一份源码，但不写文件。MCP **可以**触发工具（例如调用 `analysis run`、打开 `connect web`），但 **禁止**在 MCP 实现里重做一套连接语义。

## 2. 两条 MCP 途径（必须区分）

| | **A. 浏览器 MCP（Playwright）** | **B. 工作区 MCP（本地文件 / 索引）** |
|---|---|---|
| 业务场景 | 隔离调试工作区：活 DOM、`#aw-status`、按钮/GET 动作 | 大 HTML / 多单元：按节点 Edit；RtlIndex 模糊检索；analysis / reload |
| 作用面 | `127.0.0.1` 上的 `autowire connect web` 页 | 磁盘作者 HTML、`.autowire/hdxml`、工作区命令 |
| 与核心业务 | 核心 elaborate 在浏览器；本 MCP **只观察/驱动已隔离的页** | **不**在浏览器内生成；改的是源文件 |
| 出网表 / RTL | 页内 check→elaborate→`#aw-generated`；写盘是 `connect run` 或 MCP 自己存可见文本 | **必须**再显式走 `connect run`；仅 Edit **不**产生新网表 |
| 污染边界？ | 否：调试会话与作者 SoT 默认隔离 | 否：只动作者面；不 Reload/不跑 web 则运行时不变 |
| 状态 | **已落地**（开发 / CI：Playwright MCP + `.mcp.json`） | **暂时不做**。检索用 `analysis search` / `info` / `deps`。节点编辑等以后有需求再定 |

生产包里的调试浏览器目标是 obscura 自带的 `mcp` / `serve`（CDP，CentOS 7 兼容），不携带 Playwright。这是发布目标，不是当前开发配置。见 [`../dev/release.md`](../dev/release.md)。

旧禁令「connection-specific MCP」针对的是 **糊边界的一体机**（MCP 内完成连线生成），**不是**禁止 B，也不是禁止 A。

```text
        ┌─ A Playwright MCP ──▶ connect web 页（调试）──▶ check/elaborate/#aw-generated
Agent ──┤                                              └── 写盘：connect run，或 MCP 自存
        └─ B Workspace MCP ──▶ 作者 HTML / RtlIndex / analysis run
                                    │
                                    └─（需要结果时）再调 Web 工具路径
```

## 3. 大 SoC / 多层 IP

连接 HTML 膨胀后，Agent **难以**靠全文 + 行号维护。B 的节点级 View/Edit 与索引检索是 **文件/索引层** 能力，补的是可编辑性，不是第二条生成器。

A 仍用于「改完源之后，在页上看 elaborate 是否正确」。

## 4. 文档索引

| 文档 | 内容 |
|---|---|
| 本文 | 原则 + 两条途径总览 |
| [`workspace.md`](./workspace.md) | 工作区（本地）MCP：检索、analysis/reload、HTML 节点 Edit |
| [`../architecture.md`](../architecture.md) §3 | Playwright 隔离调试 |
| `help agent` / `help dont` | 摘要与禁令（禁止一体机，允许 A/B 分途） |

## 5. 暂时不做

1. B 的传输、节点路径语法、与插件 HTML 共用 Edit API：这个阶段没有直接改 HTML 节点的需求，不实现。  
2. ~~作者面写回是否允许「从 Playwright 会话导出到文件」~~ → **已裁定**：页面和静态服务都不写作者 HTML。Agent 驱动浏览器，人的保存或 MCP 读取 `#aw-generated` 后自己存到本地。`.sv` 只由 `connect run` 写。
