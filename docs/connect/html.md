# 连接 HTML 方言（实现约束）

> 状态：**已实现**（`web/aw.js`；`autowire web` / `check` / `/api/dump` 落地；Playwright 用例与 golden 见 `src/e2e-web.test.ts` / `test/golden/`）。  
> 摘要切片：`bun index.ts help connect`。改本文时同步改 help。  
> 关键字「必须 / 应当 / 可以」按 RFC 2119。  
> 结构以 [`examples/connect/01-author-simple.html`](../examples/connect/01-author-simple.html) 为准。  
> **细则速查**：[`rules.md`](./rules.md)。  
> **高级脚本**：[`lifecycle.md`](./lifecycle.md)。

## 1. 目标与边界

连接描述是一份或多份 **HTML**（可选 `<script type="module">`）。

| 阶段 | 名称 | 内容 |
|---|---|---|
| 输入 | **作者 HTML（`aw-content`）** | imports / param / 内部 localparam / 显式 port；具名 `aw-template`；例化 + 引用/overwrite |
| 输出 | **渲染结果（`aw-render`）** | 具体 instance、信号、导出端口、逐条连线（**生成物**） |

打印机、`/api/dump`、Playwright golden **必须**只认各 `aw-mod` 下的 **`<aw-render>`**，**禁止**把 `aw-content` / `aw-templates` 原文当 netlist。

`aw-rewrite` 使用浏览器 **`RegExp` + `String.replace`**（`$1` / `$<name>` + 变量 `` `${…}` ``）。非常规生成挂在渲染生命周期脚本上（[`lifecycle.md`](./lifecycle.md)），不挂在 rewrite 属性上。

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
      <aw-mod name="…" deps="…">…</aw-mod>   # deps = 同父兄弟名；路径累积可见集见 §3.3
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
- **多份 HTML** 可互引（见 §6）；清单在 `autowire.toml` 的 `[connect.<id>]`（`html` + `deps`，无连线细节）。

### 3.1 `<aw-mod>`

- `name`：模块名（必须）。  
- `deps`：可选；**同父**下其它包装模的 `name` 列表（空格或逗号分隔）。见 §3.3。  
- 子节点顺序 **应当**为：`aw-content` → `aw-submods` → `aw-render`。  
- `aw-render` 在作者 HTML 里 **可以**预留空壳；elaborate 后由引擎填满并冻结。
- 层次路径 = 自外向内 `aw-mod@name` 拼接（不含 `autowire`）。  
- 展开后例化 id 在**同一父路径下**必须唯一。

### 3.2 `<aw-content>`（内含，非依赖）

| 子组 | 含义 |
|---|---|
| `aw-imports` | package 导入；接口（本模或子模）引用 package 类型时，**自底向上自动继承**汇总到各层；作者无需逐层手抄 |
| `aw-params` | 本模参数 |
| `aw-localparams` | 可选：本模内部 localparam（`name`+`expr`）；可供例化 `aw-param@expr` 引用并参与折叠（[`rules.md`](./rules.md) §7） |
| `aw-ports` | **显式要导出**的端口 |
| `aw-templates` | 具名连接规则库（仅本 `aw-mod` 可见；**禁止**跨 `aw-mod` 引用） |
| `aw-insts` | 例化列表；每个 `aw-inst` 下**只能**放 `aw-template`；`mod` 引用已有模块，**禁止**在此定义子模体 |

### 3.3 `<aw-submods>`（依赖）

- 子级为嵌套 **`aw-mod`**，递归 elaboration。  
- 每个嵌套（及 `<autowire>` 下顶层并列的）`aw-mod` **可以**带 `deps`（§3.1）：列出**同父**兄弟包装模的 `name`。  
- **合法性只认 deps + 路径累积可见集**；文档序仅作稳定排序/展示，**不再**单独充当「前向即可引用」规则。

**可见集（路径累积，单调并集）**

```text
visible(M) = { M 的直接子 aw-mod name }        # 结构拥有，始终可例化
           ∪ M.deps                           # 同父兄弟，须显式声明
           ∪ ⋃_祖先 A 路径上的 A.deps          # 路径累积，只增不减
```

