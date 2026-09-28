# 渲染生命周期与嵌入脚本（高级）

> 状态：**已实现**。普通 `<script>` 定义全局函数；`aw-content@on-init` 与 `aw-inst@on-template` 点名调用。`window.aw` 提供加实例、加规则的辅助函数。  
> 常规连接：[`html.md`](./html.md) / [`rules.md`](./rules.md)。  
> 摘要：`bun index.ts help connect`。改本文时同步改 help。

## 1. 用途

声明式 `aw-template` / `aw-rewrite` / `aw-connect` 覆盖常规改名与连线。  
超出时用普通脚本定义函数，再用属性把函数挂到元素上，和按钮的 `onclick` 一样。引擎再单向写入各 `aw-mod` 的 `<aw-render>`。

打印机、`connect run`、页面上的 `#aw-generated` **只认** `aw-render`。  
**`aw-render` 一旦写满即冻结**：脚本 **禁止**再改渲染结果。

作者 **应当**先穷尽常规路径；**禁止**用脚本替代一条 `match`+`to` 即可完成的改名。

## 2. 脚本

脚本是普通 HTML `<script>`，用来把函数放进全局作用域。脚本本身没有相位。

```html
<script>
  function buildProbe(content, mods) {
    aw.port(content, { name: "probe", dir: "output" });
    const leaf = mods("leaf");
    for (const p of leaf?.ports ?? []) {
      const u = aw.inst(content, {
        id: p.name, mod: "leaf", onTemplate: "renameClk",
      });
      aw.connect(u, { port: "clk", to: p.name + "_clk" });
    }
  }
  function renameClk(inst, mod) {
    aw.rewrite(inst, { match: "(.+)_i", to: inst.getAttribute("id") + "_$1" });
    aw.param(inst, { name: "Width", expr: mod.params[0]?.value ?? "8" });
  }
</script>
<autowire>
  <aw-mod name="leaf">
    <aw-content on-init="buildProbe">
      <aw-ports></aw-ports>
      <aw-insts>
        <aw-inst id="u" mod="leaf" on-template="renameClk"></aw-inst>
      </aw-insts>
    </aw-content>
  </aw-mod>
</autowire>
```

1. **必须**是经典脚本。**禁止** `type="module"`。  
2. 可以内联，也可以 `src`。`src` 相对作者 HTML 解析。  
3. 函数 **必须**落在 `window` 上。经典脚本里用 `function 名字`，或 `window.名字 = function …`。`const` / `let` 不会变成 `window` 的属性，属性解析不到。  
4. **禁止** `phase` 属性，**禁止** `aw.on` 注册。  
5. **禁止**写盘、对外网 `fetch`、改界面。建作者面节点用 §8 的 `aw.*` 辅助函数；它们覆盖不了的才用 `ownerDocument.createElement`。

宿主先按文档顺序执行这些脚本，再按下面的属性调用。

## 3. 两个属性

属性值是**一个**全局函数名，不是内联代码，不是函数表达式。一个属性一个函数；多个步骤写在这个函数里面。

| 属性 | 写在 | 何时调用 | 参数 | 返回值 |
|---|---|---|---|---|
| `on-init` | `aw-content` | 本层 elaborate 里，子模块整段完成之后、展开本层实例之前。每个 `aw-content` 一次 | `(content, mods)`。`mods(name)` 是已完成模块的只读事实，没有则 `null` | **忽略** |
| `on-template` | `aw-inst` | 该例化展开模板规则**之前**。目标模块（子模块、叶子或依赖单元）已经有完整事实 | `(inst, mod)`。`mod` 是目标模块的只读事实：`name` / `params` / `ports` / `imports` | **忽略** |

名字缺失、不是标识符、或 `window` 上没有这个函数：**报错**，不静默跳过。

函数 **必须**同步。**禁止** `async`，**禁止**返回 Promise。要失败就 `throw`。

