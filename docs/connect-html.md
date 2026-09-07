# 连接 HTML 方言（实现约束）

> 状态：**草稿，先约束后实现**。禁止据此假装 `aw.js` / `web` / `dump` 已落地。  
> 摘要切片：`bun index.ts help connect`。改本文时同步改 help。  
> 关键字「必须 / 应当 / 可以」按 RFC 2119。  
> 结构以 [`examples/connect/01-author-simple.html`](./examples/connect/01-author-simple.html) 为准。  
> **细则速查**（template / rewrite / inst_name / overwrite）：[`connect-rules.md`](./connect-rules.md)。  
> **高级脚本**（渲染生命周期）：[`connect-lifecycle.md`](./connect-lifecycle.md)。

## 1. 目标与边界

连接描述是一份 **HTML**（可选 `<script type="module">` 做不规则生成）。

| 阶段 | 名称 | 内容 |
|---|---|---|
| 输入 | **作者 HTML（`aw-content`）** | 本模 param / 显式 port；具名 `aw-template`；例化 + 引用/patch |
| 输出 | **渲染结果（`aw-render`）** | 具体 instance、信号、导出端口、逐条连线（**生成物**） |

打印机、`/api/dump`、Playwright golden **必须**只认各 `aw-mod` 下的 **`<aw-render>`**（或与之结构等价的快照），**禁止**把 `aw-content` / `aw-templates` 原文当 netlist。

对齐：**Web 平台惯例**（JS `RegExp` + `String.replace`、具名捕获）。  
可借鉴 Verilog-mode「批量改名连线」的**意图**，**不对齐** emacs 的 `[]` / `@` / AUTO 替换语法，也不对齐 emacs 进程。  
非常规生成 **禁止**挂在 `aw-rewrite@fn`；见 [`connect-lifecycle.md`](./connect-lifecycle.md)。

## 2. 两层，禁止混淆

1. **`aw-content`** = 作者声明（内含）；**`aw-render`** = elaboration 产物。  
2. **`aw-submods`** = 子模块**依赖**（嵌套另一 `aw-mod`，递归渲染）；与 `aw-content` 的内含关系分开。  
3. **`aw-templates`** 像 `<style>`：定义一次、多例化复用，并可在例化上 **patch**；模板本身 **禁止**进入 dump。  
4. `aw-rewrite` **只存在于作者面**（含 template / 例化 patch）；渲染后 **必须**落成 `aw-render` 内一条条 `aw-connect`。  
5. 叶子端口表 **必须**只读 RtlIndex；连接页 **禁止**改 RTL 源。

## 3. 文档骨架

```text
<autowire>                          # 唯一文档根；dump/golden 外边界
  <aw-mod name="…">
    <aw-content>                    # 内含：本模作者声明
      <aw-params>…</aw-params>
      <aw-localparams>…</aw-localparams>  # 可选：本模内部 localparam
      <aw-ports>…</aw-ports>        # 显式导出（不仅是内部 net）
      <aw-templates>…</aw-templates># 可复用连接规则（类 style）
      <aw-insts>…</aw-insts>        # 例化；可 base 引用 template + patch
    </aw-content>
    <aw-submods>                    # 依赖：嵌套子 aw-mod，递归
      <aw-mod name="…">…</aw-mod>
    </aw-submods>
    <aw-render>                     # 生成物；dump 读这里
      <aw-params>…</aw-params>      # 本模 parameter（对外）
      <aw-imports>…</aw-imports>    # 预留（语义见开放项）
      <aw-localparams>…</aw-localparams>  # 本模内部 + 例化 uniquify
      <aw-ports>…</aw-ports>
      <aw-signals>…</aw-signals>
      <aw-insts>…</aw-insts>
    </aw-render>
  </aw-mod>
</autowire>
```

### 3.0 `<autowire>`

- 连接树 **必须**整包在唯一 **`<autowire>`** 下。  
- 页内可有 `<html>` / `<body>`；**禁止**把壳外节点当连接 SoT。  
- 实现可用 `querySelector("autowire")` 取根。

### 3.1 `<aw-mod>`

- `name`：模块名（必须）。  
- 子节点固定三类（顺序 **应当**为）：`aw-content` → `aw-submods` → `aw-render`。  
- 层次路径 = 自外向内 `aw-mod@name` 拼接（不含 `autowire`）。  
- 展开后例化 id 在**同一父路径下**必须唯一。