往下走时可见集只增不减：子层可看见祖先路径上已声明的依赖，不必整条链重写。
**兄弟不自动可见**（实现裁定：原公式 `visible(child) ⊇ {parent 的子 aw-mod}` 会让兄弟免 deps 可见，与「兄弟互引必须写 deps」冲突；以此为准）。  
下降到子模时传入 `祖先可见 ∪ 本模 deps`；**禁止**把先遍历兄弟的 `deps` 并进后兄弟的可见集（见 [`check.md`](./check.md) §3.3）。

**`aw-inst@mod` 解析**

| 目标 | 条件 |
|---|---|
| RtlIndex 叶子 | 始终允许 |
| 本模**直接**子 `aw-mod` | 始终允许（结构拥有，不必写入 `deps`） |
| 同父兄弟包装模 | **必须**出现在本模 `deps`（或经路径累积已进入 `visible(本模)`） |
| 旁系孙子 / 未上提的共享模 | **禁止**（共享须上提到平行层，再靠兄弟 `deps`） |

**纪律（与 toml `[connect.<id>] deps` 对齐）**

1. 引用了却未进入可见集 → **非法引用，报错**。  
2. `deps` 写了但 elaborate 未实际引用 → **警告**。  
3. `deps` 图（同父兄弟之间）**必须无环**；未知名 / 自依赖 → **报错**。  
4. 无边兄弟可按 DAG **并行** elaborate。  
5. 跨 HTML 包级依赖仍只走 toml `[connect.<id>] deps`（§6）；**不要**把单元 id 写进 `aw-mod@deps`。

### 3.4 `<aw-template>`（复用 + overwrite）

> 细则：[`rules.md`](./rules.md) §1–3、§6。

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
  <aw-rewrite match="^slice_en$" to="slice_en_${idx}" packed="auto"></aw-rewrite>
  <aw-rewrite match="^slice_out_(.+)$" to="slice_${idx}_out_$1" packed="auto"></aw-rewrite>
</aw-template>

<aw-inst id="u_slice" mod="test_slice" idx="1">
  <aw-template base="slice_template">
    <aw-connect port="slice_dbg" to="slice_1_dbg" packed="auto"></aw-connect>
    <aw-rewrite match="^slice_en$" to="slice_en_alt_${idx}" packed="auto"></aw-rewrite>
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
| 变量 / 上下文 | `` `${id}` `` `` `${idx}` `` `` `${mod}` ``、本模 param / 内部 localparam 名等 | `aw-template@inst_name`、`aw-param@expr`、`aw-connect@to`、`aw-rewrite@to`、`packed`/`width`（非 `auto` 时）、`unpacked`、`part` |
| 正则捕获 | `$1`、`$&`、`$<name>` | **仅** `aw-rewrite@to` |

`aw-rewrite@to` 若同时含两类：**先** RegExp 替换，**再** `` `${…}` ``。  
`packed` / `width` / `unpacked` / `part`：**禁止**正则捕获；**禁止**把 `[]` / part-select 写进 `to` 名字里。

| 绑定 | 含义 |
|---|---|
| `${id}` | `aw-inst@id` |
| `${idx}` | `aw-inst@idx`（未写则实现钉死为空或 `0`） |
| `${mod}` | `aw-inst@mod` |

### 3.5 `<aw-rewrite>`

> 细则：[`rules.md`](./rules.md) §4–5。

| 属性 | 必须 | 含义 |
|---|---|---|
| `match` | 是 | JS RegExp 源（对整个端口名；**应当**写 `^…$`） |
| `flags` | 否 | 默认 `""` |
| `to` | 是 | 替换得到的**净网名**（捕获 + 变量；顺序见 §3.4.1）；**禁止**夹带 `[]` / part-select。常量见 §3.5.3 |
| `packed` / `width` | 否 | 见 §3.5.1；默认 `auto`（`width` = 一维 packed 简写） |
| `unpacked` | 否 | 见 §3.5.1 |
| `part` | 否 | 见 §3.5.1 |
| `nettype` | 否 | 见 §3.5.2 |
| `type` | 否 | `net`（默认）\|`const`（§3.5.3）\|`open`（§3.5.4）；const/open **必须**显式写明，与推断不一致 → 报错 |

