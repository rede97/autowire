# Autowire

接手前先跑，不要另写项目提示词：

```bash
bun index.ts help
```

切片：`bun index.ts help topics`。改行为时同步改 `src/help.ts`。

格式与实现约束统一在 [`docs/`](docs/README.md)（`autowire.toml`、连接 HTML、RtlIndex、hdxml CLI）。改约束同步改对应文档与 help 摘要；**先不要实现**未在 help status 中开放的步骤。

## 规则

- **语言**：代码与配置中的注释、错误/提示信息一律**英文**（`docs/` 中文文档除外）。TS 侧由 `src/lang-guard.test.ts` 强制（CJK 即红）。
- **Lint**：TS 一律过 Biome——提交前跑 `bun run lint`（`biome check .`），零 error 才可提交。
- **`.svh` 不进 filelist**：`.f`/`.lst`/`.flst`/`.list` 里出现 `.svh` 条目，hdxml 跳过并警告，**不要**靠把 svh 写进列表来传宏。宏头文件只用 `` `include ``（源内）或 `define_headers`（独立加载）；EDA 全局宏场景用 `eda_load.f`（头部 svh）+ 共享纯源码 `rtl.f` 的降级组合。
