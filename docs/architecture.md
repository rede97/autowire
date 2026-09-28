# 架构设计

> 综述（思想 / 目标 / 方法论）见根 [README](../README.md)；本文档承载**结构与机制**。
> 格式契约不在此重复：连接方言 [connect/html.md](./connect/html.md)、工作区配置 [workspace/toml.md](./workspace/toml.md)、RtlIndex [hdxml/rtlindex-xml.md](./hdxml/rtlindex-xml.md)。

## 1. 流水线

```text
autowire.toml（.f + svh/宏）
    →  hdxml → RtlIndex（只读）
    →  HTML（aw-content + aw-submods）
    →  check（作者面合法性 + deps；不写盘；不以 aw-render 为 SoT）
    →  elaboration → aw-render
    →  connect run 读 aw-render，写 .sv
    →  DV
```

打印机看的是 **script 跑完的 DOM**，不是源文件原文。打印机、`connect run`、Playwright 对照的页面源码都只认各 `aw-mod` 下的 `aw-render`（connect/html.md §2）。**合法性 / 依赖检查**走独立的 **check**，校验 **`aw-content`（作者面）**，与 `connect run` 读 render 写 RTL 分开（`help check`）。页面只把同一份源码放进 `#aw-generated`，不写盘。

## 2. 组件

### 2.1 hdxml（RTL 分析 sidecar）

Rust sidecar，唯一子命令 `analysis`：只读分析，产出 RtlIndex XML 目录（每源文件一个 XML + index.xml）。连接页**只读**叶子端口表，禁止改 RTL 源。CLI 见 [hdxml/cli.md](./hdxml/cli.md)；数据模型见 [hdxml/module-info.md](./hdxml/module-info.md)。

### 2.2 aw.js（Web 前端库 / elaboration 引擎）

`aw.js` + 约束 HTML，完全跑在浏览器里（Custom Elements）。
源码是 **`src/core/aw.ts`**（TypeScript）；`web/aw.js` 由 `bun run build:web` 生成（浏览器单文件，签入；新鲜度由 `test/web-build.test.ts` 守卫，禁止手改）。服务端 check 与单测直接 import `src/core/aw.ts`（Bun 原生 TS），同一源码无分叉。

**两层**（完整约束：[connect/html.md](./connect/html.md)；示例：[examples/connect/](./examples/connect/)）：

| | `aw-content`（作者） | `aw-render`（结果） |
|---|---|---|
| 内容 | imports / param / 显式 port；`aw-template`；例化 + `base`/patch | 具体 instance、signals、导出 port、逐条 connect |
| 像什么 | 声明 + 类 style 的连接规则 | elaborated 生成物（dump 只认这里） |
| 依赖 | — | `aw-submods` 嵌套子 `aw-mod`（递归） |

- 根 `<autowire>`；每模：`aw-content` → `aw-submods` → `aw-render`
- `aw-template`：`aw-inst` 下规则**必须**用其包裹；同标签 `base`+子规则 = overwrite；也可多个 template 组合
- `aw-rewrite`：`match` + `to`（JS RegExp / `String.replace`）
- 高级处理：渲染生命周期嵌入脚本（[connect/lifecycle.md](./connect/lifecycle.md)）
- Elaboration：顶→底 param → template/rewrite → 底→顶写入 `aw-render`
- dump：收集全部相关 `aw-mod` 的 `aw-render`；`aw-imports` 写在模块头并去重  
- check：独立动作，校验 **作者面** `aw-content` / submods / toml deps；**不写** `.sv`；**不**以 `aw-render` 为检查 SoT；清单见 [connect/check.md](./connect/check.md)；dump **应当**在 check 无 error 且 elaborate 无 error、已有可印 render 后才写  
- template 仅本模可见；同级 submods 互引须 `aw-mod@deps`（路径累积可见集；缺边报错）
- 未在 `help status` 开放的步骤：**先不要实现**

### 2.3 `autowire connect web [unit]`

本机起静态服务：给人用有头浏览器，给 Agent 用无头。`127.0.0.1` 同源。
页面布局与 GET 动作见 [workspace/web-ui.md](./workspace/web-ui.md)：**Check → Elaborate → Run**。Run 把源码留在页面，不写工作区。写 `.sv` 只有 `connect run`。

**生成 XML 加载**（详见 [workspace/toml.md](./workspace/toml.md) §4.2、[workspace/web-ui.md](./workspace/web-ui.md) §5）：

| 来源 | API | 用途 |
|---|---|---|
| `.autowire/hdxml/` | `/api/rtlindex`、`/api/module` | 叶子 RtlIndex，只读 |
| `.autowire/connect/` | `/api/connect?id=` | 依赖单元抽象模块信息（`<id>.xml`）；跨单元 deps 输入侧 |

浏览器不直读盘；作者 HTML 只来自 toml `html=`。

### 2.4 check（校验作者面，不写盘）

独立于 elaborate / run：`autowire connect check` / 页内 [Check] / GET `check=1`。  
校验 **`aw-content` + `aw-submods` + 依赖图**（`[connect.<id>] deps`、`aw-mod@deps` 路径累积可见集、环、缺边/多余边）。**禁止**以 `aw-render` 为 check 的 SoT；**禁止**借 check 写 `.sv` / `gen/`。完整清单：[connect/check.md](./connect/check.md)；摘要 `help check`。

