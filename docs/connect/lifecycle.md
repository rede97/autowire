# 渲染生命周期与嵌入脚本（高级）

> 状态：**已实现**（`web/aw.js`；钩子 API 为 `aw.on(phase, fn)`）。  
> 常规连接：[`html.md`](./html.md) / [`rules.md`](./rules.md)。  
> 摘要：`bun index.ts help connect`。改本文时同步改 help。

## 1. 用途

声明式 `aw-template` / `aw-rewrite` / `aw-connect` 覆盖常规改名与连线。  
超出时：在 **elaboration 生命周期**上挂 `<script type="module">`，只改 **作者面 / template 展开中间态**；引擎再单向写入各 `aw-mod` 的 `<aw-render>`。

打印机 / `/api/dump` / golden **只认** `aw-render`。  
**`aw-render` 一旦写满即冻结**：钩子 **禁止**再改渲染结果。

## 2. 常规 vs 高级

| 路径 | 适用 | 载体 |
|---|---|---|
| 常规 | 精确连线、RegExp 改名、template 复用 / overwrite、param 折叠 | `aw-content` 标签 |
| 高级 | 不规则生成例化/模板、按模+例化深度改 template 展开 | 两写钩子 + DOM |

作者 **应当**先穷尽常规路径；**禁止**用脚本替代一条 `match`+`to` 即可完成的改名。  
**禁止**用脚本在 render 完成后「补丁」signals / ports / connect。

## 3. 钩子挂点（两写一冻）

与 [`html.md`](./html.md) §5 对齐。实现可钉死为 `aw.on(phase, …)` 或等价 CustomEvent（API 形态见 §6）。

```text
(per aw-mod)
  before-instances     # 写：aw-content —— 动态插入/改 aw-inst、aw-template、引用
      → 引擎：param 折叠 + inst_name + aw-localparams
  on-template          # 写：按每个 aw-inst / template 展开上下文，深度改中间 connect 列表
      → 引擎：wires / signals / ports → 写入 aw-render（冻结）
(document)
  before-dump          # 只读：校验、调试元数据；禁止改 netlist DOM
```

| 阶段 | 作用面 | 可以 | 禁止 |
|---|---|---|---|
| `before-instances` | `aw-content` | 用 JS 增删改合法作者面 `aw-inst` / `aw-template` / 引用关系 | 直接写或手搓完整 `aw-render` 当 SoT；跳过后续阶段 |
| `on-template` | template → connect **中间态**（尚未 commit 到 render） | 按当前模块与例化信息增删改即将落入 render 的 `aw-connect` / rewrite 展开结果 | 在 render 留下 rewrite/template；改已经冻结的 `aw-render` |
| （引擎）写 `aw-render` | 产物面 | — | 此后任何钩子改 render |
| `before-dump` | 活 DOM / 元数据 | **只读**校验、补非 netlist 元数据 | 改 `aw-render` 内 instances/signals/ports/connects；写工作区磁盘；对外 `fetch` |

### 3.1 编排（含插件；web 已落地）

作者面突变（类型 B 标签 expand、脚本 `before-instances`）**必须**发生在 **check 之前**，否则 Check 绿无法覆盖钩子/插件产物。类型 A `generate` **在连接流水线外**（见 [`../plugins/README.md`](../plugins/README.md) §6）。

```text
[可选] plugin generate (A) → plugins_dir → analysis → RtlIndex
单元内：
  → [B] expand 自定义标签 → 核心 aw-*
  → before-instances（脚本）
  → check（作者面 + deps；help check / check.md）
  → elaborate（params → on-template → identity/wires → 冻结 aw-render）
  → before-dump（只读）→ POST /api/dump
```

同一 HTML → 同一 `aw-render`（钩子 **应当**幂等）。elaborate **仅在本模（含子树）无新增 error 时** write/freeze `aw-render`（失败不留下半成品冻结面）。

## 4. 嵌入方式

```html
<script type="module">
  // aw.on("before-instances", ({ mod }) => {
  //   // mutate mod.querySelector(":scope > aw-content") …
  // });
  // aw.on("on-template", ({ mod, inst, template }) => {
  //   // mutate expand intermediate for this inst …
  // });
  // aw.on("before-dump", () => { /* validate only */ });
</script>
```

1. **必须** `type="module"`；与 `aw.js` 同页。  
2. **必须**只通过 DOM / 文档化 `aw.*`；禁止写盘、对外网 `fetch`。  
3. 回调 **应当**幂等。  
4. `on-template` **应当**按例化触发（参数给出当前 `mod` / `inst` / 所用 `template`）；全局汇总若需要，也只碰未 commit 的中间态。  
5. dump 前每个 `aw-render` 必须合法（无 template/rewrite），且与冻结后内容一致。

## 5. check / dump / Playwright

- 正式 **check** 走 **`autowire check` / `POST /api/check`**：校验 **作者面 `aw-content`** + deps（**不写盘**；**不以 `aw-render` 为 SoT**）；见 `help check` / [`check.md`](./check.md)。目标上 check 在 expand / `before-instances` **之后**（§3.1）。  
- snapshot 活 DOM（`aw-render` 为引擎写出后的冻结结果，供 dump / golden）。  
- 写回仍 `POST /api/dump`（全部相关 `aw-render`）；dump **应当**在 content check 无 error 且 render 可印后才写。  
- golden 比对 render，不比对脚本源。  
- **禁止**在 golden / dump 前用脚本改 render 来「对齐」期望。  
- 插件：类型 A generate 在流水线外；类型 B expand 见 [`../plugins/README.md`](../plugins/README.md)。

## 6. 裁定（随 aw.js 落地）

1. 稳定 API：**`aw.on(phase, fn)`**（`window.aw`；无 CustomEvent）。  
2. 钩子作用域：**按连接单元**（单元 id 注册表）；回调收到 `{ mod }` / `{ mod, inst, template, connects }` / `{ doc }`，自行按模过滤。  
3. 文档序：**子模整段 elaborate 完成后父模才连线**（父模可例化子包装模）。`before-instances` 是引擎前置 prepass（`runBeforeInstances`），跑完后才取叶子端口表——钩子生成的例化同样可见。  
4. **`async` 钩子不支持**（引擎同步；回调不要返回 Promise）。插件类型 B 同此裁定（[`../plugins/README.md`](../plugins/README.md)）。

已裁定（勿再打开）：**仅两写相位**；**render 完成后不可改**；`before-dump` **只读**；**作者面突变（expand / before-instances）在 check 前**（§3.1）。