### 3.2 `<aw-content>`（内含，非依赖）

本模**自己的**声明，不定义子模块体：

| 子组 | 含义 |
|---|---|
| `aw-params` | 本模参数模板 |
| `aw-localparams` | 可选：本模**内部** localparam（`name`+`expr`）；可供例化 `aw-param@expr` 引用并参与折叠（[`connect-rules.md`](./connect-rules.md) §7.2） |
| `aw-ports` | **显式要导出**的端口（不只是内部连线用到的信号） |
| `aw-templates` | 具名连接规则库（类 stylesheet） |
| `aw-insts` | 例化列表；每个 `aw-inst` 下**只能**放 `aw-template`（`base` 或匿名）；`mod` 引用已有模块，**禁止**在此定义子模体 |

### 3.3 `<aw-submods>`（依赖）

- 子级为嵌套 **`aw-mod`**，可再含 content / submods / render，**递归** elaboration。  
- 表达的是模块依赖树，不是 content 里的「内含声明」。

### 3.4 `<aw-template>`（类 style：复用 + overwrite）

> 细则小结：[`connect-rules.md`](./connect-rules.md) §1–3、§6。

例化下的连接规则（`aw-param` / `aw-connect` / `aw-rewrite`）**禁止**作为 `aw-inst` 的直接子节点，**必须**包在 **`<aw-template>`** 里。

`aw-inst` 的作者面子节点 **只能**是一个或多个 `<aw-template>`（可匿名、可 `base`、可组合）。

| 形式 | 写法 | 含义 |
|---|---|---|
| 具名引用 | `<aw-template base="…"></aw-template>` | 只用库模板 |
| 匿名内联 | `<aw-template>…规则…</aw-template>` | 无 `name` / 无 `base`，规则全写里边 |
| 同标签 overwrite | `<aw-template base="…">…额外规则…</aw-template>` | 先展开 `base`，再应用本标签子规则（**后写覆盖**） |
| 多模板组合 | 多个 `<aw-template>` 兄弟 | 按文档序依次展开，后者覆盖前者 |

**定义**（在 `aw-templates` 内）：

```html
<aw-template name="slice_template" inst_name="${id}_${idx}">
  <aw-param name="SLICE_IDX" expr="${idx}"></aw-param>
  <aw-connect port="dec_clk" to="dfi_clk"></aw-connect>
  <aw-rewrite match="^slice_en$" to="slice_en_${idx}"></aw-rewrite>
  <aw-rewrite match="^slice_out_(.+)$" to="slice_${idx}_out_$1"></aw-rewrite>
  <aw-rewrite match="^slice_stat_(?<suf>.+)$" to="slice_${idx}_stat_$<suf>"></aw-rewrite>
</aw-template>
```

**引用 / 内联 / overwrite**（在 `aw-inst` 内）：

```html
<aw-inst id="u_decoder" mod="master_decoder">
  <aw-template>
    <aw-param name="PIPE_NUM" expr="BUS_PIPE_NUM"></aw-param>
    <aw-connect port="dec_clk" to="dfi_clk"></aw-connect>
    <aw-rewrite match="^dec_in_(?<rest>.+)$" to="mst_blk_reg_$<rest>"></aw-rewrite>
  </aw-template>
</aw-inst>

<aw-inst id="u_slice" mod="test_slice" idx="0">
  <aw-template base="slice_template"></aw-template>
</aw-inst>

<!-- 推荐：overwrite 写在同一个 aw-template 内 -->
<aw-inst id="u_slice" mod="test_slice" idx="1">
  <aw-template base="slice_template">
    <aw-connect port="slice_dbg" to="slice_1_dbg"></aw-connect>
    <aw-rewrite match="^slice_en$" to="slice_en_alt_${idx}"></aw-rewrite>
  </aw-template>
</aw-inst>

<!-- 也可以：多个 aw-template 组合（后一个覆盖前一个） -->
<aw-inst id="u_slice" mod="test_slice" idx="2">
  <aw-template base="slice_template"></aw-template>
  <aw-template>
    <aw-connect port="slice_dbg" to="slice_2_dbg"></aw-connect>
  </aw-template>
</aw-inst>
```

