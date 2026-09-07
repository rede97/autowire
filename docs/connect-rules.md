# 连接规则细则小结（template / rewrite / inst_name / param）

> 速查卡。完整骨架与流水线见 [`connect-html.md`](./connect-html.md)；规范示例见 [`examples/connect/01-author-simple.html`](./examples/connect/01-author-simple.html)。  
> 状态：草稿，先约束后实现。

## 1. 三条硬约束

1. **`aw-inst` 下不能直接挂规则**  
   `aw-param` / `aw-connect` / `aw-rewrite` **禁止**作为 `aw-inst` 的直接子节点，**必须**包在 `<aw-template>` 里。

2. **dump 只认 `aw-render`**  
   `aw-templates`（库）与作者面 `aw-rewrite` **不进** netlist；展开后是逐条 `aw-connect`。

3. **rewrite 按 Web 惯例，不对齐 emacs**  
   用 JS `RegExp` + `String.replace`（`$1` / `$<name>`）；**禁止** `fn=`；**不用** emacs 的 `[]` / `@` / `port=_(.*)` 方言。  
   超出 `match`+`to` 的处理见 [`connect-lifecycle.md`](./connect-lifecycle.md)。

## 2. `aw-template`：放哪、怎么叠

| 写法 | 含义 |
|---|---|
| `<aw-template name="…">`（在 `aw-templates` 库里） | 定义可复用规则（类 `<style>`） |
| `<aw-template base="…">` | 引用库模板 |
| `<aw-template>…</aw-template>`（无 name/base） | 匿名内联 |
| `<aw-template base="…">…子规则…</aw-template>` | **同标签 overwrite**：先 `base`，再应用子规则（后写覆盖） |
| 多个 `<aw-template>` 兄弟 | **多模板组合**：按文档序展开，后者覆盖前者（也允许） |

`aw-inst` 的作者面子节点 **只能**是上述 `aw-template`（一个或多个）。

## 3. `aw-template@inst_name`

- 属性在 **`aw-template`** 上（库定义或 overwrite 时可改）。  
- **默认**：未写 = 透传例化槽名，即 `` inst_name="${id}" ``。  
- 需要唯一名时显式写，例如 `` inst_name="${id}_${idx}" `` → `u_slice_0`。  
- 作者面可多个 `aw-inst` 共用同一 `id`，靠 `idx` + `aw-template@inst_name` 在 render 里得到不同实例名。

## 4. 变量表达式 vs 正则捕获（属性方言）

两类占位符不要混用：

| 种类 | 写法 | 含义 |
|---|---|---|
| **变量 / 上下文** | `` `${id}` `` `` `${idx}` `` `` `${mod}` ``，以及本模 param 名等标识符 | 例化/模块上下文插值 |
| **正则捕获** | `$1`、`$&`、`$<name>`（JS `String.replace`） | 仅来自 `aw-rewrite@match` 的匹配结果 |

### 4.1 各属性允许什么

| 属性 | 变量表达式 | 正则捕获（`$1` / `$<name>`） |
|---|---|---|
| `aw-rewrite@to` | **允许**（与捕获可共存） | **允许** |
| `aw-connect@to` | **允许** | **禁止** |
| `aw-param@expr` | **允许** | **禁止** |
| `aw-template@inst_name` | **允许** | **禁止** |

`aw-rewrite@to` 若同时含两类：**先**做 RegExp `$1`/`$<name>`，**再**做 `` `${…}` ``（golden 锁死）。

### 4.2 变量绑定表

| 绑定 | 含义 |
|---|---|
| `${id}` | `aw-inst@id`（槽名） |
| `${idx}` | `aw-inst@idx` |
| `${mod}` | `aw-inst@mod` |

另：`aw-param@expr` / `aw-connect@to` 还可写**本模参数名**、**本模内部 localparam 名**、字面量、以及由它们组成的**变量表达式**（如 `BUS_PIPE_NUM`、`PIPE_NUM_I`、`${idx}`）；是否折叠见 §7.2。  
**不是**「对端口名做 match 之后的捕获结果」。

## 5. `aw-rewrite` 写法

| 属性 | 说明 |
|---|---|
| `match` | **必须**；JS RegExp **源**；对整个端口名，**应当**写 `^…$` |
| `flags` | 可选；默认 `""` |
| `to` | **必须**；`String.replace` 替换串（可含 `$1` / `$<name>`）+ 变量 `` `${…}` `` |
| `fn` | **禁止**（已移除） |

### 5.1 推荐模式（作者面）

