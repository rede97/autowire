# Autowire 文档

统一放在本目录。Agent 接手以 `bun index.ts help agent` 为准；命令总览 `bun index.ts help`。**格式与实现约束**以本目录文档为准（改约定时同步改 help 摘要）。

## 总览

| 文档 | 内容 | 状态 |
|---|---|---|
| [architecture.md](./architecture.md) | 组件、流水线、MCP 双途径、入口阶段 | 草稿 |

## 连接方言 · [`connect/`](./connect/)

| 文档 | 内容 | 状态 |
|---|---|---|
| [connect/html.md](./connect/html.md) | 骨架 / dump / 多模与多 HTML | 已实现 |
| [connect/rules.md](./connect/rules.md) | template、rewrite、`inst_name`、param 折叠 | 已实现 |
| [connect/to-rules.md](./connect/to-rules.md) | `to`：net / const / open | 已实现 |
| [connect/lifecycle.md](./connect/lifecycle.md) | 生命周期钩子（高级） | 已实现 |
| [examples/connect/](./examples/connect/) | 作者面 + render 示意 | 草稿 |

## 工作区 · [`workspace/`](./workspace/)

| 文档 | 内容 | 状态 |
|---|---|---|
| [workspace/toml.md](./workspace/toml.md) | `autowire.toml`、`.f` / 宏、connect 单元 DAG | 已实现（cli 除外） |
| [workspace/web-ui.md](./workspace/web-ui.md) | `autowire web` 布局与 GET 动作 | 已实现 |

## 分析 sidecar · [`hdxml/`](./hdxml/)

| 文档 | 内容 | 状态 |
|---|---|---|
| [hdxml/rtlindex-xml.md](./hdxml/rtlindex-xml.md) | RtlIndex XML 契约 | 草案 |
| [hdxml/module-info.md](./hdxml/module-info.md) | DesignDb / 模块信息模型 | 已实现参考 |
| [hdxml/cli.md](./hdxml/cli.md) | hdxml `analysis` CLI | 已实现 |
| [hdxml/testing.md](./hdxml/testing.md) | fetch/scan/smoke 与错误基线 | 已实现 |

## Agent · [`mcp/`](./mcp/)

| 文档 | 内容 | 状态 |
|---|---|---|
| [mcp/](./mcp/) | 工具 vs MCP；Playwright vs 工作区 MCP | 草稿 |
| [mcp/workspace.md](./mcp/workspace.md) | 本地 Edit / RtlIndex 检索合同 | 草稿 |

## 并列插件 · [`plugins/`](./plugins/)

| 文档 | 内容 | 状态 |
|---|---|---|
| [plugins/](./plugins/) | 登记 / 自定义标签；生成器 vs 展开器 | 草稿 |
| [plugins/wishbone-regfile.md](./plugins/wishbone-regfile.md) | Wishbone regfile 叶子 | 草稿 |
| [plugins/wishbone-bus.md](./plugins/wishbone-bus.md) | 块内 cfg 树（非 SoC fabric） | 草稿 |

## 实战与报告

| 文档 | 内容 | 状态 |
|---|---|---|
| [skills/autowire-soc-integration.md](./skills/autowire-soc-integration.md) | demo/soc 集成 / 验证 / MCP 调试 | 草稿 |
| [reports/coverage-report.md](./reports/coverage-report.md) | Web 覆盖报告（2026-09-08） | 归档 |

## 不做

- 把连接关系写进 `autowire.toml`（toml 只做工程/RTL 宇宙配置）。
- 把 README 写成第二套约定却不改 `src/cli/help.ts` / 本目录约束文。