#### `aw-template@inst_name`（实例名表达式）

- 出现在 **`aw-template`**（定义侧）或可被 overwrite 覆盖。  
- 语义：求值后得到渲染实例名。  
- **默认**：未写时等价于透传例化槽名，即 `inst_name="${id}"`（就是 `aw-inst@id`）。  
- 表达式可用变量绑定（§3.4.1）；例如 `${id}_${idx}` → `u_slice_0`。  
- 作者面可多个 `aw-inst` 共用同一 `id`、靠不同 `idx` + `aw-template@inst_name` 在 render 中得到唯一名。

#### 规则（template 复用）

1. 像 CSS：`name` 定义一次，多个 `aw-inst` 用 `base` 引用；无 `name`、无 `base` 的为**匿名内联**。  
2. `aw-inst` 下 **只允许** `aw-template` 子节点；**禁止**直接挂 `aw-param` / `aw-connect` / `aw-rewrite`。  
3. **Overwrite**：同一 `<aw-template base>` 内的子规则，在 `base` 展开之后应用，同键后写覆盖。  
4. **多模板组合**：同一 `aw-inst` 下多个 `aw-template` 按文档序展开，后者覆盖前者（与同标签 overwrite 等价，只是拆成多个标签）。  
5. 模板名默认在本 `aw-mod` 的 `aw-content` 内可见。  
6. 定义侧 `aw-templates` **禁止**进 dump；只进入 `aw-render`。

### 3.4.1 变量表达式与正则捕获

| 种类 | 写法 | 哪里可用 |
|---|---|---|
| 变量 / 上下文 | `` `${id}` `` `` `${idx}` `` `` `${mod}` ``、本模 param 名等 | `aw-template@inst_name`、`aw-param@expr`、`aw-connect@to`、`aw-rewrite@to` |
| 正则捕获 | `$1`、`$&`、`$<name>` | **仅** `aw-rewrite@to` |

- `aw-connect@to`、`aw-param@expr`、`aw-template@inst_name`：**支持变量表达式**；**禁止**正则匹配结果表达式。  
- `aw-rewrite@to`：两者都可；顺序为先 RegExp 替换，再 `` `${…}` ``（见 [`connect-rules.md`](./connect-rules.md) §4）。

| 绑定 | 含义 |
|---|---|
| `${id}` | 作者面 `aw-inst@id`（槽名） |
| `${idx}` | `aw-inst@idx`（未写则为空或 `0`，实现钉死一种） |
| `${mod}` | `aw-inst@mod` |

### 3.5 `<aw-rewrite>`（Web 匹配：RegExp + `to`）

> 细则小结：[`connect-rules.md`](./connect-rules.md) §4–5。

**不对齐** emacs `port=…_(.*) … $1[]` 方言。匹配与替换按浏览器 **`RegExp` + `String.prototype.replace`**。  
**禁止** `fn=`；模板 `match`+`to` 覆盖常规改名。超出模板能力的处理走渲染生命周期嵌入脚本（[`connect-lifecycle.md`](./connect-lifecycle.md)）。

| 属性 | 必须 | 含义 |
|---|---|---|
| `match` | 是 | JS RegExp **源模式**（对整个端口名；作者 **应当**写 `^…$`） |
| `flags` | 否 | RegExp flags，默认 `""`；常见 `i` |
| `to` | 是 | 替换串：`$1`、`$&`、`$<name>`（仅 rewrite）及 `` `${id}` `` 等变量；顺序见 §3.4.1 |

```html
<aw-rewrite match="^dec_clk$" to="dfi_clk"></aw-rewrite>
<aw-rewrite match="^dec_in_(.+)$" to="mst_blk_reg_$1"></aw-rewrite>
<aw-rewrite match="^slice_out_(?<suf>.+)$" to="slice_${idx}_out_$<suf>"></aw-rewrite>
```

展开：对叶子端口名 `p`，`net = p.replace(new RegExp(match, flags), to)`，再做 `${…}` 插值 → `aw-connect port="p" to="net"`。未匹配则本条不连线。

**同一 `aw-template` 展开列表内**：多条 rewrite / connect 对同一 `port` **后写覆盖**。

**显式 `aw-connect`** 与 rewrite 冲突时：按展开列表 **后写覆盖**（与上一致）。

