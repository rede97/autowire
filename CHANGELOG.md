# Changelog

版本号和 GitHub Release 说明以本文件最上面一条 `## [x.y.z] - YYYY-MM-DD` 为准。`package.json` 的 `version` 必须和它相同。`hdxml` 用自己的版本（`hdxml/Cargo.toml`），不受本文件约束。

## [0.9.1] - 2026-09-28

- 主干上的 GitHub Actions 发布 Linux x86_64 `hdxml`（Ubuntu 22.04 执行 `hdxml/dist.sh`，glibc 2.17，CentOS 7 及更新版本）、macOS `hdxml`（arm64 与 x64），以及单文件 `autowire.js`。
- `autowire --version` 打印版本、提交和构建时间。版本来自本文件；发布构建把提交和构建时间写进 `autowire.js`。
- `autowire init` 同时创建 `autowire.toml` 和 `AGENTS-AUTOWIRE.md`。后者是仓库根目录 `AGENTS.md` 的原样副本。任一文件已存在则两个都不写。
- 文档包包含仓库根目录的 `AGENTS.md`。`docs unpack` 会写出它。`doc-pack.generated.ts` 每次发布构建重新生成，不入库。
- 本版不包含 obscura、安装器、Linux aarch64，以及编译进 Bun 运行时的 `autowire` 二进制。
