# 连接 HTML 方言（实现约束）

> 状态：**草稿，先约束后实现**。禁止据此假装 `aw.js` / `web` / `dump` 已落地。  
> 摘要切片：`bun index.ts help connect`。改本文时同步改 help。  
> 关键字「必须 / 应当 / 可以」按 RFC 2119。  
> 结构以 [`examples/connect/01-author-simple.html`](./examples/connect/01-author-simple.html) 为准。

## 1. 目标与边界

连接描述是一份 **HTML**（可选 `<script type="module">` 做不规则生成）。

| 阶段 | 名称 | 内容 |
|---|---|---|
| 输入 | **作者 HTML（`aw-content`）** | 本模 param / 显式 port；具名 `aw-template`；例化 + 引用/patch |
| 输出 | **渲染结果（`aw-render`）** | 具体 instance、信号、导出端口、逐条连线（**生成物**） |

打印机、`/api/dump`、Playwright golden **必须**只认各 `aw-mod` 下的 **`<aw-render>`**（或与之结构等价的快照），**禁止**把 `aw-content` / `aw-templates` 原文当 netlist。

对齐：emacs Verilog-mode **心智**（rewrite 捕获、`@`、`[]`、AUTO_TEMPLATE 子集）。  
不对齐：emacs 进程、平行连接 IR、连接专用 MCP。

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
      <aw-ports>…</aw-ports>        # 显式导出（不仅是内部 net）
      <aw-templates>…</aw-templates># 可复用连接规则（类 style）
      <aw-insts>…</aw-insts>        # 例化；可 base 引用 template + patch
    </aw-content>
    <aw-submods>                    # 依赖：嵌套子 aw-mod，递归
      <aw-mod name="…">…</aw-mod>
    </aw-submods>
    <aw-render>                     # 生成物；dump 读这里
      <aw-params>…</aw-params>
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
| `aw-ports` | **显式要导出**的端口（不只是内部连线用到的信号） |
| `aw-templates` | 具名连接规则库（类 stylesheet） |
| `aw-insts` | 例化列表；`mod` **引用**已有模块名，**禁止**在此定义子模体 |

### 3.3 `<aw-submods>`（依赖）

- 子级为嵌套 **`aw-mod`**，可再含 content / submods / render，**递归** elaboration。  
- 表达的是模块依赖树，不是 content 里的「内含声明」。

### 3.4 `<aw-template>`（类 style：复用 + patch）

**定义**（在 `aw-templates` 内）：

```html
<aw-template name="slice_template" inst_name_expr="${id}_${idx}">
  <aw-param name="SLICE_IDX" expr="$idx"></aw-param>
  <aw-connect port="dec_clk" to="dfi_clk"></aw-connect>
  <aw-rewrite port="slice_en" to="slice_en[${idx}]"></aw-rewrite>
  <aw-rewrite port="slice_out_(.*)" to="slice_${idx}_out_$1[]"></aw-rewrite>
</aw-template>
```

**引用**（在 `aw-inst` 内）：

```html
<aw-inst id="u_slice" mod="test_slice" idx="0">
  <aw-template base="slice_template"></aw-template>
</aw-inst>
<aw-inst id="u_slice" mod="test_slice" idx="1">
  <aw-template base="slice_template"></aw-template>
  <!-- patch：同 port 覆盖 base；新 port 追加 -->
  <aw-connect port="slice_dbg" to="slice_1_dbg"></aw-connect>
</aw-inst>
```

规则（语义冻结）：

1. 像 CSS：`name` 定义一次，多个 `aw-inst` 用 `base` 引用。  
2. **应用顺序**：先展开 `base` 模板，再应用例化上的子节点（**patch**）。同 `port`（或同 `param@name`）**后写覆盖前写**；未冲突则合并。  
3. 模板参数：`idx`、`id`、`mod` 及 `inst_name_expr` 中的占位（如 `${idx}`、`$idx`）在应用时绑定到该例化。  
4. 若写了 `inst_name_expr`，渲染后实例名 **应当**按表达式生成（保证唯一）；作者面可保留相同 `id` + 不同 `idx` 作为模板槽。  
5. 模板名默认在**本 `aw-mod` 的 `aw-content`** 内可见；跨 mod 复用另定（开放项）。  
6. `aw-templates` / 定义侧 `aw-template` **禁止**作为 dump 语义来源；只进入 `aw-render`。

