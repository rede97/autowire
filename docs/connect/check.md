# `autowire check` 契约（作者面规则检查）

> 状态：**已实现**（`src/core/aw.ts` `check`；`connect check` 与页面 [Check] 同源——只做静态作者面，不跑 `<script>` / `on-init` / `on-template`）。  
> 展开期门禁（维合并/短路等，§2 表）用 `connect elaborate`：跑脚本和钩子，不落盘。
> 摘要：`bun index.ts help check`。改检查项时同步改本文与 help。

关键字「必须 / 应当 / 可以」按 RFC 2119。

## 1. 原则

1. **check 只看作者面**（`aw-content` + `aw-submods` + toml/`aw-mod` deps），**禁止**以 `aw-render` 为 SoT。  
2. **凡不依赖 elaborate 产物、用作者面 + RtlIndex/deps 上下文就能判的，应当进 check**（可提前失败）。  
3. **依赖展开 / 合流 / identity / 端口方向合流的，必须留在 elaborate**；Render 依赖 Check **不能**代替这类门禁。  
4. check **禁止**写 `.sv` / `gen/` / `.autowire/connect/`。

```text
check（本文）──error──▶ 拒绝 render
        │ ok
        ▼
elaborate（语义门禁）──error──▶ 拒绝 connect run 写盘
        │ ok → aw-render 冻结
        ▼
connect run（可印性）──error──▶ 拒绝写盘
```

页面 [Run] 在 check 或 elaborate 失败时同样中止，并且不写盘。

## 2. 职责总表

| 类别 | 阶段 | severity | 上下文 |
|---|---|---|---|
| 文档根 / 标签骨架 / 未知子节点 | **check** | error | DOM |
| `aw-inst` 下规则必须包在 `aw-template`；`base` 本模可见 | **check** | error | DOM |
| RegExp `match` 可编译；`to` / 属性互斥（open / const） | **check** | error | DOM + 本模 param/localparam 名单（probe 代入） |
| `type` 与推断不一致；缺 `to` 未声明 open | **check** | error | 同上 |
| 叶子 `aw-param` / `aw-connect@port` 是否存在于 RtlIndex | **check** | error | `ctx.leaf` |
| 例化目标：叶子 \| 直接子包装模 \| 可见集兄弟 \| 他单元模 | **check** | error | leaf / unitMods / deps |
| `aw-mod@deps`：未知兄弟 / 自依赖 / 环 | **check** | error | DOM |
| `aw-mod@deps` / toml `deps` 写了未引用 | **check** | **warn** | DOM + unitDeps |
| toml 跨单元引用未列入 `deps` | **check** | error | unitMods + unitDeps |
| identity 同名自动连；短路；维合并冲突 | **elaborate** | error（短路/维） | 端口表 + 展开结果 |
| const 打到非 input；open 打到非 output/inout | **elaborate** | error | 端口方向 |
| render 残留 template/rewrite | **dump** | error | aw-render |
| `[sim]` 根必须 `aw-tb-mod`；`[connect]` 禁止 | **check** | error | unitKind |
| `aw-tb-mod`：禁 params/ports/submods/`@deps`；`body-*-include` 仅 TB | **check** | error | DOM |
| `type="raw"`：仅 TB；禁 rewrite 产 raw；禁 part/维 | **check** | error | DOM |
| include 路径存在性 | — | （不做） | DV filelist / `+incdir` |
| 未注册自定义标签（插件前缀） | **check**（插件落地后） | error | 注册表 |
| 类型 B 展开后的核心 aw-* | **check**（expand 之后） | 同核心 | DOM |
| 类型 A 字段/地址等插件自检 | **generate**（非 aw.check） | error | 插件 |

> 插件口表：**禁止**第四条旁路；类型 A = RtlIndex `leaf`，类型 B = 展开后像 submods。见 [`../plugins/README.md`](../plugins/README.md) §3、§6。目标编排：静态 check → elaborate（[`lifecycle.md`](./lifecycle.md)）。

## 3. check 必须覆盖（对照实现）

### 3.1 文档与骨架

- 恰好一个顶层 `<autowire>`。  
- 每个 `aw-mod`：有 `name`；有 `aw-content`。  
- `aw-content` 子组标签合法；组内子标签符合方言。

### 3.2 模板与连线属性

- `aw-inst` 直接子只能是 `aw-template`。  
- `aw-rewrite` 必须有可编译的 `match`；`aw-connect` 必须有 `port`。  
- `type="open"`：禁止 `to` / `part` / 维 / `nettype`。  
- 非 open：必须有 `to`；代入后能分为 net 或 const；与 `type=` 声明一致。  
- const：禁 part/维/nettype；rewrite const 禁正则捕获。  
- net：`to` 为合法净网名（禁 `[]` / part-select 夹在名字里）。  
- `aw-connect@to` / `aw-param@expr` / `inst_name` / 维属性：禁 `$1` 类捕获（rewrite@to 除外）。

### 3.3 可见集与 deps（[`html.md`](./html.md) §3.3）

```text
visible(M) = { M 的直接子 aw-mod name }
           ∪ M.deps
           ∪ ⋃_祖先 A 的 A.deps
```

- **兄弟不自动可见**；不得把「先遍历兄弟的 deps」并进后兄弟的可见集。  
- 下降到子模时传入：`祖先可见 ∪ 本模 deps`（路径累积）。  
- 缺边 → error；多余 deps → warn；环 / 自依赖 / 未知名 → error。  
- 跨 HTML：toml `[connect.<id>] deps` 同纪律。

### 3.4 叶子表

- 已知叶子上：不存在的 port / param → error；localparam 不可 override → error。  
- 无叶子表时跳过端口存在性（仍做骨架与 deps）。

## 4. 非 check 职责（勿误判「Check 绿 = 可 dump」）

| 项 | 阶段 | 说明 |
|---|---|---|
| identity 自动连 | elaborate | 未覆盖端口同名连；见 to-rules §2.4 |
| 全网多 output 短路 | elaborate | |
| const/open 方向 | elaborate | 需端口 `dir` |
| 信号维冲突 / part 冲突 | elaborate | |
| 自动导出端口 | elaborate | |
| render 可印性 | connect run | 无残留 template/rewrite |

## 5. 与 Web / CLI

- `autowire connect check`、页内 [Check]、GET `?check=1` **同一** `check()`。页面没有 `POST /api/check`。  
- [Elaborate] / `?elaborate=1` **必须**先过 check（无 error）；elaborate 仍可再报 error。  
- [Run] 只把源码放进 `#aw-generated`。写盘是 `connect run`。  
- 目标编排：`on-init` 在 elaborate 里、本层展开之前；`check` 不跑脚本（[`lifecycle.md`](./lifecycle.md)）。  
- 详见 [`../workspace/web-ui.md`](../workspace/web-ui.md) §3.1。
