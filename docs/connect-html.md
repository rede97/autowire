# 连接 HTML 方言（实现约束）

> 状态：**草稿，先约束后实现**。禁止据此假装 `aw.js` / `web` / `dump` 已落地。  
> 摘要切片：`bun index.ts help connect`。改本文时同步改 help。  
> 关键字「必须 / 应当 / 可以」按 RFC 2119。  
> 结构以 [`examples/connect/01-author-simple.html`](./examples/connect/01-author-simple.html) 为准。  
> **细则速查**：[`connect-rules.md`](./connect-rules.md)。  
> **高级脚本**：[`connect-lifecycle.md`](./connect-lifecycle.md)。

## 1. 目标与边界

连接描述是一份或多份 **HTML**（可选 `<script type="module">`）。

| 阶段 | 名称 | 内容 |
|---|---|---|
| 输入 | **作者 HTML（`aw-content`）** | imports / param / 内部 localparam / 显式 port；具名 `aw-template`；例化 + 引用/overwrite |
| 输出 | **渲染结果（`aw-render`）** | 具体 instance、信号、导出端口、逐条连线（**生成物**） |

打印机、`/api/dump`、Playwright golden **必须**只认各 `aw-mod` 下的 **`<aw-render>`**，**禁止**把 `aw-content` / `aw-templates` 原文当 netlist。

`aw-rewrite` 使用浏览器 **`RegExp` + `String.replace`**（`$1` / `$<name>` + 变量 `` `${…}` ``）。非常规生成挂在渲染生命周期脚本上（[`connect-lifecycle.md`](./connect-lifecycle.md)），不挂在 rewrite 属性上。

## 2. 两层，禁止混淆

1. **`aw-content`** = 作者声明；**`aw-render`** = elaboration 产物。  
2. **`aw-submods`** = 子模块依赖（嵌套 `aw-mod`，递归）；与 content 内含分开。  
3. **`aw-templates`** 像 `<style>`：定义一次、多例化复用，可在例化上 overwrite；模板 **禁止**进入 dump。  
4. `aw-rewrite` 只在作者面；展开后 **必须**落成 `aw-render` 内逐条 `aw-connect`。  
5. 叶子端口表 **必须**只读 RtlIndex；连接页 **禁止**改 RTL 源。

## 3. 文档骨架

```text
<autowire>                          # 唯一文档根；dump/golden 外边界
  <aw-mod name="…">
    <aw-content>
      <aw-imports>…</aw-imports>    # package 导入；接口引用 package 时自底向上继承
      <aw-params>…</aw-params>
      <aw-localparams>…</aw-localparams>  # 可选：本模内部 localparam
      <aw-ports>…</aw-ports>
      <aw-templates>…</aw-templates>
      <aw-insts>…</aw-insts>
    </aw-content>
    <aw-submods>
      <aw-mod name="…">…</aw-mod>
    </aw-submods>
    <aw-render>
      <aw-params>…</aw-params>
      <aw-imports>…</aw-imports>    # 继承汇总后的 package 导入
      <aw-localparams>…</aw-localparams>
      <aw-ports>…</aw-ports>
      <aw-signals>…</aw-signals>
      <aw-insts>…</aw-insts>
    </aw-render>
  </aw-mod>
</autowire>
```

### 3.0 `<autowire>`

- 本文件连接树 **必须**整包在唯一 **`<autowire>`** 下。  
- 页内可有 `<html>` / `<body>`；**禁止**把壳外节点当连接 SoT。  
- 实现可用 `querySelector("autowire")` 取根。  
- **多份 HTML** 可互引（见 §6）；清单在 `autowire.toml` 的 `[connect] html`（路径数组，无连线细节）。

### 3.1 `<aw-mod>`

- `name`：模块名（必须）。  
- 子节点顺序 **应当**为：`aw-content` → `aw-submods` → `aw-render`。  
- 层次路径 = 自外向内 `aw-mod@name` 拼接（不含 `autowire`）。  
- 展开后例化 id 在**同一父路径下**必须唯一。