### 3.6 其余标签

标签小写；属性加引号。

| 标签 | 出现位置 | 关键属性 |
|---|---|---|
| `aw-param` | content params / template；render params 与 inst 下 | `name`；作者面 `expr`（变量表达式；**禁止**正则捕获）；渲染后宜有 `value` |
| `aw-localparam` | 作者面 `aw-content`/`aw-localparams`；或 `aw-render`/`aw-localparams` | 作者：`name`+`expr`；render：`name`+`value`，宜有 `folded` / `for-inst` / `for-param` |
| `aw-port` | content 显式导出；render 导出结果 | `name`；`dir`；可选 `width` |
| `aw-inst` | content / render `aw-insts` | `id`；`mod`；可选 `idx` |
| `aw-connect` | 仅 template 内 / render | `port`；`to`（变量表达式；**禁止** `$1` / `$<name>`） |
| `aw-rewrite` | 仅作者面 template 内 | `match` + `to`（可含捕获 + 变量）；可选 `flags`；**禁止** `fn` |
| `aw-signal` | 仅 `aw-render` / `aw-signals` | `name`；可选 `width` |

### 3.7 脚本（摘要）

- 常规连接 **应当**只用 `aw-template` / `aw-rewrite@match`+`to` / `aw-connect`。  
- 高级、不规则处理 **必须**挂在渲染生命周期钩子上，见 [`connect-lifecycle.md`](./connect-lifecycle.md)。  
- `<script type="module">` **必须**只用 DOM / `aw.*`；**禁止** layout / 对外 `fetch` / 写工作区磁盘。

### 3.8 可访问性

节点 **应当**带可访问名字（`name` / `id`），便于 Playwright snapshot。

## 4. `<aw-render>`（生成物 / dump 输入）

每个 `aw-mod` 在 elaboration 后 **必须**填好自己的 `<aw-render>`。子组顺序 **应当**为：

`aw-params` → `aw-imports` → `aw-localparams` → `aw-ports` → `aw-signals` → `aw-insts`

| 子组 | 含义 |
|---|---|
| `aw-params` | 本模 **parameter**（模块接口参数；宜 `value`） |
| `aw-imports` | **预留**槽（见 §9 开放项）；未裁定前 **禁止**当连接 SoT |
| `aw-localparams` | 本模 **localparam**：作者面内部声明的落盘 + 例化 uniquify 的 `Mod__Inst__Param`（见 [`connect-rules.md`](./connect-rules.md) §7）；dump 写成 SV `localparam` |
| `aw-ports` | 导出端口（显式 ∪ 推导） |
| `aw-signals` | 本层内部 net（由 connect/`to` 等汇总） |
| `aw-insts` | 具体实例；每实例下为展开后的 `aw-param`（指向对应 localparam 名或 value）/ `aw-connect`（**无** `aw-rewrite` / `aw-template`） |

`<aw-localparam>`：

| 属性 | 必须 | 含义 |
|---|---|---|
| `name` | 是 | 作者内部名，或 uniquify 名如 `master_cfg_wrap__u_decoder__PIPE_NUM` |
| `expr` | 作者面 | 变量表达式（折叠分类用）；**禁止**正则捕获 |
| `value` | render | 按折叠规则：字面量，或未折叠的表达式/宏文本 |
| `folded` | render 应当 | `true` = 已折成常量；`false` = 表达式或宏未折 |
| `for-inst` / `for-param` | uniquify 应当 | 对应最终实例名 / 子模形参名 |

作者面 **可以**声明本模内部 `aw-localparams`；**禁止**手写 uniquify `Mod__Inst__Param` 当 SoT（由 elaboration 写入 `aw-render`）。

嵌套：`aw-submods` 内子 `aw-mod` 各自有自己的 `aw-render`；父 dump 可递归收集或只序列化顶层（实现选一种，golden 锁死）。

## 5. Elaboration 顺序与总流水线

### 5.1 引擎顺序（语义冻结）

1. **顶 → 底（param）**  
   绑定/求值本模内部 `aw-localparam` 与例化 `aw-param`（按 [`connect-rules.md`](./connect-rules.md) §7.2：常量、继承本模 param、**匹配本模内部 localparam** → **折叠**；表达式与宏 **不折**）；求值 `inst_name`；  
   写入 `aw-render`/`aw-localparams`（本模内部 + `Mod__Inst__Param`）。  
