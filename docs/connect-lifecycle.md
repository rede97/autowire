# 渲染生命周期与嵌入脚本（高级）

> 状态：**草稿，先约束后实现**。  
> 常规连接：[`connect-html.md`](./connect-html.md) / [`connect-rules.md`](./connect-rules.md)。  
> 摘要：`bun index.ts help connect`。改本文时同步改 help。

## 1. 用途

声明式 `aw-template` / `aw-rewrite` / `aw-connect` 覆盖常规改名与连线。  
超出时：在 **elaboration 生命周期**上挂 `<script type="module">`，读写 DOM；最终仍写入各 `aw-mod` 的 `<aw-render>`。

打印机 / `/api/dump` / golden **只认** `aw-render`。

## 2. 常规 vs 高级

| 路径 | 适用 | 载体 |
|---|---|---|
| 常规 | 精确连线、RegExp 改名、template 复用 / overwrite、param 折叠 | `aw-content` 标签 |
| 高级 | 不规则生成、跨例化算法、后处理信号表 | 生命周期钩子 + DOM |

作者 **应当**先穷尽常规路径；**禁止**用脚本替代一条 `match`+`to` 即可完成的改名。

## 3. 钩子挂点

与 [`connect-html.md`](./connect-html.md) §5 对齐。实现可钉死为 `aw.on(phase, …)` 或等价 CustomEvent（API 形态见 §6）。

```text
(per aw-mod)
  after-parse          # 作者 DOM 已挂上
  after-params         # param 折叠 + inst_name + aw-localparams
  after-template       # rewrite → connect 列表已生成
  after-wires          # 连线 / 宽度 / signals / ports
  after-render         # 本模 aw-render 已填满
(document)
  before-dump          # 即将 POST /api/dump
```

| 阶段 | 可以 | 禁止 |
|---|---|---|
| `after-parse` | 补齐合法作者面 inst / template | 跳过后续阶段手写完整 render 当 SoT |
| `after-params` | 调整 uniquify / localparam（遵守命名） | 静默把宏/表达式折成常量 |
| `after-template` | 增删改即将落入 render 的 `aw-connect` | 在 render 留下 rewrite / template |
| `after-wires` / `after-render` | 修补 signals / ports / connect | 同上 |
| `before-dump` | 校验、补元数据 | 写工作区磁盘；对外 `fetch` |

## 4. 嵌入方式

```html
<script type="module">
  // aw.on("after-render", ({ mod }) => {
  //   const render = mod.querySelector(":scope > aw-render");
  // });
</script>
```

1. **必须** `type="module"`；与 `aw.js` 同页。  
2. **必须**只通过 DOM / 文档化 `aw.*`；禁止写盘、对外网 `fetch`。  
3. 回调 **应当**幂等（同一 HTML → 同一 `aw-render`）。  
4. 作用域默认文档内已注册的 `aw-mod`（或钩子参数给出的当前 `mod`）。  
5. dump 前每个 `aw-render` 必须合法（无 template/rewrite）。

## 5. dump / Playwright

- snapshot 活 DOM（含钩子改过的 render）。  
- 写回仍 `POST /api/dump`（全部相关 `aw-render`，见 connect-html §4.2）。  
- golden 比对 render，不比对脚本源。

## 6. 仍开放（实现前裁定）

1. 稳定 API：`aw.on(phase, fn)` vs `CustomEvent` vs 兼有？  
2. 钩子默认作用域：文档全局 vs 声明所在 `aw-mod`？  
3. 子模 `after-render` 与父模 `after-wires` 的严格先后？  
4. 是否允许 `async` 钩子？

裁定后改本文 + `help connect`，再动 `aw.js`。
