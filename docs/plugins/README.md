# Autowire 插件与自定义标签

> 状态：**类型 A 已落地；类型 B 暂时不做**（2026-09-27）。  
> Wishbone 是已落地的类型 A：`plugin wishbone run`。针对 `aw-*` 的自定义标签现在没有用途，类型 B 的登记、前缀和展开先保持本文的裁定，不写代码。  
> Wishbone 实例：[`wishbone-regfile.md`](./wishbone-regfile.md)（叶子）、[`wishbone-bus.md`](./wishbone-bus.md)（块内配置树）、[`wishbone-master.md`](./wishbone-master.md)（master 口 CDC/APB/JTAG）。

关键字「必须 / 应当 / 可以」按 RFC 2119。

## 1. 要不要通用插件？

**要。** 寄存器/总线只是一类功能模块；以后还有序列器、DMA 描述、文档导出、芯片专用包装等。  
宿主（autowire）应提供 **注册机制**；具体功能以插件交付，而不是把每一种都焊进 `aw.js` 核心方言。

核心方言保持小：`aw-mod` / `aw-content` / `aw-submods` / `aw-render` / template·connect·rewrite。  
扩展走插件：**注册自定义标签 +（可选）生成 / 展开**；**禁止**为插件另开端口信息旁路。

## 2. 两类插件（必须分清）

| 类型 | 作用 | 进引擎的方式 | 现状 |
|---|---|---|---|
| **A. 生成器（Generator）** | 印独立 SV（regfile、decoder、arbiter…） | 落盘 → `analysis run` → **RtlIndex 普通叶子**（`ctx.leaf`） | **已落地**：`plugin wishbone run` → `plugins_dir/wishbone/` |
| **B. 展开器（Elaborate）** | 把标签**展开成核心 `aw-*`** | 与本单元 **submods 同构**：内存 `ModFacts` / `childRenders` 向上递推 | **暂时不做**。当前没有要展开的 `aw-*` 插件标签 |

- Wishbone regfile + 块内 cfg 树 → **类型 A，已落地**。  
- 「一键例化标准包装并打好 template」→ **类型 B，暂时不做**。  
- **禁止**混用：类型 A **禁止**不经 analysis 假装已是可例化模；类型 B **禁止**直接写 SV 绕过 `connect run`。

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

## 4. 注册面

类型 A 的现网入口是 `autowire plugin <id> run`，不是下面这张表的运行时注册。类型 B 的标签登记先记在这里，等有 `aw-*` 插件标签再用。

```text
plugin id          唯一名（如 wishbone）
kind               generator | elaborate
tags[]             自定义元素名（类型 B；现在不用）
hooks              类型 B：expand / before-instances / on-template / before-dump
toml section       [plugins.wishbone] / [wishbone.<source>]
```

宿主 **必须**：

1. 未知标签且未注册 → check **报错**（勿静默忽略）。类型 B 未登记任何标签，所以这条现在只约束核心方言。  
2. 核心 `aw-*` **禁止**被插件覆盖。  
3. 类型 A 的 `run` **禁止**藏在 connect 页面里。命令是 `autowire plugin <id> run`。产物 **必须**进 `plugins_dir/<plugin-id>/`，**禁止**写入 `connect_dir` / `sim_dir`。自检（字段重叠、地址窗）在 `run` 时发生，不是 `aw.check()`。  
4. 类型 B 展开结果若落地，**必须**再过与核心相同的 connect check。当前不实现。

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

插件 **不推翻**「check ≠ elaborate、`connect run` 只认 `aw-render`」。

```text
plugin wishbone run (A)        ← 流水线外；→ plugins_dir → analysis run → RtlIndex
connect / sim 单元：
  → before-instances（脚本钩子；改作者面）
  → check（作者面 + deps）
  → elaborate（只认 aw-*；写 aw-render）
  → before-dump（只读）
  → connect run 写 .sv
```

类型 B 的 expand 若以后落地，插在 `before-instances` 之前，并且必须在 check 之前。现在没有这条步骤。elaborate **仍然只懂核心 `aw-*`**。

```text
A（已落地）: plugin wishbone run → plugins_dir/wishbone/*.sv → analysis run → leaf
B（暂时不做）: expand → aw-* → check → elaborate → connect run
```

## 7. 暂时不做

1. 类型 B 的登记 API（`registerPlugin()` 或目录扫描）和标签前缀。现在没有要展开的 `aw-*` 插件标签。  
2. 类型 A 的命令形状已落地，见 [`../cli.md`](../cli.md)。每个插件自己的 `run`，不共用 connect 的执行器。

已裁定、此阶段不改：A/B 分型；口表三路并进、无插件私有接口；A 用 hdxml 增量；B 的目标仍是像 submods、钩子同步。有具体标签需求再实现 B。