### 3.2 `<aw-content>`（内含，非依赖）

| 子组 | 含义 |
|---|---|
| `aw-imports` | package 导入；接口（本模或子模）引用 package 类型时，**自底向上自动继承**汇总到各层；作者无需逐层手抄 |
| `aw-params` | 本模参数 |
| `aw-localparams` | 可选：本模内部 localparam（`name`+`expr`）；可供例化 `aw-param@expr` 引用并参与折叠（[`connect-rules.md`](./connect-rules.md) §7） |
| `aw-ports` | **显式要导出**的端口 |
| `aw-templates` | 具名连接规则库（仅本 `aw-mod` 可见；**禁止**跨 `aw-mod` 引用） |
| `aw-insts` | 例化列表；每个 `aw-inst` 下**只能**放 `aw-template`；`mod` 引用已有模块，**禁止**在此定义子模体 |

### 3.3 `<aw-submods>`（依赖）

- 子级为嵌套 **`aw-mod`**，递归 elaboration。  
- 除引用自身子树外，**同级** `aw-submods` 之间 **可以**互相引用，但 **必须**按文档定义顺序**向前引用**（后者可引用先声明者）；**禁止**环。

### 3.4 `<aw-template>`（复用 + overwrite）

> 细则：[`connect-rules.md`](./connect-rules.md) §1–3、§6。

例化下的 `aw-param` / `aw-connect` / `aw-rewrite` **禁止**作为 `aw-inst` 的直接子节点，**必须**包在 `<aw-template>` 里。

| 形式 | 写法 | 含义 |
|---|---|---|
| 具名引用 | `<aw-template base="…"></aw-template>` | 引用本模 `aw-templates` 库 |
| 匿名内联 | `<aw-template>…</aw-template>` | 无 `name` / 无 `base` |
| 同标签 overwrite | `<aw-template base="…">…</aw-template>` | 先 `base`，再应用子规则（后写覆盖） |
| 多模板组合 | 多个 `<aw-template>` 兄弟 | 按文档序展开，后者覆盖前者 |

```html
<aw-template name="slice_template" inst_name="${id}_${idx}">
  <aw-param name="SLICE_IDX" expr="${idx}"></aw-param>
  <aw-connect port="dec_clk" to="dfi_clk"></aw-connect>
  <aw-rewrite match="^slice_en$" to="slice_en_${idx}"></aw-rewrite>
  <aw-rewrite match="^slice_out_(.+)$" to="slice_${idx}_out_$1"></aw-rewrite>
</aw-template>

<aw-inst id="u_slice" mod="test_slice" idx="1">
  <aw-template base="slice_template">
    <aw-connect port="slice_dbg" to="slice_1_dbg"></aw-connect>
    <aw-rewrite match="^slice_en$" to="slice_en_alt_${idx}"></aw-rewrite>
  </aw-template>
</aw-inst>
```

#### `aw-template@inst_name`

- 在 **`aw-template`** 上（可被 overwrite 改）。  
- **默认**：未写 = `` inst_name="${id}" ``。  
- 可用 §3.4.1 变量，例如 `${id}_${idx}` → `u_slice_0`。

#### 规则摘要

1. `aw-inst` 下 **只允许** `aw-template`。  
2. 同端口多条规则：**后写覆盖**。  
3. 模板名 **仅**本 `aw-mod` 的 `aw-content` 可见；需要他模同类规则时由 Agent/作者在该模内重写 template。  
4. `aw-templates` 库 **禁止**进 dump。

### 3.4.1 变量表达式与正则捕获

