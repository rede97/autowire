# Autowire v2.0

连接描述是一份 **HTML + script**。浏览器跑完 script，活 DOM 就是连接关系。把渲染结果交给 autowire，由它写成 RTL，后面走 DV。

前期 autowire 就是一个 **Web 前端库**（自定义元素 + 页面）。隔离和调试交给 **Playwright**（无头 + Playwright MCP）。等页面用例够多，用这些用例约束再做完全无头的 `cli`。不为连接层自研 MCP。

**Agent 接手：先跑 `bun index.ts help`（或 `autowire help`）。那就是用法和思路，不要另写项目提示词。改行为时同步改 `src/help.ts`。**

---

## 为什么简单

| 问题 | 做法 |
|---|---|
| 作者输入 | 一份可嵌多层的 HTML，静态标签 + `<script>` |
| 渲染 | 真浏览器跑 `aw.js`（Custom Elements） |
| 调试 / 隔离 | Playwright 无头打开本机页；Agent 用 Playwright MCP，和调普通前端一样 |
| 安全 | 浏览器沙箱 + `127.0.0.1`；页面不直接写盘 |
| 落盘 | `POST` 渲染结果 → autowire Web API → 写工作区 RTL → DV |
| 谁写 script | 不管（人或 Agent） |
| 无头 CLI | **后做**；必须通过已有 Web 测试 / golden |

没有平行连接 IR，没有 emacs 进程，没有连接专用 MCP 工具表。

---

## 流水线

```text
HTML + script
    →  浏览器 / Playwright 渲染（elaboration）
    →  活 DOM = 连接关系
    →  POST /api/dump（结构化结果或 SV）
    →  autowire 写 .sv
    →  DV
```

打印机看的是 **script 跑完的 DOM**，不是源文件原文。

---

## 前期：Web 前端库

`aw.js` + 约束 HTML，完全跑在浏览器里。

- 标签：`aw-mod`、`aw-inst`、`aw-connect`、`aw-rewrite`、`aw-param`（小写、属性加引号）
- 一份文件可嵌套多层；`id` 在路径下唯一
- 静态规则对齐 emacs Verilog-mode 心智（rewrite 捕获、`@`、`[]`、AUTO 子集语义）
- `<script>` 做复杂例化（clone、改 id）
- 脚本只用 DOM / `aw.*`，不要依赖 layout、不要对外 `fetch`
- 节点带可访问名字，方便 Playwright snapshot

```html
<aw-mod name="master_cfg_wrap">
  <aw-inst id="u_decoder" mod="m2_ddrphy_master_decoder">
    <aw-param name="PIPE_NUM" expr="BUS_PIPE_NUM"></aw-param>
    <aw-connect port="dec_clk" to="dfi_clk"></aw-connect>
    <aw-rewrite port="dec_in_(.*)" to="mst_blk_reg_$1[]"></aw-rewrite>
  </aw-inst>
  <script type="module">
    // 复杂例化
  </script>
</aw-mod>
```

`autowire web [html]`：本机起服务，给人用有头浏览器，给 Agent 用无头。

---

## Playwright：隔离 + 调试

全程无头 Chromium 打开 `web` 的 URL，首屏渲染完成后再让 Agent 介入（Playwright MCP：navigate / snapshot / evaluate / click）。

- 隔离：独立浏览器上下文，只打本机页  
- 调试：即浏览器调试，不另做 outline/inspect MCP  
- 安全：渲染在浏览器里；**写文件只经 autowire API**

启动可以是：先 `autowire web`，再挂 Playwright MCP；或一条脚本两个都拉起。

---

## 写回

浏览器不碰磁盘。页面或 Playwright 把渲染结果 `POST` 到同源 `/api/dump`，autowire 校验工作区路径后写 RTL。对错由 DV 测文件，不靠禁止 dump。

---

## 后期：`autowire cli`

等 Web 测试用例和 golden 稳定，再做完全无头 CLI（同一套抽取逻辑，进程内或无头浏览器）。

```text
autowire cli phy.html --dump gen/
```

**用例约束后端**：cli 必须通过现有 Web / Playwright 测试（同一 HTML → 同一 RTL）。先做 cli、再补测试，不允许。

`deps` 等 RtlIndex 查询可另挂在 cli 上，与连接渲染分开。

---

## 入口

| | `autowire help` | `autowire web` | `autowire cli` |
|---|---|---|---|
| 作用 | Agent 接手说明（用法 + 思路） | 本机页渲染 | 后期无头 |
| 何时做 | **现在** | **现在** | 用例够了以后 |
| 渲染 | — | 浏览器 | 无头，被测试锁死 |
| Agent | 先跑这个再干活 | Playwright MCP | 无浏览器时直接出 RTL |
| 落盘 | — | Web API → autowire 写文件 | `--dump`，同一写盘代码 |

---

## 寄存器与叶子索引（并列，不堵连接）

- 寄存器：`Table` + `Block` / `Cell`，类型是数据；Excel 只出文档。  
- 叶子 RTL：Rust sidecar 出 RtlIndex，连接页只读端口表。  

---

## 不做

- XML / 一层一份连接文件当 SoT  
- 连接专用 MCP（`outline`、`apply`、`rewrite`…）  
- `mcp` / `run` / `repl` 当主入口  
- 浏览器直接写工作区  
- 先做 cli 再补 Web 用例  
- 两套连线语义（Web 与 cli 必须同一 `aw.js` + 同一 golden）  
- 为每个芯片项目复制一份连接提示词（改 `src/help.ts`）  