```html
<!-- 精确连线：用 connect，不必 rewrite -->
<aw-connect port="dec_clk" to="dfi_clk"></aw-connect>

<!-- 精确改名：全锚定 -->
<aw-rewrite match="^slice_en$" to="slice_en_${idx}"></aw-rewrite>

<!-- 编号捕获 -->
<aw-rewrite match="^slice_out_(.+)$" to="slice_${idx}_out_$1"></aw-rewrite>

<!-- 具名捕获（可读性更好时优先） -->
<aw-rewrite match="^dec_in_(?<rest>.+)$" to="mst_blk_reg_$<rest>"></aw-rewrite>
```

展开概念：`net = port.replace(new RegExp(match, flags), to)`，再做 `${…}` → 生成 `aw-connect`。

高级 / 不规则逻辑 **不要**再发明 `fn`；按渲染生命周期嵌入脚本，见 [`connect-lifecycle.md`](./connect-lifecycle.md)。

## 6. Overwrite 速记

```html
<!-- 推荐：同标签 -->
<aw-template base="slice_template">
  <aw-connect port="slice_dbg" to="slice_1_dbg"></aw-connect>
  <aw-rewrite match="^slice_en$" to="slice_en_alt_${idx}"></aw-rewrite>
</aw-template>

<!-- 也行：多兄弟 -->
<aw-template base="slice_template"></aw-template>
<aw-template>
  <aw-connect port="slice_dbg" to="slice_1_dbg"></aw-connect>
</aw-template>
```

同端口多条规则：**后写覆盖**（含 connect 与 rewrite 之间）。

## 7. `aw-param` → 唯一 `localparam`（可折叠）

作者面仍写 `<aw-param name="PIPE_NUM" expr="BUS_PIPE_NUM">`（在 `aw-template` 内）。  
dump / `aw-render` 侧对**每个例化覆盖**生成父模内唯一 localparam，再回传给例化，并改写依赖该 param 的端口宽度。

### 7.1 命名（分隔符：双下划线）

```text
localparam <Mod>__<Inst>__<Param> = <Expression>;
```

- `<Mod>`：父 `aw-mod@name`（或实现钉死的合法化后的模名）  
- `<Inst>`：该例化最终实例名（`inst_name` 求值后，如 `u_slice_0`）  
- `<Param>`：子模形参名（如 `PIPE_NUM`）  
- 例：`localparam master_cfg_wrap__u_decoder__PIPE_NUM = 2;`

**禁止**用单 `$` 作分隔符。

### 7.2 折叠判定（自动检查）

对 `aw-param@expr`（经 `${…}` 插值后）做分类，再决定 `aw-localparam@value` 写什么：

| `expr` 形态 | 可否折叠 | `aw-localparam@value` |
|---|---|---|
| **常量字面量**（如 `2`、`32'h0`、`'0`） | **折叠** | 字面量本身 |
| **继承当前模块参数**：单一标识符，且名为本 `aw-mod` 的 `aw-param`（本模 parameter） | **折叠** | 追到该参数的已解析值（字面量，或再按本表递归；见下） |
| **引用本模内部 localparam**：单一标识符，且名为本模作者面 `aw-content`/`aw-localparams` 中的条目，**或**本轮已写入 `aw-render`/`aw-localparams` 的条目（含其它 `Mod__Inst__Param`） | **折叠** | 追到该 localparam 的已解析值（同递归规则） |
| **表达式**（运算符、多操作数、函数调用、位选拼接等，如 `W-1`、`A+B`、`{B{1'b0}}`） | **不折叠** | 保留表达式文本；其中对本模 param / 已 uniquify localparam 的引用按符号改写规则处理，**数值不内联** |
| **宏**（`` `NAME ``、或分析时来自 define / `.svh` 的宏符号） | **不折叠** | 保留宏形态原文；**禁止**当常量折掉（宏属预处理宇宙，与 `definesFp` 一致） |

补充：

- 「是不是表达式」：**必须**自动检查（解析/分类），不能靠作者标注。  
- 继承 / 引用链：`子覆盖 → 本模 param | 本模内部 localparam → …` 若最终落到常量，则整链 **折叠**为该常量写入 uniquify localparam。  
- 链上若中间碰到**表达式**或**宏** → 该 uniquify localparam **不折叠**（右值保留表达式/宏文本；仍可指向被引用的 localparam **符号名**）。  
- 单一标识符既非本模 param、也非本模 localparam → **不折叠**（保留标识符文本；实现可另报未解析警告，须文档化）。  
- 可选属性 `folded="true|false"` 写在生成的 `aw-localparam` 上，便于 golden / 调试（实现宜输出）。

### 7.2.1 作者面内部 localparam

`aw-content` 内 **可以**声明本模内部 localparam（与 `aw-params` 并列的 `aw-localparams`），供例化 `aw-param@expr` 引用并参与上述折叠：

```html
<aw-content>
  <aw-params>
    <aw-param name="BUS_PIPE_NUM" expr="2"></aw-param>
  </aw-params>
  <aw-localparams>
    <aw-localparam name="PIPE_NUM_I" expr="BUS_PIPE_NUM"></aw-localparam>
  </aw-localparams>
  …
  <aw-inst id="u_decoder" mod="master_decoder">
    <aw-template>
      <!-- 匹配内部 localparam → 可自动折叠 -->
      <aw-param name="PIPE_NUM" expr="PIPE_NUM_I"></aw-param>
    </aw-template>
  </aw-inst>
