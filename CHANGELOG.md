# Changelog

版本号和 GitHub Release 说明以本文件最上面一条 `## [x.y.z] - YYYY-MM-DD` 为准。`package.json` 的 `version` 必须和它相同。`hdxml` 用自己的版本（`hdxml/Cargo.toml`），不受本文件约束。

## [2.2.2] - 2026-09-29

- 冷启动契约写进 `help agent`、仓库 `AGENTS.md`（`init` 抄成 `AGENTS-AUTOWIRE.md`）和 init 的 toml 注释：独立包的 hdxml 走 `--hdxml` / `$HDXML_BIN` / PATH；filelist 点名了还不存在的 dump 路径时先生成再 analysis；`connect check` 依赖已有 snapshot；文档引用的 demo 若这次 unpack 没有，就不要到包外去找。同时写明 `adr & ~mask` 不能做基址相减或翻位、宽 field 旁路是分片口、声明了 tag 的总线每个 master 都有 tga 口要 tie-off、`TagFromAddr "hi:lo"` 才是地址位权威。
- `analysis run` 在 filelist 列出 `plugins_dir` / `connect_dir` / `sim_dir` 下缺失文件时直接停住，并指出先跑 `plugin wishbone run` 或 `connect run`，不再只把 hdxml 的 file-not-found 透传出去。
- `docs unpack` 把 `*.sh` 恢复为可执行。wishbone-regfile 契约改为与生成器一致：宽 field 模块口保持分片，不拼成一条向量。hdxml 从 localparam 默认值里去掉紧随其后的 `//` 注释（sdspi 的 `DW = 32` 下一行折叠标记不再进宽度表达式）。demo/soc 的 JTAG bank 别名与 `TagFromAddr bank "27:26"` 对齐。

## [2.2.1] - 2026-09-29

- 发布 CI 的 `autowire-js` 构建后新增 bundle 冒烟（`scripts/smoke-bundle.ts`）：用打出来的 `autowire.js` 跑 `--version`、独立目录 `init`（含 `.autowire/dsl` 与拒绝覆盖）、完整驱动 demo/soc（analysis → wishbone → connect check/run），并用 `git diff` 验证生成产物与仓库逐字节一致（Excel 除外，其内嵌时间戳）。只测源码的单元测试覆盖不到的打包路径问题由此进 CI 门禁。

## [2.2.0] - 2026-09-28

- 发布包冷启动优化：文档包收紧为"可运行的最小集"——`demo/*/ip/` 只打该 demo `.f` filelist 引用到的源文件（sdspi/picorv32 的上游文档、bench、PDF 不再进包），`vcs/work/`、`.git` 指针、`.github`、`*.xlsx`、`ucli.key`、`~$*` 全部排除；`demo/*/patches/` 的补丁打包时已应用；demo `sot/*.ts` 的 DSL 导入改写到 `.autowire/dsl/`，解包后的独立树可直接跑 `analysis run` → `plugin wishbone run` → `connect run`（再生产物与仓库已提交的 showcase 逐字节一致）。压缩从 gzip 换成 zstd level 22，内嵌形式从 80MB 的 `Uint8Array.from([...])` 字节数组字面量改成函数体内的 base64 字符串（函数体惰性解析，只在 `loadPack` 时解码）；exceljs 改为惰性加载。`autowire.js` 从 85MB 降到 4.8MB，冷启动从约 1.2s 降到约 0.2s。
- `autowire init <name>` 同时写出 `.autowire/dsl/`（wishbone-bus/wishbone-regfile 的 DSL 源码三件套）。独立工作区的 SoT 用 `../.autowire/dsl/wishbone-bus/dsl.ts`、`../.autowire/dsl/wishbone-regfile/dsl.ts` 导入，不再依赖仓库源码树。DSL 随发布版本走；`.autowire` 被删后 `plugin wishbone run` 自动补回。DSL 判定为结构式（无 instanceof），bundle 内置副本与外部文件不会重复定义冲突。

## [2.1.0] - 2026-09-28

- 打包的 `autowire.js` 可以脱离仓库工作：wishbone 模板从文档包读取（不再依赖源码树路径），`hdxml` 查找在仓库外回退到 `HDXML_BIN`/PATH。`loadPack` 进程内缓存。
- RtlIndex 目录强制固定为 `.autowire/hdxml`：`[analysis.index] dir` 写成其他值直接报错。`autowire init <name>` 会创建该目录。
- `init` 的 toml 模板风格对齐 demo/soc：`filelists = ["rtl/<name>.f"]`、`rtl/gen/` 产物三分目录、完整 `[workspace.style]` 对齐块。

## [2.0.2] - 2026-09-28

- `help agent`（`Reference (top priority)`）与仓库根 `AGENTS.md` 明确：项目最佳实践以 `docs/`（契约/约束）与 `demo/`（可运行范例）为准，改动行为前先读这两处，作为第一优先级参考。

## [2.0.1] - 2026-09-28

- `[analysis.rtl]` 新增 `exclude_dirs`，映射 hdxml `--exclude-dirs`（按目录名剪整棵子树，任一路径分量命中即排除）。此前 hdxml 已支持该能力，但 autowire.toml 未透出、文档也未说明。

## [2.0.0] - 2026-09-28

- hdxml 支持 VCS 风格 filelist 的最小子集：`.vc` 扩展名、`+incdir+DIR`、`+define+NAME[=VALUE]`、`-F`（子列表内容相对该子列表所在目录）。库搜索（`-y`/`+libext+`/`-v`）与仿真器开关不实现，遇到即报错。hdxml 自身版本升为 0.2.0，与 autowire 版本相互独立。
- 主线代码源切换为 GitHub `main`；Gitee 分支线不再合入。

## [0.9.1] - 2026-09-28

- 主干上的 GitHub Actions 发布 Linux x86_64 `hdxml`（Ubuntu 22.04 执行 `hdxml/dist.sh`，glibc 2.17，CentOS 7 及更新版本）、macOS `hdxml`（arm64 与 x64），以及单文件 `autowire.js`。
- `autowire --version` 打印版本、提交和构建时间。版本来自本文件；发布构建把提交和构建时间写进 `autowire.js`。
- `autowire init <name>` 同时创建 `autowire.toml` 和 `AGENTS-AUTOWIRE.md`。后者是仓库根目录 `AGENTS.md` 的原样副本。任一文件已存在则两个都不写。
- 文档包包含仓库根目录的 `AGENTS.md`。`docs unpack` 会写出它。`doc-pack.generated.ts` 每次发布构建重新生成，不入库。
- 本版不包含 obscura、安装器、Linux aarch64，以及编译进 Bun 运行时的 `autowire` 二进制。
