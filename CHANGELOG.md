# Changelog

版本号和 GitHub Release 说明以本文件最上面一条 `## [x.y.z] - YYYY-MM-DD` 为准。`package.json` 的 `version` 必须和它相同。`hdxml` 用自己的版本（`hdxml/Cargo.toml`），不受本文件约束。

## [2.0.1] - 2026-09-28

- `autowire.toml` 新增顶层 `[workspace]` 表，`name` 必填（C 标识符）。wishbone 顶层伞文件名与 include 卫兵改为按它生成（C 伞 `<name>.h` / 卫兵 `<NAME>_H`；UVM 伞 `ral_<name>.sv` / 卫兵 `RAL_<NAME>_SV`），避免跨工作区撞名。`init` 改为 `init <name>`。
- 产出目录与打印风格移到 `[workspace.dump]` / `[workspace.style]`；`[hdxml] bin` 折进 `[analysis] hdxml_bin`；仍写旧顶层 `[dump]` / `[style]` / `[hdxml]` 会报迁移错误。
- `[analysis.rtl]` 新增 `exclude_dirs`（映射 hdxml `--exclude-dirs`，按目录名剪整棵子树）。
- Wishbone Excel：字段 sheet 更名 `regfile_<sheet>`、地址图 sheet 更名 `bus_map_<bus>`；表头行不再写死高度，按换行自动撑高。
- Wishbone 总线：每个广播组只发射一根共享 `<group>_off` 偏移 wire，订阅者不再各自重复 `(adr - base)`。
- connect web：源（source）与处理后（processed）以 DevTools 风格树呈现。
- CI：发布前检查会构建 hdxml、跑 RtlIndex 与 Chromium 测试；demo 的 VCS 回归转绿。

## [0.9.1] - 2026-09-28

- 主干上的 GitHub Actions 发布 Linux x86_64 `hdxml`（Ubuntu 22.04 执行 `hdxml/dist.sh`，glibc 2.17，CentOS 7 及更新版本）、macOS `hdxml`（arm64 与 x64），以及单文件 `autowire.js`。
- `autowire --version` 打印版本、提交和构建时间。版本来自本文件；发布构建把提交和构建时间写进 `autowire.js`。
- `autowire init <name>` 同时创建 `autowire.toml` 和 `AGENTS-AUTOWIRE.md`。后者是仓库根目录 `AGENTS.md` 的原样副本。任一文件已存在则两个都不写。
- 文档包包含仓库根目录的 `AGENTS.md`。`docs unpack` 会写出它。`doc-pack.generated.ts` 每次发布构建重新生成，不入库。
- 本版不包含 obscura、安装器、Linux aarch64，以及编译进 Bun 运行时的 `autowire` 二进制。