| 种类 | 写法 | 哪里可用 |
|---|---|---|
| 变量 / 上下文 | `` `${id}` `` `` `${idx}` `` `` `${mod}` ``、本模 param / 内部 localparam 名等 | `aw-template@inst_name`、`aw-param@expr`、`aw-connect@to`、`aw-rewrite@to` |
| 正则捕获 | `$1`、`$&`、`$<name>` | **仅** `aw-rewrite@to` |

`aw-rewrite@to` 若同时含两类：**先** RegExp 替换，**再** `` `${…}` ``。

| 绑定 | 含义 |
|---|---|
| `${id}` | `aw-inst@id` |
| `${idx}` | `aw-inst@idx`（未写则实现钉死为空或 `0`） |
| `${mod}` | `aw-inst@mod` |

### 3.5 `<aw-rewrite>`

> 细则：[`connect-rules.md`](./connect-rules.md) §4–5。

| 属性 | 必须 | 含义 |
|---|---|---|
| `match` | 是 | JS RegExp 源（对整个端口名；**应当**写 `^…$`） |
| `flags` | 否 | 默认 `""` |
| `to` | 是 | 替换串（捕获 + 变量；顺序见 §3.4.1） |

```html
<aw-rewrite match="^dec_in_(.+)$" to="mst_blk_reg_$1"></aw-rewrite>
<aw-rewrite match="^slice_out_(?<suf>.+)$" to="slice_${idx}_out_$<suf>"></aw-rewrite>
```

展开：`net = port.replace(new RegExp(match, flags), to)`，再做 `${…}` → `aw-connect`。未匹配则本条不连线。

### 3.6 其余标签

| 标签 | 出现位置 | 关键属性 |
|---|---|---|
| `aw-param` | content / template；render params 与 inst 下 | `name`；作者面 `expr`（变量表达式；禁止正则捕获）；render 宜有 `value` |
| `aw-localparam` | content 或 render 的 `aw-localparams` | 作者：`name`+`expr`；render：`name`+`value`，宜有 `folded` / `for-inst` / `for-param` |
| `aw-port` | content 显式导出；render 导出结果 | `name`；`dir`（`input`/`output`/`inout`/`interface`）；可选 `width`；`dir="interface"` 时**必须** `interface=`，可选 `modport=` |
| `aw-inst` | content / render `aw-insts` | `id`；`mod`；可选 `idx` |
| `aw-connect` | template 内 / render | `port`；`to`（变量表达式；禁止 `$1` / `$<name>`） |
| `aw-rewrite` | 仅作者面 template 内 | `match` + `to`；可选 `flags` |
| `aw-signal` | 仅 `aw-render` / `aw-signals` | `name`；可选 `width` |

### 3.7 脚本

- 常规连接用 `aw-template` / `aw-rewrite` / `aw-connect`。  
- 高级处理挂生命周期钩子：[`connect-lifecycle.md`](./connect-lifecycle.md)。  
- `<script type="module">` **必须**只用 DOM / `aw.*`；**禁止** layout / 对外 `fetch` / 写工作区磁盘。

### 3.8 可访问性

节点 **应当**带可访问名字（`name` / `id`），便于 Playwright snapshot。

## 4. `<aw-render>`（生成物 / dump 输入）

子组顺序 **应当**为：

`aw-params` → `aw-imports` → `aw-localparams` → `aw-ports` → `aw-signals` → `aw-insts`

| 子组 | 含义 |
|---|---|
| `aw-params` | 本模 parameter（宜 `value`） |
| `aw-imports` | 自底向上汇总的 package 导入；dump 时写成 SV `import`，位于**模块最头部**，**必须去重** |
| `aw-localparams` | 作者内部 localparam 落盘 + 例化 uniquify `Mod__Inst__Param`（[`connect-rules.md`](./connect-rules.md) §7） |
| `aw-ports` | 导出端口（显式 ∪ 符合自动导出规则者） |
| `aw-signals` | 本层内部 net |
| `aw-insts` | 具体实例；仅展开后的 `aw-param` / `aw-connect`（无 rewrite / template） |

