# 连接规则细则小结（template / rewrite / inst_name / param）

> 速查卡。完整骨架与流水线见 [`connect-html.md`](./connect-html.md)；示例见 [`examples/connect/01-author-simple.html`](./examples/connect/01-author-simple.html)。  
> 状态：草稿，先约束后实现。

## 1. 三条硬约束

1. **`aw-inst` 下不能直接挂规则**  
   `aw-param` / `aw-connect` / `aw-rewrite` **必须**包在 `<aw-template>` 里。

2. **dump 只认 `aw-render`**  
   `aw-templates` 与作者面 `aw-rewrite` 不进 netlist；展开后是逐条 `aw-connect`。

3. **rewrite = JS `RegExp` + `String.replace`**  
   核心属性 `match` + `to`（可选 `flags` / `width` / `part`）。`to` 仅为净网名。超出能力走 [`connect-lifecycle.md`](./connect-lifecycle.md)。

## 2. `aw-template`：放哪、怎么叠

| 写法 | 含义 |
|---|---|
| `<aw-template name="…">`（库内） | 可复用规则 |
| `<aw-template base="…">` | 引用本模库模板 |
| `<aw-template>…</aw-template>` | 匿名内联 |
| `<aw-template base="…">…子规则…</aw-template>` | 同标签 overwrite（后写覆盖） |
| 多个 `<aw-template>` 兄弟 | 按文档序展开，后者覆盖前者 |

`aw-inst` 作者面子节点 **只能**是上述 `aw-template`。模板名 **仅本 `aw-mod` 可见**。

## 3. `aw-template@inst_name`

- 属性在 **`aw-template`** 上。  
- **默认**：`` inst_name="${id}" ``。  
- 例：`` inst_name="${id}_${idx}" `` → `u_slice_0`。

## 4. 变量表达式 vs 正则捕获

| 种类 | 写法 | 含义 |
|---|---|---|
| 变量 / 上下文 | `` `${id}` `` `` `${idx}` `` `` `${mod}` ``，本模 param / 内部 localparam 名等 | 例化/模块上下文 |
| 正则捕获 | `$1`、`$&`、`$<name>` | 仅来自 `aw-rewrite@match` |

| 属性 | 变量表达式 | 正则捕获 |
|---|---|---|
| `aw-rewrite@to` | 允许 | 允许（先捕获，再 `${…}`） |
| `aw-connect@to` | 允许 | 禁止 |
| `packed`/`width`（非 `auto`）、`unpacked`、`part` | 允许 | 禁止 |
| `aw-param@expr` | 允许 | 禁止 |
| `aw-template@inst_name` | 允许 | 禁止 |

| 绑定 | 含义 |
|---|---|
| `${id}` | `aw-inst@id` |
| `${idx}` | `aw-inst@idx` |
| `${mod}` | `aw-inst@mod` |

## 5. `aw-rewrite` / `aw-connect` 连线

| 属性 | 说明 |
|---|---|
| `match` | rewrite 必须；RegExp 源；应当 `^…$` |
| `flags` | 可选；默认 `""` |
| `to` | 必须；**净网名**；禁止 `[]` / part-select |
| `packed` | 可选；默认 `auto`（跟端口 packed[/unpacked]）。多维用 RtlIndex 形 `[d0][d1]` |
| `unpacked` | 可选；非打包维 |
| `width` | 一维 packed 简写（`auto` \| `15:0`）；与 `packed` 冲突则报错 |
| `part` | 可选；连线 part-select；省略 = 整网 |
| `nettype` | 可选；`wire`\|`logic`；默认 dump `wire`（auto 时可继承端口） |

```html
<aw-connect port="dec_clk" to="dfi_clk"></aw-connect>
<aw-rewrite match="^slice_en$" to="slice_en_${idx}" packed="auto"></aw-rewrite>
<aw-rewrite match="^dec_in_(?<rest>.+)$" to="mst_blk_reg_$<rest>" packed="auto"></aw-rewrite>
<aw-rewrite
  match="^slice_data$"
  to="slice_data_bus"
  packed="15:0"
  part="8*${idx}+7:8*${idx}"
></aw-rewrite>
<aw-connect
  port="word"
  to="mem"
  packed="[31:0]"
  unpacked="[0:255]"
  part="[0]"
></aw-connect>
```

`net = port.replace(…)` → `aw-connect`（继承维 / `part` / `nettype`）。  
细则：[`connect-html.md`](./connect-html.md) §3.5.1–3.5.2。多维示例：[`examples/connect/04-author-multidim.html`](./examples/connect/04-author-multidim.html)。

