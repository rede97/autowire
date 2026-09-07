# 连接规则细则小结（template / rewrite / inst_name）

> 速查卡。完整骨架与流水线见 [`connect-html.md`](./connect-html.md)；规范示例见 [`examples/connect/01-author-simple.html`](./examples/connect/01-author-simple.html)。  
> 状态：草稿，先约束后实现。

## 1. 三条硬约束

1. **`aw-inst` 下不能直接挂规则**  
   `aw-param` / `aw-connect` / `aw-rewrite` **禁止**作为 `aw-inst` 的直接子节点，**必须**包在 `<aw-template>` 里。

2. **dump 只认 `aw-render`**  
   `aw-templates`（库）与作者面 `aw-rewrite` **不进** netlist；展开后是逐条 `aw-connect`。

3. **rewrite 按 Web 惯例，不对齐 emacs**  
   用 JS `RegExp` + `String.replace`（`$1` / `$<name>`），或 `fn=`；**不用** emacs 的 `[]` / `@` / `port=_(.*)` 方言。

## 2. `aw-template`：放哪、怎么叠

| 写法 | 含义 |
|---|---|
| `<aw-template name="…">`（在 `aw-templates` 库里） | 定义可复用规则（类 `<style>`） |
| `<aw-template base="…">` | 引用库模板 |
| `<aw-template>…</aw-template>`（无 name/base） | 匿名内联 |
| `<aw-template base="…">…子规则…</aw-template>` | **同标签 overwrite**：先 `base`，再应用子规则（后写覆盖） |
| 多个 `<aw-template>` 兄弟 | **多模板组合**：按文档序展开，后者覆盖前者（也允许） |

`aw-inst` 的作者面子节点 **只能**是上述 `aw-template`（一个或多个）。

## 3. `inst_name`

- 属性在 **`aw-template`** 上（库定义或 overwrite 时可改）。  
- **默认**：未写 = 透传例化槽名，即 `` inst_name="${id}" ``。  
- 需要唯一名时显式写，例如 `` inst_name="${id}_${idx}" `` → `u_slice_0`。  
- 作者面可多个 `aw-inst` 共用同一 `id`，靠 `idx` + `inst_name` 在 render 里得到不同实例名。

## 4. 上下文插值 `${…}`

出现在 `inst_name`、`aw-rewrite@to`、`aw-param@expr` 等处（**不是** RegExp 捕获）：

| 绑定 | 含义 |
|---|---|
| `${id}` | `aw-inst@id`（槽名） |
| `${idx}` | `aw-inst@idx` |
| `${mod}` | `aw-inst@mod` |

与 RegExp 替换共存时：**先** `$1` / `$<name>`，**再** `${id}` 等（golden 锁死）。

## 5. `aw-rewrite` 写法

| 属性 | 说明 |
|---|---|
| `match` | JS RegExp **源**；对整个端口名，**应当**写 `^…$` |
| `flags` | 可选；默认 `""` |
| `to` | 与 `fn` **互斥**；`String.replace` 替换串 + `${…}` |
| `fn` | 与 `to` **互斥**；复杂重命名函数 |

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

### 5.2 函数路径

```html
<script type="module">
  aw.rewrite.define("sliceBus", (port, ctx) => { /* string | null */ });
</script>
<aw-rewrite match="^slice_out_" fn="sliceBus"></aw-rewrite>
```

- 签名：`(port, ctx: { id, idx, mod, instName }) => string | null`  
- `null` = 本规则跳过；`string` = net 名。  
- `fn` 可为注册名或 `./file.js#export`（禁止对外 `fetch`）。  
- 有 `match` 时先预过滤；仅有 `fn` 时可扫全部端口。

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

## 7. 不要做

- 把 `aw-connect` / `aw-rewrite` 直接写在 `aw-inst` 下  
- 用手写已展开的 `aw-render` 当作者 SoT  
- 用 emacs `[]` / `@` / 无锚定的「像 AUTO 的」改名串冒充本方言  
- 在 `to` 里混用未文档化的特殊后缀语义（需要复杂逻辑 → `fn`）
