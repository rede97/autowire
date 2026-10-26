# Changelog

版本号和 GitHub Release 说明以本文件最上面一条 `## [x.y.z] - YYYY-MM-DD` 为准。`package.json` 的 `version` 必须和它相同。`hdxml` 用自己的版本（`hdxml/Cargo.toml`），不受本文件约束。

## [2.5.12] - 2026-10-26

- 发布纪律：推送 `main` 不再触发 CI。检查、构建和 GitHub Release 只在人工推送 `v*` tag 时跑；CI 仍不创建 tag，已存在的 release 仍拒绝覆盖。
- connect 新增 `aw-content/aw-port-groups`：导出端口的打印分组提示（弱规则，不改连线）。每个 `aw-port-group name=` 按序带多个选择器（自身 `match=` / `inst=`，再加若干 `aw-port-match`）；端口归第一个命中的组，组内按选择器优先级、再按原 §4.1 顺序排（`order="name"` 改按名字排），未归组的放到最后的 `Other`；每组首个端口打印 `// <组名>`。重叠或空组给警告，非法正则 / 未知 `inst` / 缺选择器在 `check` 报错。契约见 `docs/connect/html.md` §4.1.1。demo/soc `soc_top` 按时钟复位 / JTAG / SPI flash / UART / SD0 / SD1 / 状态分组，`rtl/gen/connect/soc_top.sv` 与 `rtl/gen/sim/tb_soc.sv` 已重新生成。

## [2.5.11] - 2026-10-26

- **接口变更**：fabric（decoder / interconnect / crossbar）上 `SlaveRegfile` 的下游 slave 口 `{id}_i_wb_adr` 改为直接按叶子 `addrWidth` 声明，与 `<name>_regfile` 逐位对齐；其它 slave 与上游 master 口仍是 fabric `addrWidth`。窗内 offset 的截位 / 零扩展从 `<bus>_bus_cfg` 移进 fabric；有 `pipe` 时 `wb_cfg_pipe` 按窗口与叶子中较窄的宽度寄存。wrapper 内置叶子与 `external: true` 的上层叶子都直接同名连接，不再需要 ADR 适配；`-Wno-WIDTHEXPAND` 不再需要。直接例化 fabric 并自行接 regfile ADR 的用户需按新位宽改连接。
- demo regfile 的 `addrWidth` 改为各自窗口转发的位数，不再统一写 32：demo/soc `sha256` / `smoke` = 6（0x40 窗），demo/hbm `aword` / `dword` = 8（0x100 窗）、`center` = 12（0x1000 窗）。`rtl/gen` 已重新生成；C / uvm_reg / sv_reg 地址图不变。

## [2.5.10] - 2026-10-26

- `SlaveRegfile(regfile, base, { external })` 新增分离模式（缺省 `false` = 内置，保持现状）。`external: true` 时 `<bus>_bus_cfg` 不再例化该叶子、不提升字段旁路，改为导出该挂接的 fabric WB 窗口口（`{id}_i_wb_*` / `{id}_o_wb_*`，含 shadow 的 `{id}_i_wb_tga_<domain>`），由上层自行例化 `<name>_regfile` 并连接。按挂接点选择，可内外混用；同一 `RegfileDef` 多挂时各挂接点独立。`<name>_regfile.sv` 与软件地址图（C / uvm_reg / Excel / sv_reg）两种模式完全一致。`TagFromReg` 必须引用内置叶子，引用外置挂接 → 构造期报错。契约见 `docs/plugins/wishbone-bus.md` §2.1 / §6、`docs/plugins/wishbone-regfile.md`。

## [2.5.9] - 2026-10-21

- 修复 hdxml 0.4.1（issue #2）：保原文宏（`--define-headers` / `--keep-raw`）用作模块名时，内部哨兵不再出现在例化 `target` 和 hierarchy 节点。XML / JSON 导出还原为 `` `NAME ``，未展开的 cell 是黑盒叶子。
- `--expand-headers` 的宏值去掉前导分隔空白，与 `-D` 的 `definesFp` 一致。用宏选择外部 FIFO / sync cell 时把带值项写在 `[analysis.defines]`；只放进 `define_headers` / `keep_raw` 不会把 cell 接上。

## [2.5.8] - 2026-10-20