</aw-content>
```

- 作者面内部 `aw-localparam` 用 `name` + `expr`（变量表达式；**禁止**正则捕获）。  
- **禁止**作者手写 uniquify 名 `Mod__Inst__Param` 当 SoT；那一类只由 elaboration 写入 `aw-render`/`aw-localparams`。  
- dump 时：作者内部 localparam 与 uniquify 生成物一并出现在 `aw-render`/`aw-localparams`（实现钉死顺序：宜先本模声明，再 `Mod__Inst__Param`）。

### 7.3 生成与回传

1. **顶 → 底**绑定 `aw-param@expr`（可含父 param / 本模内部 localparam / 上下文 `${…}`），按 §7.2 分类。  
2. 在父模 / `aw-localparams` 生成：  
   `localparam Mod__Inst__Param = <value按§7.2>;`  
3. 例化参数覆盖写成该 localparam 名，例如：  
   `.PIPE_NUM(master_cfg_wrap__u_decoder__PIPE_NUM)`  
4. **禁止**要求作者手写这些 `__` 名。

### 7.4 端口宽度改写

若叶子端口（RtlIndex `ExprText`）位宽/维度依赖某形参 `P`，且本例化对 `P` 有覆盖：

- 对该例化相关端口表达式中的符号 `P`，**必须**替换为 `Mod__Inst__P`（与例化覆盖共用同一 localparam 符号，避免分叉）。  
- 宽度侧 **不**因 localparam 已折叠就改成内联字面量（仍引用 `Mod__Inst__P`）；折叠只体现在 `localparam … = <字面量>` 的右值。  
- **仅**改写该例化绑定范围内的 deps；**禁止**误伤父层或其他例化的同名符号。

### 7.5 冲突

| 情况 | 要求 |
|---|---|
| 同 `Mod`+`Inst`+`Param` 再次生成 | 幂等；`Expression` 必须一致，否则 **报错** |
| 生成名与父层已有 signal / param / localparam 撞车 | **报错**（或实现提供转义前缀，须文档化；默认报错） |
| 两例化不同 `Inst` | 名自然不同，不冲突 |

### 7.6 示意

作者：

```html
<aw-inst id="u_decoder" mod="master_decoder">
  <aw-template>
    <aw-param name="PIPE_NUM" expr="BUS_PIPE_NUM"></aw-param>
  </aw-template>
</aw-inst>
```

dump 概念（父模 `master_cfg_wrap`，`BUS_PIPE_NUM` 已折为 `2`）——`aw-render` 形态：

```html
<aw-localparams>
  <aw-localparam
    name="master_cfg_wrap__u_decoder__PIPE_NUM"
    value="2"
    folded="true"
    for-inst="u_decoder"
    for-param="PIPE_NUM"
  ></aw-localparam>
</aw-localparams>
<aw-insts>
  <aw-inst id="u_decoder" mod="master_decoder">
    <aw-param name="PIPE_NUM" value="master_cfg_wrap__u_decoder__PIPE_NUM"></aw-param>
  </aw-inst>
</aw-insts>
```

对应 SV：

```systemverilog
localparam master_cfg_wrap__u_decoder__PIPE_NUM = 2;
master_decoder #(
  .PIPE_NUM(master_cfg_wrap__u_decoder__PIPE_NUM)
) u_decoder ( /* ports; 宽度 deps 中 PIPE_NUM → 同上 localparam */ );
```

## 8. 不要做

- 把 `aw-connect` / `aw-rewrite` / `aw-param` 直接写在 `aw-inst` 下  
- 用手写已展开的 `aw-render` uniquify 名（`Mod__Inst__Param`）当作者 SoT；作者面内部 `aw-localparams` 只用本模自有名  
- 用 emacs `[]` / `@` / 无锚定的「像 AUTO 的」改名串冒充本方言  
- 在 `aw-connect@to` / `aw-param@expr` / `aw-template@inst_name` 里写 `$1`、`$<name>` 等正则捕获占位  
- 给 `aw-rewrite` 写 `fn=`，或在 `to` 里混用未文档化的特殊后缀语义（复杂逻辑 → [`connect-lifecycle.md`](./connect-lifecycle.md)）  
- 用 `$` 分隔 uniquify 名  
- 静默覆盖已存在的同名 localparam / 信号  
- 把宏或表达式当成常量折叠掉
