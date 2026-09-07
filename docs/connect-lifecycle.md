# 渲染生命周期与嵌入脚本（高级）

> 状态：**草稿，先约束后实现**。禁止据此假装 `aw.js` 钩子 API 已落地。  
> 常规连接仍以 [`connect-html.md`](./connect-html.md) / [`connect-rules.md`](./connect-rules.md) 的 template + `aw-rewrite@match`+`to` 为准。  
> 摘要：`bun index.ts help connect`。改本文时同步改 help。

## 1. 为何单独成章

`aw-template` / `aw-rewrite` / `aw-connect` 已覆盖批量改名与精确连线。  
**不再**提供 `aw-rewrite@fn` 或 `aw.rewrite.define` 这类「规则属性级回调」。

超出声明式能力时：在 **elaboration 生命周期**上挂 `<script type="module">`，读写 DOM（最终仍写入各 `aw-mod` 的 `<aw-render>`）。  
打印机 / `/api/dump` / golden **仍然只认** `aw-render`，不认脚本原文。

## 2. 常规 vs 高级

| 路径 | 适用 | 载体 |
|---|---|---|
| **常规** | 精确连线、RegExp 改名、template 复用 / overwrite、param 折叠 | `aw-content` 内标签 |
| **高级** | 不规则生成、跨例化算法、后处理信号表、与页面调试逻辑耦合 | 生命周期钩子 + DOM |

作者 **应当**先穷尽常规路径；高级脚本 **禁止**替代可写成 `match`+`to` 的改名。

## 3. Elaboration 阶段（钩子挂点）

与 [`connect-html.md`](./connect-html.md) §5.1 对齐。每个 `aw-mod` 递归处理；钩子名实现时可钉死为 `aw.on(phase, …)` 或等价 CustomEvent（落地前开放项）。

```text
(per aw-mod, depth-first on aw-submods as chosen by impl)
  after-parse          # 作者 DOM 已挂上；尚未折叠 param
  after-params         # param 折叠 + inst_name + aw-localparams 已写入（可部分）
  after-template       # base/overwrite 展开；rewrite→connect 列表已生成（可仍在 staging）
  after-wires          # 底→顶连线 / 宽度改写 / aw-signals / 导出 ports 完成
  after-render         # 本模 <aw-render> 已填满；可 golden 比对本模
(document)
  before-dump          # 即将 POST /api/dump；只读检查或最后修补 render
```

| 阶段 | 脚本 **可以** | 脚本 **禁止** |
|---|---|---|
| `after-parse` | 生成/补齐作者面 `aw-inst` / 匿名 template（仍须合法方言） | 手写完整 `aw-render` 当 SoT 却跳过后续阶段 |
| `after-params` | 调整 uniquify 名、补 localparam（须遵守 `Mod__Inst__Param`） | 把宏/表达式静默折成常量 |
| `after-template` | 增删改即将落入 render 的 `aw-connect` | 重新引入 `aw-rewrite@fn` 语义 |
| `after-wires` / `after-render` | 修补 `aw-signals` / 导出 `aw-ports` / 实例下 connect | 留下 `aw-rewrite` / `aw-template` 在 `aw-render` 内 |
| `before-dump` | 校验、补元数据 | 写工作区磁盘；对外 `fetch` |

未列出的中间阶段 **不应当**当作稳定 API；需要时先改本文再实现。

## 4. 嵌入方式

```html
<autowire>
  <aw-mod name="top">
    <aw-content>
      <!-- 常规 template / rewrite / connect … -->
      <script type="module">
        // 示意：aw.js 提供生命周期注册（API 名以实现为准）
        // aw.on("after-render", ({ mod }) => {
        //   const render = mod.querySelector(":scope > aw-render");
        //   /* 只改 render 子树 */
        // });
      </script>
    </aw-content>
    …
  </aw-mod>
</autowire>
```

约束：

1. **必须** `type="module"`（或实现钉死的等价模块脚本）；与 `aw.js` 同页。  
2. **必须**只通过 DOM / 文档化的 `aw.*` 读写；**禁止** Node `fs`、写工作区、对外网 `fetch`。  
3. 钩子回调 **应当**幂等：同一 HTML 多次 elaboration → 同一 `aw-render`（golden 可锁）。  
4. 脚本 **可以**放在 `aw-content` 末尾或文档级；作用域默认「当前文档已注册的全部 `aw-mod`」，除非钩子参数给出当前 `mod`。  
5. dump 前 **必须**保证每个 `aw-mod` 的 `aw-render` 结构合法（无 template/rewrite）。

## 5. 与 dump / Playwright

- 调试：Playwright 在 first paint / elaboration 完成后 snapshot **活 DOM**（含脚本改过的 `aw-render`）。  
- 写回：仍 `POST /api/dump` 序列化 `aw-render`；浏览器不写盘。  
- 用例 **应当**覆盖「仅声明式」与「声明式 + 生命周期钩子」两类；golden 比对 render，不比对脚本源。

## 6. 不要做

- `aw-rewrite@fn` / `aw.rewrite.define`（已废除）  
- 在钩子里绕过 `aw-render`、直接拼 SV 文本当 dump 输入  
- 钩子依赖墙钟时间、随机数、或外部网络（破坏可重复 golden）  
- 用生命周期脚本实现本可用一条 `match`+`to` 完成的改名  

## 7. 开放项（实现前裁定）

1. 稳定 API 形态：`aw.on(phase, fn)` vs `CustomEvent` vs 两者兼有？  
2. 钩子默认作用域：文档全局 vs 仅声明所在 `aw-mod`？  
3. `aw-submods` 递归：子模 `after-render` 与父模 `after-wires` 的严格先后？  
4. 异步钩子（`async`）是否允许？若允许，elaboration 如何 await？  

裁定后改本文 + `help connect` + [`connect-html.md`](./connect-html.md)，再动 `aw.js`。
