# Autowire 插件与自定义标签

> 状态：**草稿，先约束后实现**。不堵连接核心轨道。  
> Wishbone 实例：[`wishbone-regfile.md`](./wishbone-regfile.md)（叶子）、[`wishbone-bus.md`](./wishbone-bus.md)（块内配置树）。  
> 改本文时同步 `help status` Parallel 条与 [`../architecture.md`](../architecture.md) §5。

关键字「必须 / 应当 / 可以」按 RFC 2119。

## 1. 要不要通用插件？

**要。** 寄存器/总线只是一类功能模块；以后还有序列器、DMA 描述、文档导出、芯片专用包装等。  
宿主（autowire）应提供 **注册机制**；具体功能以插件交付，而不是把每一种都焊进 `aw.js` 核心方言。

核心方言保持小：`aw-mod` / `aw-content` / `aw-submods` / `aw-render` / template·connect·rewrite。  
扩展走插件：**注册自定义标签 + 生命周期钩子 +（可选）代码生成**。

## 2. 两类插件（必须分清）

| 类型 | 作用 | 自定义标签产出 | dump / RtlIndex |
|---|---|---|---|
| **A. 生成器（Generator）** | 印独立 SV（regfile、decoder、arbiter、其它 IP 骨架） | 声明图 / 参数；**不**直接当 netlist | 先落盘 → `analysis` → connect 用普通 `aw-inst` 例化 |
| **B. 展开器（Elaborate）** | 在 elaborate 中把标签**展开成核心 `aw-*` 节点** | 最终必须变成合法 `aw-content` / `aw-inst` / … | 与核心相同：只认冻结后的 `aw-render` |

- Wishbone regfile 叶子 + 块内 cfg 树 → **类型 A**（见 wishbone-regfile / wishbone-bus）。  
- 「一键例化某标准包装并打好 template」→ **类型 B**（展开后与手写 connect 无异）。  
- **禁止**混用：类型 A 的标签 **禁止**假装已经是 `aw-submods` 里的包装模却不经 analysis；类型 B **禁止**直接往磁盘写 SV 绕过 dump。

## 3. 注册面（草案）

插件在加载时向宿主登记：

```text
plugin id          唯一名（如 wishbone-regfile、seq-asm）
kind               generator | elaborate
tags[]             自定义元素名（必须带插件前缀，见 §4）
hooks              可选：before-instances / on-template / before-dump（只读）/
                   generate（类型 A：写 SV）
toml section       可选：autowire.toml 中 [plugin.<id>] / [regfile.<id>] …
```

宿主 **必须**：

1. 未知标签且未注册 → check **报错**（勿静默忽略）。  
2. 核心 `aw-*` 标签 **禁止**被插件覆盖。  
3. 类型 A 的 `generate` **禁止**在 `/api/dump` 路径里偷偷写盘；**应当**有独立命令或明确的 generate 相位（如 `autowire plugin generate <id>`）；产物 **必须**落在 `plugins_dir/<plugin-id>/`（见 [`../workspace/toml.md`](../workspace/toml.md) §4.0），**禁止**写入 `connect_dir` / `sim_dir`。  
4. 类型 B 展开结果 **必须**能通过与核心相同的 connect check。

## 4. 自定义标签与 `aw-submods`

**可以**在 HTML 里写插件标签，但 **不是**「任意标签塞进 `aw-submods` 就生成」：

| 做法 | 裁定 |
|---|---|
| 标签名 | **必须**带前缀，避免污染核心：建议 `awx-<plugin>-…` 或插件登记名（如 `awx-wb-regfile`） |
| 放在 `aw-content` / 文档根下 | 类型 B：**可以**（展开为 `aw-inst` 等） |
| 放在 `aw-submods` 下 | **仅当**展开结果是合法嵌套 `aw-mod`（类型 B）；**禁止**类型 A 生成器挂在这里冒充子模 |
| 类型 A 声明页 | **必须**用独立清单（toml 插件节或独立 HTML 根），**禁止**登记为 `[connect.<id>]` 连接页 |
| 生成后再连线 | connect 里 **只**用核心 `<aw-inst mod="已生成模块">` |

因此：regfile/bus **适合**注册成插件并拥有自定义标签；这些标签描述的是 **生成声明**，不是 connect 子模树。其它功能模块同样走注册表，按 A/B 选型。

## 5. 推荐心智模型

```text
autowire.toml
  [plugin.wishbone-regfile] …     # 或 [regfile.*] 作为该插件的配置糖
  [plugin.other] …
  [connect.phy_wrap] html=…

plugin generate  →  plugins_dir/<plugin-id>/*.sv  →  analysis  →  RtlIndex
connect HTML     →  check → render → dump → connect_dir
sim HTML (TB)    →  check → render → dump → sim_dir
elaborate plugin tags → 核心 aw-* 节点后再走同一条 check/render
```

扩展其它功能时：

1. 新插件实现登记 API。  
2. 选 A 或 B。  
3. 注册前缀标签 + 可选 toml。  
4. **不要**改核心 `aw-submods` 语义来「顺便」支持生成。

## 6. 仍开放

1. 登记 API 形态：TS `registerPlugin()` vs 约定目录扫描。  
2. 前缀强制：`awx-` 固定 vs 插件 id 嵌入。  
3. 类型 A 触点：独立 CLI 子命令 vs `web` 页按钮。  
4. 类型 B 是否允许 `async` 钩子（与 connect-lifecycle 对齐）。

裁定后改本文 + wishbone-regfile §6 + help Parallel，再实现。
