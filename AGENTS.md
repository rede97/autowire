# Autowire

接手前先跑：`bun index.ts help agent`（工作约定；不要另写项目提示词）。

命令总览：`bun index.ts help`；切片：`bun index.ts help topics`。改行为时同步改 `src/cli/help.ts`。

一律用 Bun（`bun` / `bun test` / `bunx`），不用 Node/npm/npx 等价物。

格式与实现约束统一在 [`docs/`](docs/README.md)。改约束同步改对应文档与 help 摘要；**先不要实现**未在 `help status` 中开放的步骤。

实战手册（非约束，评审中）：[`docs/skills/autowire-soc-integration.md`](docs/skills/autowire-soc-integration.md) —— demo/soc 集成食谱、验证纪律、MCP 调试回路、踩坑清单。

## 规则

- **语言**：代码与配置中的注释、错误/提示信息一律**英文**（`docs/` 中文文档除外）。TS 侧由 `test/lang-guard.test.ts` 强制（CJK 即红）。
- **Lint**：TS 一律过 Biome——提交前跑 `bun run lint`（`biome check .`），零 error 才可提交。
- **Windows**：工具链统一 MSYS2 UCRT64（Bun / Biome / Playwright 保持 Windows 原生），PATH 只加 `C:\msys64\ucrt64\bin`，行尾 LF（`core.autocrlf false`）。细则见 [`docs/dev/windows-msys2.md`](docs/dev/windows-msys2.md)。
- **生产包**（暂时不做）：目标仍是并排三颗二进制 `autowire` + `hdxml` + `lightpanda`。这个阶段不写打包脚本。开发与 CI 仍用 Playwright Chromium。细则见 [`docs/dev/release.md`](docs/dev/release.md)。
- **`.svh` 不进 filelist**：`.f`/`.lst`/`.flst`/`.list` 里出现 `.svh` 条目，hdxml 跳过并警告，**不要**靠把 svh 写进列表来传宏。宏头文件只用 `` `include ``（源内）或 `define_headers`（独立加载）；EDA 全局宏场景用 `eda_load.f`（头部 svh）+ 共享纯源码 `rtl.f` 的降级组合。
