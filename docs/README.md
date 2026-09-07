# Autowire 文档

统一放在本目录。Agent 接手仍以 `bun index.ts help` 为准；**格式与实现约束**以本目录文档为准（改约定时同步改 help 摘要）。

| 文档 | 内容 | 状态 |
|---|---|---|
| [workspace-toml.md](./workspace-toml.md) | 顶层 `autowire.toml`：`.f`、宏/`.svh`、与 RtlIndex / 连接衔接 | 草稿，未实现 |
| [connect-html.md](./connect-html.md) | 连接 HTML 方言；顶→底 param、底→顶连线；aw.js / dump 约束 | 草稿，未实现 |
| [examples/connect/](./examples/connect/) | 连接 HTML 示例（作者面 + 渲染后示意） | 草稿 |
| [hdxml/rtlindex-xml.md](./hdxml/rtlindex-xml.md) | RtlIndex XML 格式契约（hdxml ↔ autowire） | 草案 |
| [hdxml/module-info.md](./hdxml/module-info.md) | hdxml DesignDb / 模块信息模型 | 已实现参考 |
| [hdxml/cli.md](./hdxml/cli.md) | hdxml `analysis` CLI | 已实现 |

## 不做

- 在 `hdxml/docs/` 再放一份文档（已迁到 `docs/hdxml/`）。
- 把连接关系写进 `autowire.toml`（toml 只做工程/RTL 宇宙配置）。
- 把 README 写成第二套约定却不改 `src/help.ts` / 本目录约束文。
