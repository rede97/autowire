# Autowire v2.0

连接描述是一份 **HTML + script**。浏览器跑完 script，活 DOM 就是连接关系。把渲染结果交给 autowire，由它写成 RTL，后面走 DV。

前期 autowire 就是一个 **Web 前端库**（自定义元素 + 页面）。隔离和调试交给 **Playwright**（无头 + Playwright MCP）。等页面用例够多，用这些用例约束再做完全无头的 `cli`。不为连接层自研 MCP。

**Agent 接手：先跑 `bun index.ts help`（或 `autowire help`）。那就是用法和思路，不要另写项目提示词。改行为时同步改 `src/help.ts`。格式约束见 [`docs/`](docs/README.md)。**

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
autowire.toml（.f + svh/宏）
    →  hdxml → RtlIndex（只读）
    →  HTML + script
    →  ① 顶→底 param  ② 底→顶连线（elaboration）
    →  活 DOM = 连接关系
    →  POST /api/dump（结构化结果或 SV）
    →  autowire 写 .sv
    →  DV
```

工作区配置：[`docs/workspace-toml.md`](docs/workspace-toml.md)。连接方言：[`docs/connect-html.md`](docs/connect-html.md)。

打印机看的是 **script 跑完的 DOM**，不是源文件原文。

---

## 前期：Web 前端库

`aw.js` + 约束 HTML，完全跑在浏览器里。

**两层（完整约束：[`docs/connect-html.md`](docs/connect-html.md)；示例：[`docs/examples/connect/`](docs/examples/connect/)）**

| | 作者 HTML（源） | 渲染后活 DOM（结果） |
|---|---|---|
| 内容 | 模块名 + 可选参数；例化 / 连线 / param **模板** | 具体 instance、连线、**导出端口**（生成物） |
| 像什么 | 带 rewrite / script 的模板 | elaborated XML：生成的 port、生成的实例 |
| 谁看 | 人 / Agent 编辑 | 打印机、`/api/dump`、golden |

- 作者标签：`aw-mod`、`aw-inst`、`aw-connect`、`aw-rewrite`、`aw-param`
- Elaboration：**顶→底**推 param，**底→顶**连线 / 导出 port
- 渲染后多出生成的：`aw-port`、展开后的 `aw-inst` / `aw-connect`（rewrite 落成逐条 connect）
- 一份文件可嵌多层；`id` 在父路径下唯一
- 静态规则对齐 emacs Verilog-mode 心智（rewrite 捕获、`@`、`[]`、AUTO 子集）
- `<script>` 做复杂例化（clone、改 id）；只用 DOM / `aw.*`
- **先文档约束，未实现前不要假装能渲染或 dump**

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
- 把连接关系写进 `autowire.toml`（toml 只做工程 / RTL 宇宙配置）  
- 为每个芯片项目复制一份连接提示词（改 `src/help.ts`）  
