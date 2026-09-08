# 提案：常量连线（`aw-connect@to` 支持常量表达式）

> 状态：**已实现**（2026-09-08 评审通过；约束已并入 `connect-html.md` §3.5.3，本文保留评审记录）。
> 关联：[`connect-html.md`](./connect-html.md) §3.5–3.6、[`connect-rules.md`](./connect-rules.md) §5。

## 1. 问题

现状：`aw-connect@to` 只允许**净网名**（标识符 + `${…}` 变量）。

若作者写 `to="32'h0"` / `to="{48{1'b1}}"` / `to="{${idx}{1'b0}}"`（把端口绑到常量）：

- **check 不拦**（`checkNetName` 只拒 `[]`）；
- **elaborate 出错品**：按网名建 `aw-signal name="32'h0"` → 打印非法 SV（非法标识符声明）。

即「能写、不报错、出坏 RTL」——比直接报错更糟，必须显式支持或显式拒绝。

## 2. 方案 A（推荐）：`to` 二态——净网名 或 常量表达式

> 评审（2026-09-08）：按推荐实现。宏按常量原样内联；宽度不检查（EDA 兜底）；常量表达式 = 字面量 + 拼接/复制 + 变量代入（不做算术求值）；param/localparam 引用引擎自动甄别，不设专门属性。

### 2.1 语法

`aw-connect@to` 扩展为：

```html
<aw-connect port="load_i"  to="1'b0"></aw-connect>
<aw-connect port="clr_i"   to="{48{1'b1}}"></aw-connect>
<aw-connect port="d_i"     to="{${idx}{1'b0}}" width="..."></aw-connect>
```

### 2.2 判定规则（先变量代入，再分类）

`elaborate` 在 `substVars`（`${id}`/`${idx}`/`${mod}`/本模 param/localparam）之后分类：

| 代入后文本形态 | 分类 |
|---|---|
| 合法标识符（`^[A-Za-z_][A-Za-z0-9_]*$`） | **网名**（现有语义不变） |
| 以数字 / `'` / `{` / `` ` `` 开头 | **常量表达式**（SV 字面量、拼接、复制、宏） |
| 其他 | **报错** |

标识符不可能以数字/`'`/`{`/`` ` `` 开头，二态无歧义。

### 2.2.1 param / localparam 引用甄别（评审裁定：不设专门属性）

引擎持有本模作用域，无需作者标注：

| 代入后文本 | 判定 |
|---|---|
| 单一标识符，命中本模 `aw-param` / `aw-localparam` | **常量引用**（如 `to="CNT_W"`；同名建网本就撞名非法，归入常量无副作用） |
| 含运算符/拼接的文本，**全部**标识符命中本模 param/localparam | **常量表达式**（如 `CNT_W+1`、`{CNT_W{1'b0}}`） |
| 上述文本中含**未知名**标识符 | 报错（防 typo 网名） |

printer 侧同判：render 快照自带 `aw-params` / `aw-localparams` 名单，无新增属性。


`check` 阶段做同形预检（变量位置视作透传）：既非标识符模板、又非常量起始 → 报错「不是净网名也不是常量」。

### 2.3 语义

| 面 | 规则 |
|---|---|
| `aw-signals` | 常量**不建网**（不进 signals，不参与维度合并/冲突，不触发自动导出端口） |
| `part` | 与常量**互斥**（常量选位非法/无意义）→ 同写报错 |
| `packed`/`unpacked`/`width`/`nettype` | 常量连线**忽略并报错**（无网可声明；宽度由常量自身宽度决定） |
| `aw-rewrite@to` | **支持常量**（评审裁定）：match 命中的端口统一绑常量（批量 tie-off）；`to` 为常量时**禁止** `$1`/`$&`/`$<name>` 捕获 |
| `type` 属性 | **可选断言**（评审裁定）：`type="net\|const"`；引擎推断分类后校验，不一致 → 报错。缺省 = 纯推断 |
| `aw-render` 表示 | `aw-connect` 保留原文：`to="32'h0"`，无额外属性（打印机按 §2.2 规则自行二态判定，golden 稳定） |
| dump 打印 | 网名 → `.port(net[part])`；常量 → `.port(32'h0)`（无 `part`） |
| 宽度匹配 | **不检查**（已裁定：EDA 工具链兜底） |

### 2.5 能力边界（评审裁定）

常量连线的表达式能力**故意收窄**：字面量（含 based literal）、拼接/复制 `{}`、`${…}` 变量代入、param/localparam 引用、宏原文内联。**不做**算术/三元/位运算等更复杂的信号·常量组合求值。

超出此边界的组合逻辑（如 `en & ~mask`、`cond ? a : b`）**必须**走「单独写一个集成小模块再例化」的路径——连接方言只描述连线与绑死，不内嵌逻辑表达式。

### 2.4 render / 下游不变量

- 常量连线的 `aw-connect` 不伴随任何 `aw-signal` 条目（dump 侧可据此断言一致性）。
- 输出端口连常量？**禁止**：常量只能驱动 input 端口（连 output/inout → 报错）。首版判定：叶子端口 dir ∈ {input} 才允许常量；`dir` 未知（黑盒）→ 报错。


## 3. 备选方案（不推荐，列出供对比）

**B. 独立属性**：`<aw-connect port="clr_i" const="32'h0">`（`to` 与 `const` 互斥）。
优：判定无启发式。劣：方言多一个属性，render/golden 多一种形态；与 `to` 的语义重叠易混。

**C. 专用标签**：`<aw-tie port="clr_i" value="32'h0">`。
劣：多一个标签；与 template/overwrite 的「同端口后写覆盖」机制要再对一套，不值。

方案 A 改动面最小、向后兼容（合法网名不受影响），推荐。

## 4. 影响面（实施清单）

| 处 | 改动 |
|---|---|
| `web/aw.js` | check：`to` 三态预检；elaborate：`ruleToConnect` 分类、`isConst` 标记、wires 跳过常量、part/维度属性互斥报错、rewrite 产非标识符报错 |
| `src/printer.ts` | connect 打印：标识符 → 网名路径（含 part），否则原样内联 |
| `src/aw.test.ts` | 新增：`32'h0` / `{48{1'b1}}` / `${idx}` 常量代入；常量+part 报错；常量不建网不导出；rewrite 产常量报错；output 端口连常量报错 |
| `src/printer.test.ts` | `.port(32'h0)` 内联形态 |
| demo | `phy_wrap_tb` 的 `u_lfsr.clr_i` 改绑 `1'b0`（真实闭合验证）；golden 重锁 |
| docs | connect-html §3.5/§3.6 表、connect-rules §5、本提案转正式约束 |
| 验证 | bun test + Verilator lint 全链（常量绑定的 `.sv` 过 lint） |

## 5. 开放项（已裁定，2026-09-08）

1. 常量宽度 vs 端口宽度：**不检查**（Verilator 等 EDA 兜底）。  
2. 常量表达式范围：**字面量 + 拼接/复制 + 变量代入**；不做算术求值。  
3. `` `MACRO `` 宏：**允许**，按常量原样内联。  
4. param/localparam 引用：**引擎自动甄别**（§2.2.1），不设专门属性。