- connect 顶层导出端口排序规则化：显式 `aw-ports` 按作者文档序在前；自动导出的网按实例文档序分组，组内按目标模块自身端口表顺序排列，模板里 connect 规则的书写顺序不再影响导出顺序。契约见 `docs/connect/html.md` §4.1；demo/soc `rtl/gen` 随之重新生成。
- `wb_sync_cell` 新增参数 `WIDTH`（缺省 1，备用；多位为逐位独立同步，不是总线同步器），`d`/`q` 变为 `[WIDTH-1:0]`，`STAGES < 2` 编译期报错。新增编译宏 `AUTOWIRE_SYNC_CELL=CELL_SYNC` 选择外部同步单元/adapter：透传 `STAGES`、`RESET_VAL`、`WIDTH`，缺失所选模块编译失败、不静默回退；生成的 `wb_sync_cell.sv` 两种模式都留在 filelist。契约见 `docs/plugins/wishbone-master.md` §3.2。新增 `test/sync-cell.test.ts`。

## [2.5.7] - 2026-10-19

- 修复 `wb_cdc` 单侧复位（2.5.6 起）：只复位一侧（JTAG TRST 或系统 `rst_n`）会让 FIFO 重放历史命令、发出未初始化的 X 命令，并使后续读数据永久错一拍。现在 `link_rst_n = s_rst_n & rst_n` 同时复位两向 FIFO 两端（对侧停钟也生效）；丢失的挂起读回一次 `s_err`；源侧单独复位时已在 fabric 上的拍做完、数据丢弃；目标复位期间新请求等待；源撤 `CYC` 放弃的读，其迟到响应被排空。不再要求协调两侧复位。新增 `test/fixtures/wb_cdc_reset_tb.sv`。
- 新增 `Master(..., { apb: { timeout: N }, cdc: true })`：`wb_apb2wb` 参数 `TIMEOUT`（PCLK 周期，0 关闭），超时撤 `CYC` 并回 `PSLVERR`；必须经 `wb_cdc`，无 CDC 时报错。`wb_cdc` 自身仍无超时。`demo/hbm` 的 `host` 恢复 `timeout: 64`。新增 `test/fixtures/wb_apb_timeout_tb.sv`。RDC、复位脉宽、超时预算等集成注意事项见 `docs/plugins/wishbone-master.md` §3、§4。

## [2.5.6] - 2026-10-19