### 2.5 写回（`connect run`）

浏览器不碰磁盘，静态服务也不替页面写盘。`autowire connect run` 在 happy-dom 里走完同一条相位链，校验工作区路径后写 RTL。页面 [Run] 只把 `.sv` 文本放进 `#aw-generated`；人用浏览器保存，或 MCP 读这块可见文本再自己落盘。对错由 DV 测文件，不靠禁止显示源码。  
`connect run` **应当**隐含 `check → elaborate`；check 有 error 时 **必须**拒绝写盘。render 可印性（无残留 template/rewrite）由写盘门禁负责，**不是** Check 按钮的职责。
写盘前对该单元作者 HTML 重跑 check，有 error 即拒绝，不依赖页面先跑过 check；快照里的模块名即 `.sv` 文件名，必须是纯 SV 标识符。页面上的 `/api/*` 只提供只读数据，且只接受本机 `Host`、`Origin` 缺省或同源的请求，防止用户浏览器里的其它网页借道读工作区。

### 2.6 `autowire connect run`（happy-dom，已实现）

项目主体敲定、不需要浏览器调试时，用 happy-dom 跑和页面相同的流水线：

```text
autowire connect run [unit]
```

顺序与页面一致：执行作者 HTML 的 `<script type="module">`（`aw.on`）→ `before-instances` → check → elaborate → `before-dump` → 写 `.sv` 与 connect XML。不经过浏览器。同一份 HTML 在 happy-dom 与 Chromium 中的快照必须一致。开发与 CI 的调试浏览器仍是 Playwright Chromium。页面会话不调用这条写路径。

### 2.7 生产发布包（目标）

发给用户的生产包目标仍是三颗并排二进制：`autowire`、`hdxml`、`obscura`（CDP 协议、CentOS 7 兼容的调试浏览器）。这个阶段不写打包脚本，开发与 CI 仍用 Playwright Chromium。约束见 [dev/release.md](./dev/release.md)。

## 3. Agent MCP：工具边界与双途径

根本原则与分途见 [`mcp/README.md`](./mcp/README.md)。

| 途径 | 场景 | 状态 |
|---|---|---|
| **工具** | analysis / connect check / connect run / 插件 wishbone run | 已落地；`connect run` 为 happy-dom，是唯一写 RTL 路径 |
| **A. Playwright MCP** | 隔离调试：活 DOM 与 `#aw-generated`，不另做连线 outline MCP | 已落地（`.mcp.json`） |
| **B. 工作区 MCP** | 直接改作者 HTML 节点 | **暂时不做**。这个阶段 Agent 驱动浏览器，再把可见源码存到本地 |

**禁止** MCP 内「改连接节点 → 实时网表/RTL」一体机（旧设计糊了工具与 MCP）。  
A 只打浏览器调试工作区；B 只改作者面/索引。页面不写文件。要落盘，MCP 读 `#aw-generated` 自己存，或显式调用 `connect run`。

### 3.1 Playwright 隔离调试

本节是开发与 CI 的调试路径。生产包的调试浏览器见 §2.7。

全程无头 Chromium 打开 `web` 的 URL，首屏渲染完成后再让 Agent 介入（Playwright MCP：navigate / snapshot / evaluate / click）。

- 隔离：独立浏览器上下文，只打本机页
- 调试：即浏览器调试，不另做 outline/inspect MCP
- 安全：渲染在浏览器里；**页面和静态服务都不写工作区**。`.sv` 只由 `connect run` 写，或由 MCP 把可见源码存到它自己选择的路径。

启动可以是：先 `autowire connect web`，再挂 Playwright MCP；或一条脚本两个都拉起。

## 4. 入口与阶段

| | `autowire help` / `help agent` | `autowire connect web` | `autowire connect run` |
|---|---|---|---|
| 作用 | 命令索引 / Agent 约定 | 本机页，不写盘 | happy-dom 写 `.sv` |
| 何时做 | **现在** | **现在** | **现在** |
| 渲染 | — | 浏览器 | 无浏览器 |
| Agent | 先跑这个再干活 | Playwright MCP；`window.aw.session` | 直接出 RTL |
| 落盘 | — | 不写 | 写 `.sv` 与 connect 快照；先 check |

## 5. 并列子系统（不堵连接）

- **插件**：类型 A 已落地，类型 B 暂时不做。见 [plugins/](./plugins/)。  
  - **类型 A**（Wishbone）：`plugin wishbone run` → `plugins_dir` → **analysis / RtlIndex 黑盒叶子**；connect 只 `aw-inst`。  
  - **类型 B**（自定义标签展开成 `aw-*`）：裁定保留，当前没有这类标签，不实现。  
  - 现网编排：`plugin wishbone run`(外) → before-instances → **check** → elaborate → `connect run` 写 `.sv`。页面不写。  
- **寄存器 / Wishbone**：叶子 [plugins/wishbone-regfile.md](./plugins/wishbone-regfile.md)；块内配置树 [plugins/wishbone-bus.md](./plugins/wishbone-bus.md)。开放项暂时不动。  
- 叶子 RTL：Rust sidecar 出 RtlIndex，连接页只读端口表。
