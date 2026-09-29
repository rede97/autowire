# Changelog

版本号和 GitHub Release 说明以本文件最上面一条 `## [x.y.z] - YYYY-MM-DD` 为准。`package.json` 的 `version` 必须和它相同。`hdxml` 用自己的版本（`hdxml/Cargo.toml`），不受本文件约束。

## [2.3.0] - 2026-09-30

- 索引/快照单格式：`--format json` 时 hdxml 只写 JSON（不再双写 XML）；增量缓存回读按格式分发（serde_json），验证逻辑（指纹/mtime/blake3 仲裁）原样。格式切换会清掉另一种格式的残留文件。connect 快照同理：`format = "json"` 时 `.autowire/connect/` 只写 `<id>.json`。
- `[analysis.index] format` 的 JSON 模式标记为测试状态；demo 与默认路径保持 XML（稳定支持）。
- README 重写为英文并补充性能与 Agent 适配说明、CI/Release 徽标；仓库以 GPL-3.0 开源。

## [2.2.9] - 2026-09-30

- RtlIndex JSON 消费模式：`[analysis.index] format = "json"` 时 hdxml（0.4.0，`--format json`）在 XML 之外再写 `index.json` + 每文件 `.json` 镜像；connect/web/`analysis deps|search|info` 直接 JSON.parse（真实索引上约为 Bun.XML 的 2.1 倍吞吐）。XML 始终写出，仍是增量缓存本体与文档化契约；增量逻辑不变。
- JSON 端口带显式 `dir` 字段（声明序）；消费侧按 PORT_DIRS 重排，与 XML 路径生成结果逐字节一致。
- connect 快照同步支持：`format = "json"` 时 `connect run` 在 `.autowire/connect/<id>.xml` 之外写 `<id>.json` 镜像，deps 加载改读 JSON（`connectJson`/`parseConnectJson`，与 XML 往返结果全等有测试锁定）。

## [2.2.8] - 2026-09-30

- src/core 性能优化（docs/dev/core-perf.md）：`unitModNames` 全量 HTML 解析从每 unit 一次降为每次命令一次（O(U²)→O(U)）；session dep facts 去掉 connectXml 序列化往返；elaborate 按 target 模块缓存 facts/params/ports/端口序；端口维度 rewriteDims 不再重复扫描；writeRender 端口排序改 Map 查表。生成物与优化前逐字节一致。
- writeRender 的 DOM 构建路径（审查 #3）未动，留待单独处理。

## [2.2.7] - 2026-09-29

- wishbone `<bus>_bus_cfg` wrapper 改经 connect 的 render IR + 共享 printer 生成：插件构造 ports/signals/insts 模型交给 `printSv`，删掉手工对齐的平行实现（含正则反解析已生成文本的 helper）。生成时传入**全部** `[workspace.style]`（对齐、端口方向/位宽注释、`net_type`），wrapper 与 connect 单元输出同款格式。四个 demo wrapper 重新生成；桥接实例的端口事实（dir/宽度）来自插件自有模板表。printer 的 RenderModule 增加可选 `header` / 端口与信号 `comment` / `assigns` 字段（connect 引擎不写，插件用）。

## [2.2.6] - 2026-09-29

- 发布产物增加 `hdxml-windows-x64.zip`：`windows-2022` 上 MSVC 目标的 `hdxml.exe`。
- `[workspace.style] net_type`：`logic`（默认）/ `wire` / `auto`。作者面没写 `nettype` 的端口和内部信号按它填关键字；`auto` 从子模块声明继承（叶子口按 RtlIndex `dataType`：`logic`/`reg` → `logic`，无关键字即隐式线网 → `wire`；connect 例化 connect 取子单元快照的 `nettype`；两端继承不一致报 nettype conflict），继承不到回落 `logic`。生成的 `.sv` 不再出现 `reg`。显式 `nettype=` 永远优先。原默认（端口回落 wire、信号回落 logic、默认带继承）改为默认 logic、不做继承，demo 生成物随之重生成。

## [2.2.5] - 2026-09-29

- Wishbone 总线封装模块改名 `<bus>_system` → `<bus>_bus_cfg`（生成物；引用封装名的 `aw-inst`、filelist、脚本都要同步改）。demo/soc、demo/hbm 已跟随。
- 生成的 Wishbone Excel（`bus_regfiles.xlsx`）不再进 git：`*.xlsx` 加入 gitignore，工作簿留在磁盘上，改 SoT 后由 `plugin wishbone run` 重写。

## [2.2.4] - 2026-09-30

- hdxml 提取端口 packed / unpacked 维度时去掉紧随其后的 `//` 行注释。2.2.2 只清了 localparam 默认值，sdspi 的 `// }}}` 折叠标记仍从 `[DW-1:0]` 进生成的端口宽度注释。
- `docs/skills/autowire-soc-integration.md` 与 `docs/workspace/toml.md` 把分析 filelist 的三条规则拆开写：只放手写 RTL 和 `plugins_dir` 叶子；wrapper 与 TB 放仿真 filelist；叶子缺失时 `analysis run` 点名 `plugin wishbone run`。

## [2.2.3] - 2026-09-29

- `help agent`、`help dont`、仓库 `AGENTS.md`（`init` 抄成 `AGENTS-AUTOWIRE.md`）和 init 的 toml 注释写明：`rtl/gen/`、`fw/gen/`、`dv/ral/`、`.autowire/` 是生成物，不是源。生成结果不对就改 SoT 再跑写出命令，不要改这些文件。
- 初始化约定整段写在 `help agent` 的 Init：先讲清工具再按默认项问用户，并说明怎么把 `AGENTS-AUTOWIRE.md` 接到工作区 `AGENTS.md`。没跑过 `init` 也能读到。`init` 写完文件后会再打一行同样的挂接提示。
- `help agent` 的 Cold start 只留启动顺序。hdxml 查找留在 `help analysis`，`snapshot missing` 留在 `help check`，解包缺 demo 留在 `help docs`，`adr & ~mask`、分片口、tga tie-off、`TagFromAddr` 地址位留在 `help status` 的 wishbone 条目旁。
- `help agent` 的 Init 按 Writes / Attach / Ask / Defaults 分块。实战顺序和踩坑在 `docs/skills/autowire-soc-integration.md`：filelist 已点名 `rtl/gen` 时先 `plugin wishbone run`，再 `analysis run`，再 `connect run`。
- `help` 正文改到 `help/<topic>.txt`，`src/cli/help.ts` 只负责读入；这些文件打进 `autowire.js`，不必先 `docs unpack`。`docs/dev/cdp-debug.md` 挪到 `docs/skills/cdp-debug.md`。工具与 MCP 的边界收进 `docs/architecture.md` §3，删掉没有实现的 `docs/mcp/`。
- 分析与仿真的 filelist 分开：`[analysis]` filelist 只装手写 RTL 和 `plugins_dir` 叶子；`connect run` 的产物（wrapper、TB）不进索引，放仿真专用 filelist（demo/soc 新增 `rtl/gen.f`，仿真按 `-f rtl/soc.f -f rtl/gen.f` 合并，两个仿真 filelist 不再各自抄一份）。`analysis run` 对 filelist 里的 `connect_dir` / `sim_dir` 条目直接报错，不再提示「先跑 connect run」。demo/soc 重新生成 `sd_sha_ch.sv`（hdxml 去掉 localparam 行尾注释后产物一直未同步，release 冒烟抓到漂移）。

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