2. **展开 template**  
   `base` + 内联/overwrite；展开 `aw-rewrite`（仅 `match`+`to`）。  
3. **底 → 顶（连线）**  
   生成 `aw-connect`；端口宽度 deps 中的形参 **必须**换成对应 `Mod__Inst__Param`（或与之锁定的折叠值）；填 `aw-signals` / 导出 `aw-ports`；写入 `aw-render`。  
4. **递归** `aw-submods`。  
5. **生命周期钩子**（可选嵌入脚本）穿插于上述阶段；约定见 [`connect-lifecycle.md`](./connect-lifecycle.md)。

边界：宏（toml / `.svh`）≠ 模块 param；连接顶不必是全芯片 RTL top。

### 5.2 端到端流水线

```text
autowire.toml（.f + svh/宏）
    →  hdxml → RtlIndex（只读）
    →  作者 HTML（aw-content + aw-submods）
    →  elaboration → 各 aw-mod/aw-render
    →  POST /api/dump（读 aw-render）
    →  autowire 写 .sv → DV
```

工作区：[`workspace-toml.md`](./workspace-toml.md)。

### 5.3 实现落地顺序（禁止跳步）

1. `aw.js` + 约束自定义元素  
2. `autowire web` + `/api/dump`（及 `autowire.toml` / RtlIndex）  
3. Playwright 用例 / golden  
4. 才允许 `autowire cli`

## 6. 与 RtlIndex / 工作区配置

- `.f` / 宏 / `.svh` **必须**与 [`autowire.toml`](./workspace-toml.md)（或等价且 `definesFp` 一致的覆盖）一致。  
- `aw-inst@mod` 对叶子时端口表来自 RtlIndex 只读查询。  
- hdxml **不**表达连接关系；连接 SoT 只有本方言 HTML。

## 7. 示例索引

| 文件 | 说明 |
|---|---|
| [`examples/connect/01-author-simple.html`](./examples/connect/01-author-simple.html) | 完整骨架：content / templates / insts / submods / render 槽 |
| [`examples/connect/01-rendered-simple.html`](./examples/connect/01-rendered-simple.html) | 上例 `aw-render` 示意（实现目标） |
| [`examples/connect/02-author-nested.html`](./examples/connect/02-author-nested.html) | `aw-submods` 嵌套依赖 |
| [`examples/connect/03-author-template-reuse.html`](./examples/connect/03-author-template-reuse.html) | `match`+`to` 复用 / overwrite patch |
| [`examples/connect/03-rendered-template-reuse.html`](./examples/connect/03-rendered-template-reuse.html) | 复用展开后的 render 示意 |

## 8. 渲染生命周期与嵌入脚本

高级处理（不规则生成、后处理 `aw-render` 等）**单开**：[`connect-lifecycle.md`](./connect-lifecycle.md)。  
`aw-rewrite` **不再**提供 `fn`；脚本按 elaboration 阶段挂钩，产物仍须落在各 `aw-mod` 的 `aw-render`。

## 9. 开放项（实现前裁定）

1. 未在 `aw-ports` 声明、但被连线用到的信号：是否自动升为导出 port，还是只进 `aw-signals`？  
2. ~~`aw-param` 折叠策略~~ **已定**：自动检查——常量、继承本模 param、**匹配本模内部 localparam** → 折叠；表达式 → 不折；**宏不可折叠**（`connect-rules.md` §7.2）。uniquify 名 `Mod__Inst__Param`。  
3. dump：序列化顶层 `aw-render` 子树 vs 含全部嵌套 render？  
4. 跨 `aw-mod` 引用 `aw-template` 是否允许？生命周期钩子作用域见 [`connect-lifecycle.md`](./connect-lifecycle.md) 开放项。  
5. overwrite：同标签内「base + 子规则」与「多 template 兄弟」两种都允许；禁止规则直接挂在 `aw-inst` 下。  
6. `aw-imports`（render 预留槽）语义与 dump 行为？  
7. 工作区 toml 开放项见 [`workspace-toml.md`](./workspace-toml.md) §6。

裁定后改本文 + `help connect`，再动代码。