此模型 **取代**旧的 `data-template` + clone 假例化；不规则生成仍可用 script。

### 3.5 其余标签

标签小写；属性加引号。

| 标签 | 出现位置 | 关键属性 |
|---|---|---|
| `aw-param` | params / template / inst | `name`；作者面 `expr`；渲染后宜有 `value` |
| `aw-port` | content 显式导出；render 导出结果 | `name`；`dir`；可选 `width` |
| `aw-inst` | content `aw-insts`；render `aw-insts` | `id`；`mod`；可选 `idx` |
| `aw-connect` | template / inst / render | `port`；`to` |
| `aw-rewrite` | 仅作者面（template / inst patch） | `port`（匹配）；`to`（替换） |
| `aw-signal` | 仅 `aw-render` / `aw-signals` | `name`；可选 `width`（本层内部 net） |

### 3.6 脚本

- `<script type="module">` **可以**放在 `aw-content` 内做不规则生成。  
- **必须**只用 DOM / `aw.*`；**禁止** layout / 对外 `fetch`。  
- 常规阵列 **应当**优先 `aw-template`，不要先上 script。

### 3.7 可访问性

节点 **应当**带可访问名字（`name` / `id`），便于 Playwright snapshot。

## 4. `<aw-render>`（生成物 / dump 输入）

每个 `aw-mod` 在 elaboration 后 **必须**填好自己的 `<aw-render>`：

| 子组 | 含义 |
|---|---|
| `aw-params` | 本模最终参数（宜 `value`） |
| `aw-ports` | 导出端口（显式 ∪ 推导） |
| `aw-signals` | 本层内部 net（由 connect/`to` 等汇总） |
| `aw-insts` | 具体实例；每实例下为展开后的 `aw-param` / `aw-connect`（**无** `aw-rewrite` / `aw-template`） |

嵌套：`aw-submods` 内子 `aw-mod` 各自有自己的 `aw-render`；父 dump 可递归收集或只序列化顶层（实现选一种，golden 锁死）。

## 5. Elaboration 顺序与总流水线

### 5.1 引擎顺序（语义冻结）

1. **顶 → 底（param）**  
   绑定/求值 `aw-param`（本模 → 例化 → template 内 param）；再应用 `inst_name_expr`。  
2. **展开 template**  
   对每个 `aw-inst`：`base` 展开 + 本地 patch。  
3. **底 → 顶（连线）**  
   叶子端口表展开 rewrite → `aw-connect`；填 `aw-signals` / 导出 `aw-ports`；写入本模 `aw-render`。  
4. **递归** `aw-submods` 中子 `aw-mod`（同样 1–3）。

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
| [`examples/connect/03-author-template-reuse.html`](./examples/connect/03-author-template-reuse.html) | template 复用 + patch |
| [`examples/connect/03-rendered-template-reuse.html`](./examples/connect/03-rendered-template-reuse.html) | 复用展开后的 render 示意 |

## 8. 开放项（实现前裁定）

1. 未在 `aw-ports` 声明、但被连线用到的信号：是否自动升为导出 port，还是只进 `aw-signals`？  
2. `aw-param@expr` → `value`：常量折叠 vs 原文透传进 SV？  
3. dump：序列化顶层 `aw-render` 子树 vs 含全部嵌套 render？  
4. 跨 `aw-mod` 引用 `aw-template` 是否允许？  
5. 工作区 toml 开放项见 [`workspace-toml.md`](./workspace-toml.md) §6。

裁定后改本文 + `help connect`，再动代码。
