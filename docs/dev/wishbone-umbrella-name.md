# Wishbone 伞文件按项目名命名（设计草稿）

> 状态：**设计已确认（2026-09-28，均按推荐），待实现**。决定：顶层身份表用 `[workspace]`；
> UVM 伞保留 `ral_` 前缀；hdxml 二进制键用 `[analysis] hdxml_bin`。
> 背景：伞文件当前硬编码为 `wishbone.h` / `ral_wishbone.sv`，跨工作区集成时文件名与 include 卫兵会撞名。

## 1. 目标

引入一个**显式的全局项目名**（类比 Rust `Cargo.toml` 的 `[package] name`），作为整个工作区的
身份标识；wishbone 插件的两个**伞文件**（C 聚合头、UVM 聚合 RAL）及其 include 卫兵改为按它生成，
根治跨工作区撞名，并让 DV/固件树里一眼看出属于哪颗芯片。

**仅影响两个伞文件本身**：各叶子/总线文件（`regfile/<sheet>.h`、`bus/<bus>_map.h`、
`regfile/ral_<SHEET>.sv`、`bus/ral_block_<bus>.sv`）本就按自身身份命名，不变；伞里的 `#include` /
`` `include `` 目标也不变（相对子目录名不动）。

## 2. 配置契约：全局名（Cargo 风格）

`autowire.toml` 顶部新增 `[workspace]` 表承载工作区身份，并把**输出落盘（dump）**与
**输出排版（style）**这两组"本工作区如何产出"的配置收敛为它的子表：

```toml
[workspace]
name = "hbm_phy_top"

[workspace.dump]           # 原 [dump]
connect_dir = "rtl/gen/connect"
sim_dir     = "rtl/gen/sim"
plugins_dir = "rtl/gen/plugins"

[workspace.style]          # 原 [style]
port_align = true
# ...
```

- `name`：**全局、显式、强制、无默认**——类比 `Cargo.toml` 里每个 crate 必有 `[package] name`，
  每个 `autowire.toml` 都必须提供；缺失时 `workspace.ts` 加载即报错（英文）。
- `name` 必须是合法 C 标识符词干：`^[A-Za-z_][A-Za-z0-9_]*$`（要落进文件名与 C 宏卫）。
- `[workspace.dump]` / `[workspace.style]`：字段与语义完全沿用原 `[dump]` / `[style]`，只是挪了位置。
- 语义上 `[workspace]` 是**工作区级**身份与产出配置；wishbone 只是第一个消费 `name` 的地方。

- `[hdxml]` 表删除：它当前只有一个可选键 `bin`（hdxml 二进制路径），而 `analysis` 本就是唯一
  调用 hdxml 的命令，二进制路径还能从 `--hdxml` / `$HDXML_BIN` / 默认查找链兜底，故独立成表与
  `analysis` 职责重叠。把 `bin` 折进 `[analysis]`：`[analysis] hdxml_bin = "..."`（仍可选，
  缺省走原查找链）。
- **其余表按现状保留、不挪动**：`[analysis.*]`、`[plugins.*]`、`[wishbone.*]`、`[connect.*]`、
  `[sim.*]` 仍是顶层（只动 dump / style / hdxml）。

> 已确认的决定：顶层身份表名 `[workspace]`；hdxml 二进制键用 `[analysis] hdxml_bin`。

## 3. 命名规则（文件名与 guard 都随全局名）

以 `name = "hbm_phy_top"` 为例：

- C 伞文件：`<name>.h` → `hbm_phy_top.h`，宏卫 `<NAME>_H` → `HBM_PHY_TOP_H`
- UVM 伞文件：`ral_<name>.sv` → `ral_hbm_phy_top.sv`，宏卫 `RAL_<NAME>_SV` → `RAL_HBM_PHY_TOP_SV`

`<NAME>` = `name` 大写、非字母数字转 `_`。UVM 伞保留 `ral_` 前缀（与 `ral_block_*` / `ral_<SHEET>` 一致）。

## 4. init 要求传入 name

`autowire init` 改为 `autowire init <name>`：

- `<name>` 为必填参数，缺失时报错并打印用法。
- 校验规则同 §2。
- 写出的脚手架把 `[workspace] name = "<name>"` 作为**已激活**的顶部表（不是注释），
  因为它是每个工作区的必需身份，理应开箱即用。

## 5. 改动面（评审后执行）

- `src/workspace.ts`：
  - 解析顶层 `[workspace] name`（校验+强制），`WorkspaceConfig` 加 `name` 字段。
  - `[dump]` / `[style]` 的读取点从 `doc.dump` / `doc.style` 改为 `doc.workspace?.dump` / `doc.workspace?.style`（字段解析逻辑不变）。
  - hdxml 二进制读取点从 `doc.hdxml?.bin` 改为 `doc.analysis?.hdxml_bin`；删除 `[hdxml]` 表处理。
  - 沿用现有"重命名报错"风格：仍出现顶层 `[dump]` / `[style]` / `[hdxml]` 时，抛英文错误提示新位置。
  - `DEFAULT_TOML` 改为按传入 name 生成（函数化）：顶部写出激活的 `[workspace]` 及其 `dump` / `style` 子表，删除 `[hdxml]` 段，`hdxml_bin` 作为注释示例挂到 `[analysis]`。
- `src/plugins/wishbone/generate.ts`：伞文件名（:144/:163）与宏卫（:97-98/:112-113）改为按
  `ws.name` 派生。
- `src/cli/analysis.ts`：`init` 增加 `<name>` 必填参数并注入脚手架。
- `src/cli/help.ts`：更新 `init` 用法、`[workspace] name` 说明、`c=`/`uvm=` 伞命名说明
  （AGENTS.md 要求 help 与行为同步）。
- 文档：`docs/workspace/toml.md`（新增 `[workspace]` 段）、`docs/plugins/wishbone-regfile.md`、
  `docs/plugins/wishbone-bus.md`、`docs/cli.md`。
- demo：`demo/hbm/autowire.toml`、`demo/soc/autowire.toml` 顶部加 `[workspace] name=`，
  把 `[dump]` / `[style]` 改写为 `[workspace.dump]` / `[workspace.style]`，删除 `[hdxml]` 段
  （soc 的 `[hdxml]` 目前只有注释、无 `bin`，直接删即可），重跑生成，重命名伞文件，并更新
  **所有**引用旧 `wishbone.h` / `ral_wishbone.sv` 的地方（`soc_map.h`、tb、filelist、测试）。
- 清理：删除旧伞文件（与上次评审记录的"重构缺旧产物清理" P2 一并处理）。
- 测试：`test/wishbone*.test.ts` 断言伞文件名/宏卫；toml 加载测试断言"缺 name 报错"。

## 6. 破坏性变更与迁移

`[workspace] name` 全局强制 → **每个**现有 `autowire.toml`（不仅是用 wishbone 的）都需补该表，
否则加载失败。此外 `[dump]` / `[style]` 移到 `[workspace.dump]` / `[workspace.style]`，
`[hdxml] bin` 移到 `[analysis] hdxml_bin`，旧位置均报错。迁移动作：所有 demo toml 顶部加
`[workspace] name=`，改写 `[dump]` / `[style]`，删除 `[hdxml]`；外部工作区同理。
此为有意为之（对齐 Cargo "每个包必有 name" 的显式约定，并把产出/工具配置收敛到对应表下）。
