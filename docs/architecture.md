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
    →  POST /api/dump（读 aw-render）
    →  autowire 写 .sv
    →  DV
```

打印机看的是 **script 跑完的 DOM**，不是源文件原文。打印机、`/api/dump`、Playwright golden 只认各 `aw-mod` 下的 `aw-render`（connect/html.md §2）。**合法性 / 依赖检查**走独立的 **check**，校验 **`aw-content`（作者面）**，与 dump 读 render 写 RTL 分开（`help check`）。

## 2. 组件

### 2.1 hdxml（RTL 分析 sidecar）

Rust sidecar，唯一子命令 `analysis`：只读分析，产出 RtlIndex XML 目录（每源文件一个 XML + index.xml）。连接页**只读**叶子端口表，禁止改 RTL 源。CLI 见 [hdxml/cli.md](./hdxml/cli.md)；数据模型见 [hdxml/module-info.md](./hdxml/module-info.md)。

### 2.2 aw.js（Web 前端库 / elaboration 引擎）

`aw.js` + 约束 HTML，完全跑在浏览器里（Custom Elements）。
源码是 **`src/core/aw.ts`**（TypeScript）；`web/aw.js` 由 `bun run build:web` 生成（浏览器单文件，签入；新鲜度由 `src/web-build.test.ts` 守卫，禁止手改）。服务端 check 与单测直接 import `src/core/aw.ts`（Bun 原生 TS），同一源码无分叉。

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
- check：独立动作，校验 **作者面** `aw-content` / submods / toml deps；**不写** `.sv`；**不**以 `aw-render` 为检查 SoT；dump **应当**在 check 无 error 且已有可印 render 后才写  
- template 仅本模可见；同级 submods 互引须 `aw-mod@deps`（路径累积可见集；缺边报错）
- **先文档约束，未实现前不要假装能渲染、check 或 dump**

### 2.3 `autowire web [html]`

本机起服务：给人用有头浏览器，给 Agent 用无头。`127.0.0.1` 同源。
页面布局与 GET 动作见 [workspace/web-ui.md](./workspace/web-ui.md)：**Check → Render → Dump**（Render 依赖 Check；Check 只验 aw-content）。

**生成 XML 加载**（详见 [workspace/toml.md](./workspace/toml.md) §4.2、[workspace/web-ui.md](./workspace/web-ui.md) §5）：

| 来源 | API | 用途 |
|---|---|---|
| `.autowire/hdxml/` | `/api/rtlindex`、`/api/module` | 叶子 RtlIndex，只读 |
| `.autowire/connect/` | `/api/connect?id=` | 依赖单元抽象模块信息（`<id>.xml`）；跨单元 deps 输入侧 |

浏览器不直读盘；作者 HTML 只来自 toml `html=`。

### 2.4 check（校验作者面，不写盘）

独立于 render / dump：`autowire check` / 页内 [Check] / `POST /api/check` / GET `check=1`。  
校验 **`aw-content` + `aw-submods` + 依赖图**（`[connect.<id>] deps`、`aw-mod@deps` 路径累积可见集、环、缺边/多余边）。**禁止**以 `aw-render` 为 check 的 SoT；**禁止**借 check 写 `.sv` / `gen/`。详见 `help check`。

### 2.5 写回（`/api/dump`）

浏览器不碰磁盘。页面或 Playwright 把渲染结果 `POST` 到同源 `/api/dump`，autowire 校验工作区路径后写 RTL。对错由 DV 测文件，不靠禁止 dump。  
dump **应当**隐含 `check → render`（**Render 依赖 Check**，见 [workspace/web-ui.md](./workspace/web-ui.md) §3.1）；check 有 error 时 **必须**拒绝 render 与写盘。render 可印性（无残留 template/rewrite）由 dump 门禁负责，**不是** Check 按钮的职责。

### 2.6 `autowire cli`（后期）

等 Web 测试用例和 golden 稳定，再做完全无头 CLI（同一套抽取逻辑，进程内或无头浏览器）：

```text
autowire cli phy.html --check
autowire cli phy.html --dump gen/
```

`deps` 等 RtlIndex 查询可另挂在 cli 上，与连接渲染分开。`--dump` **应当**隐含 `--check`。

## 3. Agent MCP：工具边界与双途径

根本原则与分途见 [`mcp/README.md`](./mcp/README.md)。

| 途径 | 场景 | 状态 |
|---|---|---|
| **工具** | analysis / check / render / dump / 插件 generate | 连接核心已落地（cli 除外） |
| **A. Playwright MCP** | 隔离调试：活 DOM，不另做连线 outline MCP | 已落地（`.mcp.json`） |
| **B. 工作区 MCP** | 作者 HTML 节点 Edit；RtlIndex 检索；analysis/reload | 草稿，见 [`mcp/workspace.md`](./mcp/workspace.md) |

**禁止** MCP 内「改连接节点 → 实时网表/RTL」一体机（旧设计糊了工具与 MCP）。  
A 只打浏览器调试工作区；B 只改作者面/索引——出结果仍须显式走 Web 工具路径。

### 3.1 Playwright 隔离调试

全程无头 Chromium 打开 `web` 的 URL，首屏渲染完成后再让 Agent 介入（Playwright MCP：navigate / snapshot / evaluate / click）。

- 隔离：独立浏览器上下文，只打本机页
- 调试：即浏览器调试，不另做 outline/inspect MCP
- 安全：渲染在浏览器里；**写文件只经 autowire API**

启动可以是：先 `autowire web`，再挂 Playwright MCP；或一条脚本两个都拉起。

## 4. 入口与阶段

| | `autowire help` / `help agent` | `autowire web` | `autowire cli` |
|---|---|---|---|
| 作用 | 命令索引 / Agent 约定 | 本机页渲染 | 后期无头 |
| 何时做 | **现在** | **现在** | 用例够了以后 |
| 渲染 | — | 浏览器 | 无头，被测试锁死 |
| Agent | 先跑这个再干活 | Playwright MCP | 无浏览器时直接出 RTL |
| 落盘 | — | `/api/check` 不写；`/api/dump` → autowire 写文件 | `--check` / `--dump`（dump 隐含 check） |

## 5. 并列子系统（不堵连接）

- **插件机制**（草稿）：登记自定义标签；分 **生成器**（印 SV → analysis → connect 例化）与 **展开器**（elaborate 成核心 `aw-*`）。见 [plugins/](./plugins/)。  
- **寄存器 / Wishbone**：叶子见 [plugins/wishbone-regfile.md](./plugins/wishbone-regfile.md)；块内配置树（arbiter/decoder/pipe，默认非 matrix；SoC fabric 交给商业 EDA）见 [plugins/wishbone-bus.md](./plugins/wishbone-bus.md)。  
- 叶子 RTL：Rust sidecar 出 RtlIndex，连接页只读端口表。
