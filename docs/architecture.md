# 架构设计

> 综述（思想 / 目标 / 方法论）见根 [README](../README.md)；本文档承载**结构与机制**。
> 格式契约不在此重复：连接方言 [connect-html.md](./connect-html.md)、工作区配置 [workspace-toml.md](./workspace-toml.md)、RtlIndex [hdxml/rtlindex-xml.md](./hdxml/rtlindex-xml.md)。

## 1. 流水线

```text
autowire.toml（.f + svh/宏）
    →  hdxml → RtlIndex（只读）
    →  HTML（aw-content + aw-submods）
    →  elaboration → aw-render
    →  POST /api/dump（读 aw-render）
    →  autowire 写 .sv
    →  DV
```

打印机看的是 **script 跑完的 DOM**，不是源文件原文。打印机、`/api/dump`、Playwright golden 只认各 `aw-mod` 下的 `aw-render`（connect-html.md §2）。

## 2. 组件

### 2.1 hdxml（RTL 分析 sidecar）

Rust sidecar，唯一子命令 `analysis`：只读分析，产出 RtlIndex XML 目录（每源文件一个 XML + index.xml）。连接页**只读**叶子端口表，禁止改 RTL 源。CLI 见 [hdxml/cli.md](./hdxml/cli.md)；数据模型见 [hdxml/module-info.md](./hdxml/module-info.md)。

### 2.2 aw.js（Web 前端库 / elaboration 引擎）

`aw.js` + 约束 HTML，完全跑在浏览器里（Custom Elements）。

**两层**（完整约束：[connect-html.md](./connect-html.md)；示例：[examples/connect/](./examples/connect/)）：

| | `aw-content`（作者） | `aw-render`（结果） |
|---|---|---|
| 内容 | imports / param / 显式 port；`aw-template`；例化 + `base`/patch | 具体 instance、signals、导出 port、逐条 connect |
| 像什么 | 声明 + 类 style 的连接规则 | elaborated 生成物（dump 只认这里） |
| 依赖 | — | `aw-submods` 嵌套子 `aw-mod`（递归） |

- 根 `<autowire>`；每模：`aw-content` → `aw-submods` → `aw-render`
- `aw-template`：`aw-inst` 下规则**必须**用其包裹；同标签 `base`+子规则 = overwrite；也可多个 template 组合
- `aw-rewrite`：`match` + `to`（JS RegExp / `String.replace`）
- 高级处理：渲染生命周期嵌入脚本（[connect-lifecycle.md](./connect-lifecycle.md)）
- Elaboration：顶→底 param → template/rewrite → 底→顶写入 `aw-render`
- dump：收集全部相关 `aw-mod` 的 `aw-render`；`aw-imports` 写在模块头并去重
- template 仅本模可见；同级 submods 仅允许文档序向前引用
- **先文档约束，未实现前不要假装能渲染或 dump**

### 2.3 `autowire web [html]`

本机起服务：给人用有头浏览器，给 Agent 用无头。`127.0.0.1` 同源。
页面布局（header 动作按钮 + 左栏 dep tree / DB 摘要 + 右栏模块预览）与 GET 参数自动动作链见 [web-ui.md](./web-ui.md)：无参打开不执行任何动作（人工），带参按 `select → render → dump` 自动执行并落 `#aw-status`（Agent）。

### 2.4 写回（`/api/dump`）

浏览器不碰磁盘。页面或 Playwright 把渲染结果 `POST` 到同源 `/api/dump`，autowire 校验工作区路径后写 RTL。对错由 DV 测文件，不靠禁止 dump。

### 2.5 `autowire cli`（后期）

等 Web 测试用例和 golden 稳定，再做完全无头 CLI（同一套抽取逻辑，进程内或无头浏览器）：

```text
autowire cli phy.html --dump gen/
```

`deps` 等 RtlIndex 查询可另挂在 cli 上，与连接渲染分开。

## 3. 隔离与调试：Playwright

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
| 落盘 | — | Web API → autowire 写文件 | `--dump`，同一写盘代码 |

## 5. 并列子系统（不堵连接）

- 寄存器：`Table` + `Block` / `Cell`，类型是数据；Excel 只出文档。
- 叶子 RTL：Rust sidecar 出 RtlIndex，连接页只读端口表。