```html
<aw-rewrite match="^dec_in_(.+)$" to="mst_blk_reg_$1" packed="auto"></aw-rewrite>
<aw-rewrite match="^slice_out_(?<suf>.+)$" to="slice_${idx}_out_$<suf>" packed="auto"></aw-rewrite>
<aw-rewrite
  match="^slice_data$"
  to="slice_data_bus"
  packed="15:0"
  part="8*${idx}+7:8*${idx}"
></aw-rewrite>
```

展开：`net = port.replace(new RegExp(match, flags), to)`，再做 `${…}` → `aw-connect`（带上求值后的维 / `part` / `nettype` 语义）。未匹配则本条不连线。

### 3.5.1 `packed` / `unpacked` / `width` / `part`（声明维 vs 连线选位）

`aw-connect` 与 `aw-rewrite` 共用。对齐 RtlIndex：`packed` / `unpacked` 分列（见 [`hdxml/rtlindex-xml.md`](../hdxml/rtlindex-xml.md)）。**不对齐** emacs 名字后缀 `signal[]`。

| 属性 | 含义 | 落地 |
|---|---|---|
| `packed` | 打包维：`auto` \| 范围（`31:0`）\| 多维拼接（`[7:0][3:0]`，与 RtlIndex 同形） | → `aw-signal@packed` |
| `unpacked` | 非打包维：同形（如 `[0:255]`、`[0:${N}-1]`） | → `aw-signal@unpacked` |
| `width` | **一维 packed 简写**：`auto` \| `15:0`；等价于只写 `packed` 且无方括号多维 | → 同上 `packed` |
| `part` | 本端口连到该网的 **part-select**（如 `8*${idx}+7:8*${idx}`） | 留在 render `aw-connect@part`；dump 成 `.port(net[…])` |

规则：

- **`to`**：只有网名（+ 变量插值）。  
- **`packed` / `width` 省略**：视为 `auto`——从叶子端口 RtlIndex 抄 `packed`（及若有则 `unpacked`）；形参经 `Mod__Inst__Param` 改写。标量 → 可不写维。  
- **`packed="auto"` / `width="auto"`**：同上。  
- **多维**：**必须**用 `packed` / `unpacked`（RtlIndex 形）；不要把 unpack 维塞进 `width`。  
- **`part` 省略**：整网连接。  
- 维表达式与 `part` 用 §3.4.1 变量方言；**禁止** `$1` / `$<name>`。  
- 同时写 `width` 与 `packed` 且不一致 → **报错**。

冲突：

| 情况 | 要求 |
|---|---|
| 同名 `aw-signal` 已有 `packed`/`unpacked`，与新来的不一致 | **报错** |
| `part` 与已声明维明显冲突 | **报错** |
| 有 `part`、信号尚不存在、且无法确定声明维 | **报错** |

```html
<!-- 全自动：跟端口 packed（及 unpacked） -->
<aw-connect port="data" to="mst_data" packed="auto"></aw-connect>

<!-- 一维简写 -->
<aw-connect port="lane" to="bus" width="31:0" part="8*${idx}+7:8*${idx}"></aw-connect>

<!-- 多维数组网 -->
<aw-connect
  port="word"
  to="mem"
  packed="[31:0]"
  unpacked="[0:255]"
  part="[0]"
></aw-connect>
```

### 3.5.2 `nettype`（`wire` / `logic`）

- dump 默认 **`wire`**（互联网）。  
- `packed="auto"` 时 **可以**继承叶子端口 `dataType` 若为 `wire`/`logic`；否则用默认。  
- 可选 `nettype="wire|logic"` 覆盖；**不是**必填。  
- 自定义类型 / interface 不靠本属性（见 `aw-port` / RtlIndex `dataType`）。

