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

## 并列插件 · [`plugins/`](./plugins/)

| 文档 | 内容 | 状态 |
|---|---|---|
| [plugins/](./plugins/) | 类型 A 已落地；类型 B 展开 `aw-*` 暂时不做 | 类型 A 已落地 |
| [plugins/wishbone-regfile.md](./plugins/wishbone-regfile.md) | Wishbone regfile；SoT=TS `RegfileDef`；connect 用 `aw-inst` | 已落地 |
| [plugins/wishbone-bus.md](./plugins/wishbone-bus.md) | 块内 cfg 树；开放项暂时不动 | 已落地 |
| [plugins/wishbone-master.md](./plugins/wishbone-master.md) | Master 口：CDC / APB / JTAG；开放项暂时不动 | 已落地 |
| [examples/regfile/](./examples/regfile/) | Wishbone regfile 作者面 TS + 生成 SV 展示 | 示例 |

## 仿真 · [`dtsim/`](./dtsim/)

| 文档 | 内容 | 状态 |
|---|---|---|
| [dtsim/README.md](./dtsim/README.md) | `autowire dtsim` / `dtsim` 多调用名；`<project>/dt/` 放 testbench，`dt/config/` 放 TS 配置；filelist 展开、后端插件、环境隔离、判分；demo/dtsim、demo/soc、demo/hbm | 已落地 |

## 状态机 DSL · [`state/`](./state/)

| 文档 | 内容 | 状态 |
|---|---|---|
| [state/async-fsm.md](./state/async-fsm.md) | 用 ECMAScript async/await 描述 RTL 状态机：channel 信号模型、运算符、端口声明、await 与节拍、标签命名状态、分支、子状态机调用、move 驱动动作、编译器与自写检查器；初稿已并入（git `21cb9ca`） | 设计草案，未实现 |

## 开发环境 · [`dev/`](./dev/)

| 文档 | 内容 | 状态 |
|---|---|---|
| [dev/windows-msys2.md](./dev/windows-msys2.md) | Windows：MSYS2 UCRT64 工具链、PATH、LF 行尾、原生 vs UCRT64 分工 | 已实现 |
| [dev/release.md](./dev/release.md) | 生产包：0.9.1 起发布 `hdxml` + `autowire.js`；obscura 等仍不做 | 部分落地 |
| [dev/core-perf.md](./dev/core-perf.md) | src/core 性能审查与优化记录（2026-09-29） | 已落地（#3 待单独处理） |
| [dev/typescript-roadmap.md](./dev/typescript-roadmap.md) | Wishbone 插件 TypeScript 评估、生成 RTL `-Wall` 现状、发射器 / 测试 / DSL 优化方向（2026-10-12） | 方向文；按 §4 顺序落地 |

## 实战与报告

| 文档 | 内容 | 状态 |
|---|---|---|
| [skills/autowire-soc-integration.md](./skills/autowire-soc-integration.md) | demo/soc 集成 / 验证 / MCP 调试 | 实战手册 |
| [skills/cdp-debug.md](./skills/cdp-debug.md) | CDP 无头浏览器驱动 connect 页面（步骤和坑） | 实战手册 |

## 不做

- 把连接关系写进 `autowire.toml`（toml 只做工程/RTL 宇宙配置）。
- 把 README 写成第二套约定却不改 `help/<topic>.txt` / 本目录约束文。
