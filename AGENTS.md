# Autowire

接手前先跑，不要另写项目提示词：

```bash
bun index.ts help
```

切片：`bun index.ts help topics`。改行为时同步改 `src/help.ts`。

格式与实现约束统一在 [`docs/`](docs/README.md)（`autowire.toml`、连接 HTML、RtlIndex、hdxml CLI）。改约束同步改对应文档与 help 摘要；**先不要实现**未在 help status 中开放的步骤。
