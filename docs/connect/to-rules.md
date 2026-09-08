# `aw-connect` / `aw-rewrite` 的 `to` 目标规则（net / const / open）

> 状态：**已实现**（评审记录见文末）。本文是 `to` 目标（连线挂到什么）的**唯一细则**；
> 骨架与总流程见 [`html.md`](./html.md)，速查见 [`rules.md`](./rules.md)。
> 关键字「必须 / 应当 / 可以」按 RFC 2119。

## 1. 三态总表

`to` 在 `${…}` 变量代入（§3.4.1）后分类；`type` 属性声明意图，**默认 `net`**。
**常量与悬空必须显式写明** `type="const"` / `type="open"`（二次评审裁定）：推断只用于校验，与声明不一致 → 报错。

| `type` | `to` 形态（代入后） | 语义 | dump 打印 |
|---|---|---|---|
| `net`（默认） | 合法标识符，且不命中本模 param/localparam | 网名：建网、维度合并、可自动导出端口 | `.port(net[part])` |
| `const` | 字面量 / 拼接复制 / 宏 / param·localparam 引用（下表） | 常量：**不建网**、只驱动 input、禁 part/维度属性 | `.port(32'h0)` |
| `open` | **无 `to`** | 显式悬空：**不建网**、只允许 output/inout | `.port()` |

### 1.1 const 的 `to` 形态（代入后）

| 文本 | 判定 |
|---|---|
| 单一标识符，命中本模 `aw-param` / `aw-localparam` | 常量引用（`to="CNT_W"`；同名建网本就撞名非法，归入常量无副作用） |
| 以数字 / `'` / `{` / `` ` `` 开头 | 字面量、拼接/复制、宏（宏原样内联不展开） |
| 含运算符且**全部**标识符命中本模 param/localparam | 常量表达式（`W+1`、`{W{1'b0}}`） |
| 含**未知名**标识符 | 报错（防 typo 网名） |

常量表达式**不做算术求值**；宽度不检查（EDA 兜底）。

### 1.2 推断（供校验与 printer 复用）

无 `type` 声明时引擎按 §1.1 推断：推断为 const 却未声明 → **报错**「constant must be declared type="const"」；声明与推断不一致 → 报错。
printer 侧同判（render 快照自带 `aw-params` / `aw-localparams` 名单），无新增 render 属性。

## 2. 各态细则

### 2.1 net（默认）

- `to` 只有网名（+ `${…}` 插值），**禁止**夹带 `[]` / part-select（选位用 `part`，声明维用 `packed`/`unpacked`/`width`）。
- `aw-rewrite@to` 允许正则捕获（`$1`/`$&`/`$<name>`，先捕获替换再 `${…}`）；`aw-connect@to` **禁止**捕获。
- 维度 / `part` / `nettype` 规则见 connect-html §3.5.1–3.5.2。
- 同端口多条规则：后写覆盖（template 栈文档序）。

### 2.2 const（常量 / 常量表达式）

```html
<aw-connect port="load_i" to="1'b0" type="const"></aw-connect>
<aw-connect port="init_i" to="{${idx}{INIT_VAL}}" type="const"></aw-connect>
<aw-connect port="en_i"   to="`CFG_EN" type="const"></aw-connect>
<aw-connect port="mode_i" to="MODE" type="const"></aw-connect>
<aw-rewrite match="^test_.*_i$" to="1'b0" type="const"></aw-rewrite>   <!-- 批量 tie-off -->
```

- 常量**不建网**（不进 `aw-signals`、不参与维度合并/冲突、不触发自动导出端口）。
- 只能驱动 **input** 端口；连 output/inout → 报错。
- `part` / `packed` / `unpacked` / `width` / `nettype` 与常量互斥（同写报错）。
- 常量 rewrite = 批量 tie-off：**禁止**正则捕获；match **必须覆盖全端口名**（`String.replace` 只替换命中段）。
- 同端口覆盖语义同 net（后写覆盖，可被后续 net/open 规则覆盖）。

### 2.3 open（显式悬空）

```html
<aw-connect port="q_o" type="open"></aw-connect>
<aw-rewrite match="^dbg_" type="open"></aw-rewrite>   <!-- 批量悬空 -->
```

- **open 必须显式**：`aw-connect` 缺 `to` 且未声明 `type="open"` → 报错（防止漏写 `to` 被当悬空）。
- 只允许 **output** / **inout**；input 悬空 → 报错并提示改用 const 绑死（input 悬空几乎总是 bug）。
- 禁 `to` / `part` / 维度属性 / `nettype`；rewrite 形态不写 `to`（无替换文本）。
- 不建网；render 落 `<aw-connect port="q_o" type="open">`（golden 可见的意图记录）；dump 打印 `.q_o()`（消 PINMISSING）。
- 覆盖语义同 net（后写覆盖：open 可被后续 net/const 覆盖，反之亦然）。

### 2.4 未覆盖端口告警

elaborate 时，目标端口表中**未被任何规则覆盖**的端口（既未连线、也未 const、也未 open）逐一产生 **warning**（不阻止），文案列出 `inst.port`。open 是消警的显式手段。

### 2.5 能力边界

连接方言的常量表达式能力**故意收窄**：字面量（含 based literal）、拼接/复制、`${…}` 代入、param/localparam 引用、宏原文内联。
更复杂的信号·常量组合（三元、位运算等）**不内嵌**于连接方言——**必须**单独写集成小模块再例化。

## 3. render / 下游不变量

- const/open 的 `aw-connect` 不伴随任何 `aw-signal` 条目（dump 侧可断言一致性）。
- render 表示：net/const 保留 `to` 原文（无 `type`）；open 落 `type="open"`（无 `to`）。
- dump 门禁照常验 render 无残留 template/rewrite。

## 4. 评审记录

- 2026-09-08 初评：常量方案 A（推断）通过；宏按常量原样内联；宽度不检查；字面量+拼接/复制+变量代入，不做算术求值；param/localparam 引擎自动甄别，不设专门属性。
- 2026-09-08 二审：常量 rewrite 支持（禁捕获）；`type` 属性引入。
- 2026-09-08 三审：**`type` 默认 `net`；const / open 必须显式写明**；open 采用建议默认值（input 报错、遗漏告警纳入、inout 允许）。
- 文档史：`connect-const-proposal.md` 与 `connect-open-proposal.md` 两份提案合并为本文（net/const/open 规则集中于此）。