### 3.5.3 常量连线（`to` = 常量表达式）

> 细则与评审记录：[`to-rules.md`](./to-rules.md)（已转正式约束）。

`aw-connect@to`（以及 `aw-rewrite@to`）在 `${…}` 变量代入后分类：

| 形态 | 分类 | 语义 |
|---|---|---|
| 合法标识符，且**不**命中本模 param/localparam | 净网名 | 建网/维度/自动导出（§3.5.1–3.5.2） |
| 单一标识符命中本模 param / localparam | 常量引用 | 不建网，dump 内联 `.port(NAME)` |
| 以数字 / `'` / `{` / `` ` `` 开头 | 常量表达式 | 字面量、拼接/复制、宏原文内联 |
| 含运算符且**全部**标识符命中 param/localparam | 常量表达式 | 如 `W+1`、`{W{1'b0}}` |
| 其他 | 报错 | — |

- 常量**不建网**（不进 `aw-signals`、不参与维度合并、不触发自动导出端口）；`part` / `packed` / `width` / `unpacked` / `nettype` 与常量互斥（同写报错）。
- 常量只能驱动 **input** 端口（连 output/inout → 报错）。
- `aw-rewrite` 产常量 = 批量 tie-off（match 须覆盖全端口名），此时**禁止**正则捕获。
- `type="net|const"` 可选断言：与引擎推断不一致 → 报错。
- **能力边界**：更复杂的信号·常量组合（三元、位运算等）不内嵌于连接方言，**必须**单独写集成小模块再例化。
- 示例：[`examples/connect/05-author-const.html`](../examples/connect/05-author-const.html) / [`05-rendered-const.html`](../examples/connect/05-rendered-const.html)。

### 3.5.4 显式悬空（`type="open"`）

> 细则：[`to-rules.md`](./to-rules.md) §2.3。

- `<aw-connect port="q_o" type="open">`：显式悬空；**只允许 output / inout**（input 悬空报错，改用常量绑死）；**禁止** `to` / `part` / 维度属性。
- `aw-rewrite` 可批量悬空（`match` 命中端口全部 open，不写 `to`）。
- open 不建网；render 落 `type="open"`；dump 打印 `.port()`（消 PINMISSING）。
- 缺 `to` 且未声明 `type="open"` → 报错（open 必须显式）。
- 覆盖语义同 net：同端口后写覆盖。

### 3.5.5 同名推导（identity inference）

> 细则：[`to-rules.md`](./to-rules.md) §2.4。

- **未被任何规则覆盖的端口**（非 interface）elaborate 时**自动连到同名网**——同名连接是推导出来的，作者面**原则省略不写**，只描述非同名信息（避免底层 IP 统一换名时逐行同步 HTML 的负担）。
- 同名网天然**合流**（如各例化的 `clk` 汇成一网）；显式规则与 `type="open"` / `type="const"` **永远优先**于推导。
- 安全网：同一网有 **>1 个全网（无 part-select）output 驱动** → **报错**（短路）；part-select 分片驱动允许共网（**不相交性不校验**，EDA/DV 兜底）。多例化的同名 output（如 sdspi `o_debug`）必须显式 open 或显式改名。

| 意图 | 写法 |
|---|---|
| 同名贯通 | 省略 |
| 改名 / 汇合 | 显式 `to=` |
| 不要这根网 / 消自动导出 | `type="open"` 或显式改名 |
| 多实例同名 output | 必须 open 或改名（否则短路 error） |

### 3.6 其余标签

| 标签 | 出现位置 | 关键属性 |
|---|---|---|
| `aw-param` | content / template；render params 与 inst 下 | `name`；作者面 `expr`；render 宜有 `value` |
| `aw-localparam` | content 或 render 的 `aw-localparams` | 作者：`name`+`expr`；render：`name`+`value`，宜有 `folded` / `for-inst` / `for-param` |
| `aw-port` | content 显式导出；render 导出结果 | `name`；`dir`；可选维信息；`dir="interface"` 时**必须** `interface=`，可选 `modport=` |
| `aw-inst` | content / render `aw-insts` | `id`；`mod`；可选 `idx` |
| `aw-connect` | template 内 / render | `port`；`to`（净网名或常量，§3.5.3）；可选 `packed`/`width`/`unpacked`/`part`/`nettype`/`type`；render 宜保留求值后的 `part` |
| `aw-rewrite` | 仅作者面 template 内 | `match` + `to`；可选 `flags` / `type` 与上列维/选位/`nettype`（常量时全禁，§3.5.3） |
| `aw-signal` | 仅 `aw-render` / `aw-signals` | `name`；可选 `packed`/`unpacked`/`nettype`（`width` 仅作一维简写输入，render **应当**规范成 `packed`） |

### 3.7 脚本

- 常规连接用 `aw-template` / `aw-rewrite` / `aw-connect`。  
- 高级处理挂生命周期钩子：[`lifecycle.md`](./lifecycle.md)——**仅** `before-instances`（写 `aw-content`）与 `on-template`（写展开中间态）；**`aw-render` 写满后冻结**；`before-dump` 只读。  
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
| `aw-localparams` | 作者内部 localparam 落盘 + 例化 uniquify `Mod__Inst__Param`（[`rules.md`](./rules.md) §7） |
| `aw-ports` | 导出端口（显式 ∪ 符合自动导出规则者） |
| `aw-signals` | 本层内部 net |
| `aw-insts` | 具体实例；仅展开后的 `aw-param` / `aw-connect`（无 rewrite / template） |

### 4.1 信号 vs 导出端口

- 驱动与负载都在本层内部的 net **必须**进 `aw-signals`（内部信号）。
- 无驱动（只连叶子 input）的 net 自动导出为 **input** 端口；只被叶子 output 驱动、本层无负载的 net 自动导出为 **output** 端口；含 inout 导出为 **inout**。
- 作者显式 `aw-content`/`aw-ports` **优先**于自动导出——`aw-ports` 只写需要显式控制的端口，**一般不应**罗列全部 IO。

### 4.2 dump 范围

`/api/dump` **必须**收集**全部**相关 `aw-mod` 的 `aw-render`（含嵌套 `aw-submods` 与多 HTML 纳入的模块），不只顶层一棵子树。

作者面 **可以**声明内部 `aw-localparams`；**禁止**手写 uniquify `Mod__Inst__Param` 当 SoT。

## 5. Elaboration 顺序

1. **`before-instances` 钩子**（可选）：只改本模 `aw-content`（动态 inst / template）。见 [`lifecycle.md`](./lifecycle.md)。  
2. **顶 → 底（param）**  
   求值本模内部 localparam 与例化 `aw-param`（常量 / 继承本模 param / 匹配本模内部 localparam → 折叠；表达式与宏不折）；求值 `inst_name`；写入 `aw-localparams`。  
3. **展开 template**（`match`+`to` → connect）+ **`on-template` 钩子**（可选）：按例化改中间态，**禁止**写已完成的 `aw-render`。  
4. **递归 `aw-submods` 先 elaborate**（按 `aw-mod@deps` DAG；实现裁定：父模例化子包装模需要子模 render 端口表，故子模先于父模连线）  
5. **底 → 顶（连线）**  
   生成 `aw-connect`；应用 `packed`/`unpacked`/`width`/`part`/`nettype`（§3.5.1–3.5.2）写入 `aw-signals`；宽度 deps 形参换成 `Mod__Inst__Param`；填 `aw-ports`（按 §4.1）；写 `aw-render` 后 **冻结**。  
6. **`before-dump`**（可选钩子只读）→ dump（dump 门禁验 render 可印；作者面 check 见流水线，不在此把 `aw-render` 当 check SoT）。

```text
autowire.toml（.f + svh/宏 + [connect.<id>] deps DAG）
    →  hdxml → RtlIndex（只读）
    →  check（作者面 aw-content 合法性 + deps；不写盘）
    →  按 deps 拓扑 elaborate（无边单元可并行）→ .autowire/connect/<id>.xml 快照
    →  POST /api/dump（读 POST 体全部相关 aw-render；刷新 xml 快照）
    →  autowire 写 .sv → DV
```

落地顺序：`aw.js` → `autowire web` + check + dump → Playwright golden → 才允许 `autowire cli`。

## 6. 多模引用与多 HTML

| 规则 | 要求 |
|---|---|
| 跨 `aw-mod` 的 `aw-template` | **禁止**；各模自写 template |
| 同级 `aw-submods` 互引 | **必须**写在被引方同父下的 `aw-mod@deps`；可见集路径累积；缺边报错、多余警告、无环可并行；**禁止**旁系孙子（共享上提） |
| 多份连接 HTML | 必须在 `autowire.toml` 注册为 `[connect.<id>]`；跨单元引用 **必须**写在 `deps` 里，否则非法引用报错；`deps` 写了但未实际引用 → **警告**；`deps` 图无环；就绪单元可**并行** elaborate |
| toml | **禁止**连线细节；只允许 `html` + `deps` |

详见 [`../workspace/toml.md`](../workspace/toml.md) §4.1。

## 7. 与 RtlIndex / 工作区

- `.f` / 宏 / `.svh` 与 [`../workspace/toml.md`](../workspace/toml.md) 一致（`definesFp`）。  
- 叶子 `aw-inst@mod` 端口表来自 **`.autowire/hdxml/`**（经 web API），只读。  
- 跨 `[connect.<id>]` 包装模符号来自 **`.autowire/connect/`** 依赖单元快照（经 API / DAG elaborate）；见 workspace/toml.md §4.2。  
- hdxml **不**表达连接关系。

## 8. 示例索引

| 文件 | 说明 |
|---|---|
| [`examples/connect/01-author-simple.html`](../examples/connect/01-author-simple.html) | 完整骨架；`packed=auto` / `part` 切片 |
| [`examples/connect/01-rendered-simple.html`](../examples/connect/01-rendered-simple.html) | render 示意（含 `slice_data_bus` + `part`） |
| [`examples/connect/02-author-nested.html`](../examples/connect/02-author-nested.html) | `aw-submods` 嵌套（无兄弟互引时可省略 `deps`） |
| [`examples/connect/03-author-template-reuse.html`](../examples/connect/03-author-template-reuse.html) | template 复用 / overwrite + `packed`/`part` |
| [`examples/connect/03-rendered-template-reuse.html`](../examples/connect/03-rendered-template-reuse.html) | 复用后 render（共享 bus + part） |
| [`examples/connect/04-author-multidim.html`](../examples/connect/04-author-multidim.html) | 多维：`packed` + `unpacked`；`packed=auto` |
| [`examples/connect/04-rendered-multidim.html`](../examples/connect/04-rendered-multidim.html) | 多维 render 示意 |
| [`examples/connect/05-author-const.html`](../examples/connect/05-author-const.html) | 常量连线：字面量 / 拼接复制 / 宏 / param·localparam 引用 |
| [`examples/connect/05-rendered-const.html`](../examples/connect/05-rendered-const.html) | 常量 render（引擎实际产物） |
| [`examples/connect/06-author-open.html`](../examples/connect/06-author-open.html) | 显式悬空 `type="open"`（批量 + 覆盖回挂网） |
| [`examples/connect/06-rendered-open.html`](../examples/connect/06-rendered-open.html) | open render（引擎实际产物） |

## 9. 渲染生命周期

高级 / 不规则处理：[`lifecycle.md`](./lifecycle.md)。  
两写一冻：`before-instances` → `on-template` → 引擎写 `aw-render`（冻结）→ `before-dump` 只读。产物 **必须**只来自引擎写出的 `aw-render`，**禁止**脚本事后改 render。

## 10. 仍开放

1. 工作区 toml：多包/多 chip 是否允许多份 toml（见 [`../workspace/toml.md`](../workspace/toml.md) §6）。

已裁定（随 aw.js 落地）：生命周期钩子 = `aw.on(phase, fn)`，按连接单元隔离；钩子同步；子模整段先于父模连线 elaborate（lifecycle.md §6）。