## 6. Overwrite 速记

```html
<aw-template base="slice_template">
  <aw-connect port="slice_dbg" to="slice_1_dbg"></aw-connect>
  <aw-rewrite match="^slice_en$" to="slice_en_alt_${idx}"></aw-rewrite>
</aw-template>
```

同端口多条规则：后写覆盖。

## 7. `aw-param` → 唯一 `localparam`（可折叠）

作者：`<aw-param name="PIPE_NUM" expr="BUS_PIPE_NUM">`（在 `aw-template` 内）。  
render：每个例化覆盖生成父模唯一 localparam，回传例化，并改写依赖该 param 的端口宽度。

### 7.1 命名

```text
localparam <Mod>__<Inst>__<Param> = <Expression>;
```

分隔符为**双下划线**。例：`master_cfg_wrap__u_decoder__PIPE_NUM`。

### 7.2 折叠判定

| `expr` 形态 | 可否折叠 | `aw-localparam@value` |
|---|---|---|
| 常量字面量 | 折叠 | 字面量 |
| 单一标识符 = 本模 `aw-param` | 折叠 | 追到已解析值（可递归） |
| 单一标识符 = 本模内部 localparam（content 或已写入 render 的条目） | 折叠 | 同上 |
| 表达式（`W-1`、多操作数等） | 不折叠 | 保留表达式文本 |
| 宏 | 不折叠 | 保留宏原文 |

- 必须自动分类，不能靠作者标注。  
- 链上碰到表达式或宏 → 该 uniquify localparam 不折叠。  
- 单一标识符既非 param 也非 localparam → 不折叠（保留文本）。  
- render 宜带 `folded="true|false"`。

### 7.2.1 作者面内部 localparam

```html
<aw-localparams>
  <aw-localparam name="PIPE_NUM_I" expr="BUS_PIPE_NUM"></aw-localparam>
</aw-localparams>
<!-- expr="PIPE_NUM_I" → 可折叠 -->
```

禁止作者手写 `Mod__Inst__Param` 当 SoT。dump 顺序宜：本模声明 → uniquify 生成物。

### 7.3 生成与回传

1. 顶→底绑定 `aw-param@expr`，按 §7.2 分类。  
2. 生成 `localparam Mod__Inst__Param = …`。  
3. 例化写成该 localparam 名。  
4. 禁止要求作者手写 `__` 名。

### 7.4 端口宽度改写

对本例化端口表达式中依赖形参 `P` 的符号，替换为 `Mod__Inst__P`。宽度侧不因已折叠而内联字面量。

### 7.5 冲突

| 情况 | 要求 |
|---|---|
| 同 `Mod`+`Inst`+`Param` 再次生成 | 幂等；表达式不一致则报错 |
| 与父层 signal / param / localparam 撞名 | 报错（默认） |
| 不同 `Inst` | 名自然不同 |

### 7.6 示意

```html
<aw-localparam
  name="master_cfg_wrap__u_decoder__PIPE_NUM"
  value="2"
  folded="true"
  for-inst="u_decoder"
  for-param="PIPE_NUM"
></aw-localparam>
```

```systemverilog
localparam master_cfg_wrap__u_decoder__PIPE_NUM = 2;
master_decoder #(.PIPE_NUM(master_cfg_wrap__u_decoder__PIPE_NUM)) u_decoder (…);
```

## 8. 不要做

- 规则直接挂在 `aw-inst` 下  
- 手写 uniquify `Mod__Inst__Param` 当作者 SoT  
- 在 `aw-connect@to` / `aw-param@expr` / `aw-template@inst_name` / `packed`/`width`/`unpacked`/`part` 写正则捕获占位  
- 在 `to` 里夹 `[]` 或 part-select（用 `packed`/`unpacked`/`part`）  
- 用 `width` 塞多维 / unpacked（多维必须用 `packed`/`unpacked`）  
- 用 `$` 分隔 uniquify 名  
- 静默覆盖同名 localparam / 信号  
- 把宏或表达式当常量折叠  
- 跨 `aw-mod` 引用 `aw-template`  
- 同级 submods 环依赖、向后引用、或引用旁系孙子（共享须上提）  
- 跨 HTML 单元引用却未写入 toml `deps`（或 `deps` 成环）  
- 在 `deps` 里挂死边却忽略警告（写了依赖、elaborate 未引用 → 应删边）
