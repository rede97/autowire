# Autowire 插件与自定义标签

> 状态：**草稿（接口已裁定，未落地）**。不堵连接核心轨道。  
> Wishbone 实例：[`wishbone-regfile.md`](./wishbone-regfile.md)（叶子）、[`wishbone-bus.md`](./wishbone-bus.md)（块内配置树）。  
> 改本文时同步 `help status` Parallel、[`../architecture.md`](../architecture.md) §5、[`../connect/lifecycle.md`](../connect/lifecycle.md)、[`../connect/check.md`](../connect/check.md)。

关键字「必须 / 应当 / 可以」按 RFC 2119。

## 1. 要不要通用插件？

**要。** 寄存器/总线只是一类功能模块；以后还有序列器、DMA 描述、文档导出、芯片专用包装等。  
宿主（autowire）应提供 **注册机制**；具体功能以插件交付，而不是把每一种都焊进 `aw.js` 核心方言。

核心方言保持小：`aw-mod` / `aw-content` / `aw-submods` / `aw-render` / template·connect·rewrite。  
扩展走插件：**注册自定义标签 +（可选）生成 / 展开**；**禁止**为插件另开端口信息旁路。

## 2. 两类插件（必须分清）

| 类型 | 作用 | 进引擎的方式 | dump / 缓存 |
|---|---|---|---|
| **A. 生成器（Generator）** | 印独立 SV（regfile、decoder、arbiter…） | 落盘 → `analysis` → **RtlIndex 普通叶子**（`ctx.leaf`） | `plugins_dir/<plugin-id>/`；索引走 `.autowire/hdxml/`（hash 增量） |
| **B. 展开器（Elaborate）** | 把标签**展开成核心 `aw-*`** | 与本单元 **submods 同构**：内存 `ModFacts` / `childRenders` 向上递推 | 与核心相同；跨单元仍用 `.autowire/connect/<id>.xml` |

- Wishbone regfile + 块内 cfg 树 → **类型 A**。  
- 「一键例化标准包装并打好 template」→ **类型 B**。  
- **禁止**混用：类型 A **禁止**不经 analysis 假装已是可例化模；类型 B **禁止**直接写 SV 绕过 dump。

## 3. 端口事实：并进现有三路（禁止第四条）

引擎认模块口只有：

| 来源 | 路径 | 插件怎么用 |
|---|---|---|
| `ctx.leaf` | `.autowire/hdxml/`（RtlIndex；analysis hash 增量） | **类型 A 唯一对外口表** |
| `childRenders` | 本单元 `aw-submods` elaborate 后内存递推 | **类型 B** 展开成 `aw-mod` 后走这条 |
| `ctx.wrapper` | `.autowire/connect/<id>.xml` | 跨 connect 单元；与是否插件无关 |

**裁定：**

1. **禁止**插件专用「`providePorts()` / 私有 XML 缓存」作为 check/elaborate 的权威口表。  
2. 类型 A 内部可以先算表再印 SV，但 **对外**必须以生成 RTL + hdxml 为准（与手写叶子同一失效规则：`definesFp` / mtime / hash）。  
3. 类型 B **不要**为展开结果另落插件 XML；本单元内存递推即可；仅当该单元 dump 后被他单元 `deps` 引用时，写现有 connect 快照。  
4. bus 树多个生成模（arb/decoder/regfile）= 多个 **RtlIndex 叶子**，不是「插件树向上递推」的第三条链。

## 4. 注册面（草案）

```text
plugin id          唯一名（如 wishbone、seq-asm）
kind               generator | elaborate
tags[]             自定义元素名（必须带插件前缀，见 §5）
hooks              可选：expand（类型 B）/ before-instances / on-template / before-dump（只读）/
                   generate（类型 A：写 SV）
toml section       可选：[plugins.wishbone] / [wishbone.<source>] …
```

宿主 **必须**：

1. 未知标签且未注册 → check **报错**（勿静默忽略）。  
2. 核心 `aw-*` **禁止**被插件覆盖。  
3. 类型 A 的 `generate` **禁止**藏在 `/api/dump`；**应当**独立相位（如 `autowire plugin generate <id>`）；产物 **必须**进 `plugins_dir/<plugin-id>/`（[`../workspace/toml.md`](../workspace/toml.md) §4.0），**禁止**写入 `connect_dir` / `sim_dir`。  
4. 类型 B 展开结果 **必须**再过与核心相同的 connect check（见 §6）。  
5. 类型 A 插件自检（字段重叠、地址窗等）在 **generate** 时跑，**不是** `aw.check()` 方言清单的一部分。

## 5. 自定义标签与 `aw-submods`

| 做法 | 裁定 |
|---|---|
| 标签名 | **必须**登记且带插件前缀；regfile **禁止** `awx-reg-*` HTML 描述树（见 [`wishbone-regfile.md`](./wishbone-regfile.md) §3.1） |
| 放在 `aw-content` / 文档根 | 类型 B：**可以**（展开为 `aw-inst` 等） |
| 放在 `aw-submods` | **可以**：嵌套 `aw-mod`（类型 B 展开结果） |
| 类型 A 声明 | toml `[wishbone.<source_id>] ts=` 指向含一个或多个 `RegfileDef` / `BusDef` 的 `.ts`；可选 `exports=`；**禁止** `html=` 当 SoT |
| 生成后再连线 | connect **只**用 `<aw-inst mod="已生成模块名">`（或薄 WB 包装） |
| 寄存器 SoT | **仅** TS `Regfile(...)` 命名导出；Excel 仅文档（`plugins.wishbone.export`；`sheet` 空 = `name`）；**禁止** HTML/其它 DSL 当权威；**禁止**放进 `aw-content` |
## 6. 与 connect 生命周期的关系（目标编排）

插件 **不推翻**「check ≠ elaborate、dump 只认 `aw-render`」。要扩的是**编排顺序**与注册面：

```text
[可选] plugin generate (A)     ← 流水线外；→ plugins_dir → analysis → RtlIndex
connect / sim 单元：
  → [B] expand 自定义标签 → 核心 aw-*
  → before-instances（脚本钩子；改作者面）
  → check（核心方言 + 未知未注册标签；见 check.md）
  → elaborate（只认 aw-*；on-template；写 aw-render）
  → before-dump（只读）
  → dump
```

- 类型 A **不插入** check↔elaborate 之间。  
- 类型 B expand 与 `before-instances` 同属「改作者面」→ **必须在 check 之前**（落地时 page/cli 与插件一并改；见 [`../connect/lifecycle.md`](../connect/lifecycle.md)）。  
- elaborate **仍然只懂核心 `aw-*`**；**禁止**在 `on-template` 写盘或绕过 render。  
- 类型 B 钩子 **先同步**（与现网 `aw.on` 一致；不开放 async）。

心智模型：

```text
autowire.toml
  [plugins.wishbone] …
  [connect.phy_wrap] html=…

A: generate → plugins_dir/<id>/*.sv → analysis → leaf
B: expand → aw-* → check → elaborate → dump
```

## 7. 仍开放（实现细节）

1. 登记 API：`registerPlugin()` vs 目录扫描。  
2. 前缀强制：`awx-` 固定 vs 嵌入 plugin id。  
3. 类型 A 触点：CLI 子命令 vs web 按钮。  

已裁定（勿再打开）：A/B 分型；口表三路并进、无插件私有接口；A 用 hdxml 增量；B 像 submods；generate ⊥ dump；expand→check→elaborate；B 钩子同步。