### 4.1 信号 vs 导出端口

- 已被连线使用的 net **必须**进 `aw-signals`；**禁止**仅因被连线就升为导出 `aw-port`。  
- **未连接**的信号 **可以**自动导出为 `aw-port`。  
- 作者显式 `aw-content`/`aw-ports` **优先**于自动导出。

### 4.2 dump 范围

`/api/dump` **必须**收集**全部**相关 `aw-mod` 的 `aw-render`（含嵌套 `aw-submods` 与多 HTML 纳入的模块），不只顶层一棵子树。

作者面 **可以**声明内部 `aw-localparams`；**禁止**手写 uniquify `Mod__Inst__Param` 当 SoT。

## 5. Elaboration 顺序

1. **顶 → 底（param）**  
   求值本模内部 localparam 与例化 `aw-param`（常量 / 继承本模 param / 匹配本模内部 localparam → 折叠；表达式与宏不折）；求值 `inst_name`；写入 `aw-localparams`。  
2. **展开 template**（`match`+`to` → connect）。  
3. **底 → 顶（连线）**  
   生成 `aw-connect`；宽度 deps 形参换成 `Mod__Inst__Param`；填 `aw-signals` / `aw-ports`（按 §4.1）；写 `aw-render`。  
4. **递归** `aw-submods`（同级向前引用，§3.3）。  
5. **生命周期钩子**（可选）：[`connect-lifecycle.md`](./connect-lifecycle.md)。

```text
autowire.toml（.f + svh/宏 + [connect] html）
    →  hdxml → RtlIndex（只读）
    →  作者 HTML（可多份互引）
    →  elaboration → 各 aw-mod/aw-render
    →  POST /api/dump（全部相关 aw-render）
    →  autowire 写 .sv → DV
```

落地顺序：`aw.js` → `autowire web` + dump → Playwright golden → 才允许 `autowire cli`。

## 6. 多模引用与多 HTML

| 规则 | 要求 |
|---|---|
| 跨 `aw-mod` 的 `aw-template` | **禁止**；各模自写 template |
| 同级 `aw-submods` 互引 | **允许**；仅文档序向前引用；**禁止**环 |
| 多份连接 HTML | **允许**互引（按模名 / toml 清单解析）；连线细节仍只在 HTML，不在 toml |

## 7. 与 RtlIndex / 工作区

- `.f` / 宏 / `.svh` 与 [`workspace-toml.md`](./workspace-toml.md) 一致（`definesFp`）。  
- 叶子 `aw-inst@mod` 端口表来自 RtlIndex 只读查询。  
- hdxml **不**表达连接关系。

## 8. 示例索引

| 文件 | 说明 |
|---|---|
| [`examples/connect/01-author-simple.html`](./examples/connect/01-author-simple.html) | 完整骨架 |
| [`examples/connect/01-rendered-simple.html`](./examples/connect/01-rendered-simple.html) | render 示意 |
| [`examples/connect/02-author-nested.html`](./examples/connect/02-author-nested.html) | `aw-submods` 嵌套 |
| [`examples/connect/03-author-template-reuse.html`](./examples/connect/03-author-template-reuse.html) | template 复用 / overwrite |
| [`examples/connect/03-rendered-template-reuse.html`](./examples/connect/03-rendered-template-reuse.html) | 复用后 render |

## 9. 渲染生命周期

高级 / 不规则处理：[`connect-lifecycle.md`](./connect-lifecycle.md)。产物仍须落在各 `aw-mod` 的 `aw-render`。

## 10. 仍开放（实现前裁定）

1. 工作区 toml：多包/多 chip 是否允许多份 toml（见 [`workspace-toml.md`](./workspace-toml.md) §6）。  
2. 生命周期钩子稳定 API 形态（见 [`connect-lifecycle.md`](./connect-lifecycle.md) §6）。

裁定后改本文 + `help connect`，再动代码。