## 4. 调用顺序

```text
普通 <script>（定义全局函数）
check        静态作者面，不跑脚本，不调用 on-init / on-template
elaborate    不写盘。按依赖自底向上，对每个 aw-mod：
               子模块整段完成
               → on-init(content, mods)
               → 每个 aw-inst：on-template(inst, mod)
                    → 展开 aw-connect / aw-rewrite
                    → 未覆盖端口同名自动连接
               → 引擎写 aw-render 并冻结
connect run  写 .sv
```

子模的 `on-init`、`on-template`、规则展开和 `aw-render` 都结束后，父模才调用 `on-init`。`check` 看不见脚本之后才出现的实例；要覆盖那些实例，跑 `elaborate`（它不写文件）。

没有作者侧的 `before-dump` 挂点。dump 前引擎只读冻结后的 `aw-render`。

同一 HTML → 同一 `aw-render`。两个函数都 **应当**幂等。elaborate **仅在本模（含子树）无新增 error 时**写 `aw-render`。

## 5. `on-init`

第二个参数 `mods(name)` 读取已经完成的子模块、兄弟模块、依赖单元或叶子。没有这个名字时返回 `null`。只许改**传入的那一个** `aw-content`：增删改其中的 `aw-inst`、`aw-template`、`aw-port`、`aw-param` 等作者面节点。

**禁止**写 `aw-render`。**禁止**改别的模块的 content，**禁止**改 `aw-submods` 里别的模块。嵌套模块各自的 `aw-content` 有自己的 `on-init`。

## 6. `on-template`

在引擎读取规则之前调用。函数直接改这个 `aw-inst` **自己的** `<aw-template>`（`aw-connect` / `aw-rewrite` / `aw-param`），和 `onclick` 改元素一样。没有 `<aw-template>` 时，函数可以在这个实例上补一个。

引擎随后按 [`html.md`](./html.md) §5 展开这些规则：`base` 链在前，实例自己的规则在后，同名端口后写覆盖先写。没有被规则覆盖的非 interface 端口仍自动连到同名网。

**禁止**改库里共享的 `<aw-template name="…">`。那一份会被别的例化复用。要改规则，写到当前实例自己的模板上。  
**禁止**改已经展开的 connect 数组，也 **禁止**写 `aw-render`。函数不接收、不返回连线表。

## 7. 辅助函数

`window.aw` 上有一组同步函数。一次调用追加一个作者面节点，缺的分组（`aw-insts`、`aw-ports`、实例自己的 `aw-template`）会补上。返回新建的元素。

| 调用 | 写到 | 作用 |
|---|---|---|
| `aw.inst(content, { id, mod, idx, onTemplate })` | 这棵 `aw-content` | 追加 `aw-inst`。`onTemplate` 写成 `on-template` |
| `aw.connect(inst, { port, to, type, packed, width, unpacked, part, nettype })` | 该实例自己的 `aw-template` | 追加一条连线 |
| `aw.rewrite(inst, { match, to, flags, type })` | 同上 | 追加一条改名 |
| `aw.param(inst, { name, expr })` | 同上 | 追加参数覆盖 |
| `aw.param(content, { name, expr })` | 这棵 `aw-content` | 追加模块 parameter |
| `aw.port(content, { name, dir, packed, unpacked })` | 这棵 `aw-content` | 追加端口 |
| `aw.localparam(content, { name, expr })` | 这棵 `aw-content` | 追加内部 localparam |

键就是属性名。值是字符串或数字；`null` / `undefined` 不写。函数只改传入的这一个 `aw-content` 或 `aw-inst`，不改库模板，不写 `aw-render`。

## 8. 页面

`#aw-source` 里的作者 HTML 包含这些 `<script>` 和属性。CDP 改脚本正文或属性，下一次编译再跑。  
编译在 Processed 克隆上调用 `on-init` / `on-template`，**不**把结果写回 Source。
