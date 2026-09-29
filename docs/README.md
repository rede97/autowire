# Autowire 文档

统一放在本目录。Agent 接手以 `bun index.ts help agent` 为准；命令总览 `bun index.ts help`。**格式与实现约束**以本目录文档为准（改约定时同步改 help 摘要）。

## 总览

| 文档 | 内容 | 状态 |
|---|---|---|
| [architecture.md](./architecture.md) | 组件、流水线、MCP 双途径、入口阶段 | 已实现；生产包与类型 B 暂时不做 |
| [cli.md](./cli.md) | 命令形状：connect 是标准；每个插件自己的 `run` | 已落地 |

## 连接方言 · [`connect/`](./connect/)

| 文档 | 内容 | 状态 |
|---|---|---|
| [connect/html.md](./connect/html.md) | 骨架 / dump / 多模与多 HTML / identity | 已实现 |
| [connect/rules.md](./connect/rules.md) | template、rewrite、`inst_name`、param 折叠 | 已实现 |
| [connect/to-rules.md](./connect/to-rules.md) | `to`：net / const / open；identity | 已实现 |
| [connect/check.md](./connect/check.md) | check vs elaborate vs dump 职责清单 | 已实现 |
| [connect/lifecycle.md](./connect/lifecycle.md) | 生命周期钩子（高级） | 已实现 |
| [connect/tb-mod.md](./connect/tb-mod.md) | TB 顶层 `aw-tb-mod` / raw / include | **已落地** |
| [examples/connect/](./examples/connect/) | 作者面 + render 示意 | 草稿 |

## 工作区 · [`workspace/`](./workspace/)

| 文档 | 内容 | 状态 |
|---|---|---|
| [workspace/toml.md](./workspace/toml.md) | `autowire.toml`、三分产物目录、`[connect.*]` / `[sim.*]` | 已实现 |
| [workspace/web-ui.md](./workspace/web-ui.md) | `connect web` 布局与 GET 动作；页面不写盘 | 已实现 |

## 分析 sidecar · [`hdxml/`](./hdxml/)

| 文档 | 内容 | 状态 |
|---|---|---|
| [hdxml/rtlindex-xml.md](./hdxml/rtlindex-xml.md) | RtlIndex XML 契约 | 分析器已按此产出 |
| [hdxml/module-info.md](./hdxml/module-info.md) | DesignDb / 模块信息模型 | 已实现参考 |
| [hdxml/cli.md](./hdxml/cli.md) | hdxml `analysis` CLI | 已实现 |
| [hdxml/testing.md](./hdxml/testing.md) | fetch/scan/smoke 与错误基线 | 已实现 |

## Agent · [`mcp/`](./mcp/)

| 文档 | 内容 | 状态 |
|---|---|---|
| [mcp/](./mcp/) | 工具 vs MCP；Playwright 已落地 | 工作区节点编辑暂时不做 |
| [mcp/workspace.md](./mcp/workspace.md) | 直接改 HTML 节点的合同 | 暂时不做；检索用 analysis 子命令 |

## 并列插件 · [`plugins/`](./plugins/)

| 文档 | 内容 | 状态 |
|---|---|---|
| [plugins/](./plugins/) | 类型 A 已落地；类型 B 展开 `aw-*` 暂时不做 | 类型 A 已落地 |
| [plugins/wishbone-regfile.md](./plugins/wishbone-regfile.md) | Wishbone regfile；SoT=TS `RegfileDef`；connect 用 `aw-inst` | 已落地 |
| [plugins/wishbone-bus.md](./plugins/wishbone-bus.md) | 块内 cfg 树；开放项暂时不动 | 已落地 |
| [plugins/wishbone-master.md](./plugins/wishbone-master.md) | Master 口：CDC / APB / JTAG；开放项暂时不动 | 已落地 |
| [examples/regfile/](./examples/regfile/) | Wishbone regfile 作者面 TS + 生成 SV 展示 | 示例 |

## 开发环境 · [`dev/`](./dev/)

| 文档 | 内容 | 状态 |
|---|---|---|
| [dev/windows-msys2.md](./dev/windows-msys2.md) | Windows：MSYS2 UCRT64 工具链、PATH、LF 行尾、原生 vs UCRT64 分工 | 已实现 |
| [dev/release.md](./dev/release.md) | 生产包：0.9.1 起发布 `hdxml` + `autowire.js`；obscura 等仍不做 | 部分落地 |
| [dev/cdp-debug.md](./dev/cdp-debug.md) | CDP 无头浏览器驱动 connect 页面（obscura/Chromium 通用范式 + 坑位） | 已实现 |

## 实战与报告

| 文档 | 内容 | 状态 |
|---|---|---|
| [skills/autowire-soc-integration.md](./skills/autowire-soc-integration.md) | demo/soc 集成 / 验证 / MCP 调试 | 实战手册 |

## 不做

- 把连接关系写进 `autowire.toml`（toml 只做工程/RTL 宇宙配置）。
- 把 README 写成第二套约定却不改 `src/cli/help.ts` / 本目录约束文。