- `wb_cdc` 迁移 [Gitee master `435180e`](https://gitee.com/lunamiko/autowire/tree/435180e61a2580d5db3f3cc6f8f4e622b638876b) 的 posted 语义：命令 FIFO 深度 8、读返回 FIFO 深度 2，写入队即 ACK、读等目标 WB ACK 返回；保留 TGA 与 APB PPROT 拒绝。用户提供的硅验证结论适用于参考实现，不覆盖新增 WB 适配和默认 Gray FIFO。
- **接口/行为变更**：移除 `timeout` / RTL `TIMEOUT`、超时/复位 ERR 及自动恢复；要求静默请求并协调两侧复位，不保证单侧复位。停目标钟时读等待，写至 FIFO 满后背压。JTAG 写完成表示排队；同路径读只保证命令顺序，不是下游 posted 写的全局栅栏。
- 生成 `wb_async_fifo` wrapper 默认使用同文件 `wb_async_fifo_gray`，无需外部 CELL 即可仿真；`AUTOWIRE_ASYNC_FIFO_CELL=CELL_ASYNC_FIFO` 选择实际 CELL/adapter，缺失所选模块会编译失败，不静默回退。两种模式均保留生成 FIFO 文件，外部模式另外加入 CELL/adapter，并在 analysis 使用相同宏/filelist；适配必须满足寄存读出与 reset-busy 契约。外部选择的测试 adapter 不代表 vendor CELL 验证。

## [2.5.5] - 2026-10-19

- 修复 `wb_cdc` 冷启动：复位后、第一次回到 idle 之前，若目标侧没有在飞事务，新请求等待而不是立刻 `s_err`。APB 桥在此期间保持 `PREADY` 为低。超时、abort，以及源侧复位后目标仍握着已捕获事务时，仍回 `ERR`。`demo/hbm` 与 `demo/soc` 的 `wb_cdc.sv` 已重新生成。
- 仓库内直接跑 TypeScript 时，Wishbone RTL 模板从 Git 里的 `docs/plugins/rtl/` 读取。打包后的 `autowire.js` 仍只使用内嵌文档包，不打开本地 `docs/`。

## [2.5.4] - 2026-10-19

- 总线 WB 端口统一由一个端点 schema 生成名称、方向、位宽、TGA 和请求/响应角色；decoder / interconnect / crossbar 的 RTL 声明、wrapper 与原生 WB/CDC 桥接面共享来源，删除重复端口表及名字反向解析。
- **接口变更**：所有拓扑的 `.uplink()` 只选择级联 master，不再把 wrapper 端口改成 flat `i_wb_*` / `o_wb_*`。上层使用具名 `{master}_o_wb_*` / `{master}_i_wb_*` 显式连接父级 slave；demo/soc 已迁移成束 rewrite，保留手写 channel 外壳接口。
- **接口变更**：`Bus()` 的 `masters` 省略或为空时归一化为名为 `m` 的默认 master，统一输出 `m_o_wb_*` / `m_i_wb_*`，删除旧 `m_adr_i` 等端口格式，不保留兼容别名。
- 更新 SoC/HBM 生成物、级联端口契约和 tagged/pipe/broadcast/bridge 回归；仲裁、译码和基础 pipe/CDC 模块协议不变。

## [2.5.3] - 2026-10-19

- **接口变更**：Wishbone decoder 的已声明 master 端口与 interconnect / crossbar 统一为 `{master}_o_wb_*` / `{master}_i_wb_{dat,ack}`（含 TGA），不再使用 flat `m_*`；未声明 `masters` 的 decoder 保持原有 flat 口。
- decoder 的 `.uplink()` Type-A wrapper 保留具名 master 口，不再 remap 成 `i_wb_*` / `o_wb_*`，上层按 master 名显式连接；interconnect / crossbar 的级联 remap 不变。master pipe、APB/JTAG/CDC、demo/hbm 与回归测试已同步。

## [2.5.2] - 2026-10-15

- 修复 Type-A wrapper `<bus>_bus_cfg` 把 fabric 全宽 ADR 直接接到挂接 regfile 的 `i_wb_adr`、两者 `addrWidth` 不同时产生端口位宽不匹配的问题（issue #1）。fabric 下发的是窗内 offset（`adr & ~mask`），窗口以上全 0：fabric 更宽 → 接 `net[M-1:0]`；fabric 更窄 → 接 `{(M-N)'d0, net}`。demo/soc `sd_sha_bus_cfg`、demo/hbm `hbm_ch_bus_cfg` 随之重新生成。
- `Bus()` 构造期拒绝窗口转发位数大于挂接 regfile `addrWidth` 的配置（截断会把窗口别名到叶子上）。regfile 比窗口宽仍然允许。

## [2.5.1] - 2026-10-12

- `[plugins.wishbone]` 新增可选 `regfile_dir` / `bus_dir`，分别覆盖 regfile 与 bus 的 RTL 输出目录；省略时仍写入 `plugins_dir/wishbone/{regfile,bus}`。
- 修复 CDC 超时恢复过早接收新请求、可能将旧响应交给新请求的问题：增加目标排空确认握手，覆盖停钟前未捕获请求、单侧复位及复位期间 ERR。
- 明确 PIPE 读请求不可取消，增加仅仿真使用的请求保持检查；新增 CDC 时钟比例/恢复测试和 PIPE 违规控制测试。
- 纠正生成 JTAG PDL 的能力说明：Level-0 固定等待后检查状态，不提供自动 busy 轮询。
- `[plugins.wishbone]` 新增可选 `regfile_dir` / `bus_dir`，分别覆盖 regfile 与 bus 的 RTL 输出目录；省略时仍写入 `plugins_dir/wishbone/{regfile,bus}`。
- 修复 Bus / Crossbar 广播在订阅者响应错开或 pipe 占用不同时重复接受同一笔请求的问题：逐分支记录完成、屏蔽已完成分支的 STB，并保存读响应后 OR 汇总。保留 posted 写入口 ACK 语义。
- 构造期拒绝 slave 组名与同一 decoder 内 slot 名大写规范化后的标识符冲突，避免生成重复的 `SG_*` / `SLOT_*` 常量。

## [2.5.0] - 2026-10-12

- Wishbone 总线新增分组 crossbar：`Crossbar(name, desc, { masters: [Master | MasterGroup(...)], slaves: [slave | SlaveGroup(...)], addrWidth, tagWidth?, tags? })`。master 组各有一个 arbiter（组内互斥），slave 组各有一个 decoder，不同 (master 组, slave 组) 对并行推进；裸 master / slave 即单成员组。返回值仍是拍平的 `BusDef`（多出 `crossbar` 组元数据），口名、tag、pipe、广播、`.uplink()` 级联、`<bus>_bus_cfg` wrapper 与 C/UVM/SV/Excel 软件图全部沿用；产物 `<bus>_crossbar.sv`，端口与 interconnect 同形（含 `rb_grant_en`）。广播窗与订阅者必须同在一个 slave 组。经典 `Bus()` 的语义与生成产物逐字节不变。文档 `docs/plugins/wishbone-bus.md` §4.2，`help status`。
- 修复 interconnect 中 piped master（`Master(..., { pipe: N })`）携带继承 tag 域时，`g_up_<domain>` 引用未声明的 `m<i>_tga_<domain>_q`；现在从 pipe 打包的 `m<i>_tga_q` 正确切片。
- `plugin wishbone run` 的地址树为 crossbar 标出 `group:` 与 master 组；Excel 总线形态列新增 `crossbar`。
- 新增 `test/wishbone-crossbar.test.ts` 与 Verilator TB `test/fixtures/wb_crossbar_tb.sv`（并行推进、组内互斥、slave 组互斥、unmapped、固定/轮转混合突发）。

## [2.4.1] - 2026-10-10

- `.autowire/dsl/` 自愈从「仅缺失时补回」改为「每次 `plugin wishbone run` / `init` 都从内嵌 pack 无条件重新物化」：autowire 升级后解包出的 DSL 随之刷新，被手改/改脏的文件也会覆盖回内嵌版本（`.autowire` 本就是可删、禁手改的缓存）。文件很小，无条件覆盖比字节比对更简单，且没有陈旧缓存的失败模式；不引入版本戳。`ensureWishboneDsl` 返回 `{ files, freshDir }`，`freshDir` 仅用于决定日志措辞（目录原本不存在才打 `restored .autowire/dsl/`）。

## [2.4.0] - 2026-10-10

- Wishbone 级联面改用 `BusDef.uplink(name?)` 显式选取，**不再**用保留名 `Master("uplink")`，并删除 `SlaveBusOpts.uplink`。单 master 的子总线隐式取唯一 master 作面，多 master 必须 `child.uplink("name")` 点名；桥接口（apb/jtag/cdc）不能当面。`SlaveBus` 要求传入已选面的 child，`flattenBuses` 保留带 `cascadeFace` 的副本，使独立生成的 `<bus>_bus_cfg` wrapper 拿到正确面（级联 = `i_wb_*`/`o_wb_*`，顶层 = `m_*`）。**破坏性**：`Master("uplink")` + `SlaveBus(child, …)` 需迁移到 `child.uplink()`（或 `child.uplink("name")`）。
- 顺带修掉「decoder 挂 regfile 且无级联面」时 wrapper 把 fabric master 接到未声明 `i_wb_*` 的悬空 bug——现在无级联面就保持 fabric 自己的 `m_*` 面。
- demo（hbm / soc）、文档（`docs/plugins/wishbone-bus.md` §9、`wishbone-master.md`）、`help status`、测试全部切到新 API，并新增「无级联面」回归用例。
- `fix(demo/soc)`：默认 Verilator 目标（`Vtb_soc_vl`）不再把 aw-tb-mod 的 `rtl/gen/sim/tb_soc.sv` 拉进构建（那是 `--tb-mod` 的 top），避免找不到 `sim/*.svh` 而编译失败。

## [2.3.2] - 2026-10-09

- Wishbone 插件新增 `sv_reg` 导出：`[plugins.wishbone] sv_reg=` 生成非 UVM 的 `*_pkg.sv` package + localparam（字段 `_LSB/_WIDTH/_MASK/_RESET`；总线 `<SLAVE>_BASE`、`<SHEET>_<CELL>_OFFSET`、绝对地址 `<SLAVE>_<CELL>`），目录按 `regfile/` 与 `bus/` 分开、伞文件在根，与 C 导出同款组织。demo/soc 入库 `dv/sv_reg/` 与 Verilator 冒烟 `sim/verilator/sv_reg_smoke.sh`（无固件、无总线 RTL、不需要 `--timing`）。
- 新增 `autowire update`：打印当前版本、最新 release 地址（github.com/rede97/autowire/releases/latest）、各平台资产下载链接，以及一段可直接粘贴给 AI 的升级提示词（下载→替换→验版本→读 changelog→按依赖序重新生成→刷新 AGENTS-AUTOWIRE.md→重跑测试）。命令本身不下载、不写盘。
- 裸执行 `autowire`（无子命令）在命令索引末尾追加一行：项目链接 + 版本号。
- 发布纪律变更：CI 永不创建/推送 tag；推送 `main` 只做检查与构建，发布只在人工推送 `v*` tag 时触发，且拒绝覆盖已存在的 release。

## [2.3.1] - 2026-09-30

- `autowire.js` 打包打开 `--minify --keep-names`。页面脚本改由 `bun run build:web` 写到 `out/web/aw.js`、`out/web/page.js`（同样 minify，不入库）；`connect web` 和测试前先跑 `build:web`。

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
