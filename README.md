# Autowire v2.0

从零设计的 RTL 寄存器与连接工具：一份内存 IR，TypeScript / Bun 实现；**mcp / script / repl 三种入口互斥**；stdio MCP 给 Agent，本机页给调试。不依赖 emacs，不用 class/装饰器当硬件类型，Excel 只出文档。

本分支只保留这份说明。实现另开。

---

## 产品

设计师用构造器描述 **功能寄存器（Block）** 和 **连接意图**。存量叶子 RTL 由独立分析器扫出端口与参数；工具按 rewrite / connect 展开连接，打印可综合的 SystemVerilog。Agent 通过 MCP 查询与修改同一棵 IR，不把展开后的网表塞进上下文。

交付物是一个可执行文件：`autowire gen-reg`、`gen-conn`、`mcp`、`run`、`repl`、`ui`。

---

## 事实源

| 层 | 唯一作者输入 | 派生（不可手改） |
|---|---|---|
| 寄存器 | `Table` + `Block` / `Cell` 构造器 | Cell IR、SV、RAL、C 头、Excel |
| 连接 | 紧凑连接 IR（可存 XML）：层级、例化、`connect`、`rewrite`、参数表达式 | 已连接 wrap SV |
| 叶子 RTL | 仓库里已有的 `.v` / `.sv` | RtlIndex（端口、参数、例化；分析器落盘产物） |

宽度、宏、parameter 一律存 **源码表达式**，第一版不求值。HTML/XML 只描述摊平后的树和连接规则，不描述 Block 打包算法。RtlIndex 落盘产物对 autowire **只读**。

---

## 寄存器

类型是数据。`uint(8)` 是函数，返回 `{ k: "uint", w: 8 }`。两个构造器代替 `kind` 字段。`append` 代替装饰器。

```ts
const master = Table("master");

master.append(
  "pll",
  Block({
    en: rw(bool(), 0),
    input_div: rw(uint(8), 1),
    rg_set: rw(uint(24), 0),
    post_div: rw(uint(8), 1),
    inner_cfg: rw(uint(48), 0),
  }),
);

master.append(
  "ctrl",
  Cell({
    go: w1p(bool()),
    busy: ro(bool()),
    mode: rw(uint(4), 0).at(8),
  }),
);
```

- **Block**：功能结构，packer 切成多个 32bit Cell；可用 `.layout(...)` 覆盖。
- **Cell**：一块总线字；字段总宽超过字宽则报错。
- **打包默认**：字段不跨 cell；`uint48` 占两格。策略必须有 golden，否则地址与验证代码会漂。

验证 / 软件 API 从 Cell IR 生成，与 RTL、Excel 同级。

---

## 连接

树节点是模块与例化。规则是一等公民：一对一 `connect`，批量 `rewrite`（emacs 风格捕获、`@`、`[]`）。匿名子模块只声明层级；具名 `inst` 才带连线。

内部引擎做连线。对外兼容 AUTO 子集，便于对照旧 wrap，**默认输出已连接 SV**，不是 AUTO 骨架。

兼容子集：`AUTO_TEMPLATE`、`AUTOINST`、`AUTOINSTPARAM`、`AUTOINPUT` / `OUTPUT` / `INOUT`、`AUTOWIRE`、library-directories。不做完整 verilog-mode，不做 slang 级 elaboration。

---

## RTL 索引

语法索引，不是 LSP，不是验证分析器。与连接 / 寄存器 IR **相对独立**：单独业务启动分析任务，产物供 autowire 只读消费。

每条模块记录：参数名与默认表达式、端口方向与宽度原文、例化（依赖图）。`` `define `` / `` `ifdef `` 只做浅处理；失败列入 `unmatched` / 分析失败队列。

不索引 always 语义、UVM、SVA，不展开 generate，不求参数值。

### Producer

- **主路径**：现成 **Rust** 分析二进制（增量、多线程/多进程）。扫描叶子 RTL，把参数、端口声明、依赖写入索引目录（多份 XML 等结构化文件 + `manifest` / `generation`）。
- **契约**：稳定 RtlIndex schema；autowire 只绑契约，不绑分析器私有 DOM。
- **一致性**：写 staging → 写 generation → 原子切换。内存里按 generation **整棵 RtlIndex 一次 swap**。禁止边写边读半成品。
- **监视**：分析器监视源 `.v` / `.sv` 做增量更新；autowire 监视索引 `generation`，刷新内部 IR。连接 IR / 寄存器 IR **不因重索引而丢弃**。
- **隔离**：SV 语法不全兼容、分析器崩溃时，失败按文件/模块入队（路径、错误、分析器版本），可优先排队定位。sidecar 退出不得拖垮 mcp / ui；可继续使用上一份可用 index。
- **生命周期**：分析是独立任务。mcp **不**因全量落盘而整会话复位或长期挂死；启动可等待首次 ready，之后重分析异步完成再原子切换。可选同步工具（见下）显式等待某次任务结束。
- **兜底**（可选）：无 sidecar 时可用 tree-sitter-systemverilog（WASM）做弱索引；不替代主路径。

---

## 生成 Verilog

连接层：遍历 IR 的 printer（TypeScript 模板字符串）。重复的 CSR 行为（W1C、shadow）用小函数或短模板。不用整文件 Jinja。

---

## 运行时与发布

TypeScript + Bun。执行时剥类型交给 JavaScriptCore，不是 `tsc` 出 ES。CI 与编辑器跑 `tsc --noEmit`。

`bun build --compile` 打成单文件。核心依赖纯 JS 与 WASM（校验、Excel、MCP SDK；可选 tree-sitter.wasm）。不上 `.node`、不上进程内嵌 Rust/JS 解释器。

Rtl 分析 **sidecar**（Rust 二进制）按可选 native 后端发布：本机路径配置或随发行附带；缺省时明确报错或降级兜底，不假装已索引。

---

## 入口：mcp / script / repl（互斥）

同一工作区同一时刻 **一个写者**。`mcp`、`run`（script）、`repl` 互斥，用 workspace lock（lockfile）仲裁；抢不到锁则退出并提示对方模式与 PID。`ui` 第一版只读，不占写锁（或共享读）。

| 模式 | 入口 | 驱动方 | 用途 |
|---|---|---|---|
| **mcp** | `autowire mcp` | Agent（结构化工具） | 有界查询与单步修改 |
| **script** | `autowire run path.js` | 本机信任脚本 | 整树批量：层级搬迁、重命名、迁移后落盘 |
| **repl** | `autowire repl` | 人 | 本机试探同一套 IR API |

- **script**：进程内 load IR → 脚本改树 → 校验 → 落盘 → 退出；与 MCP 工具共用构造器 / IR API。大批量操作走此模式，不靠 Agent 往返拼工具。
- **repl**：给人用的 CLI；**不**做成 Agent 开放 `eval`。
- **从 mcp 触发脚本（可选）**：工具 `run_script` 同步拉起受控子进程执行指定脚本，父进程持锁等待；成功后热加载新 generation，失败不切换。不是 mcp 与 script 并行写树。不把「暂停到 IDLE 再另起进程」当作主路径；需要大改时优先结束写会话后直接 `autowire run`。

---

## Agent：MCP

协议是 JSON-RPC。本地用 **stdio**：宿主启动 `autowire mcp`。不是 REST。

第一阶段工具（结果必须有界）：

`load` · `outline` · `port_groups` · `unmatched` · `deps` · `trace` · `rewrite` / `connect` / `set_param` · `preview` · `apply`

可选：`run_script`（见上）、分析失败队列查询。

`trace` / `deps` 带 `maxHops`、`limit`、`cursor`。`why` 返回命中的规则，不返回整张网表。

嵌入式 JS 沙箱（快照 + changeset + generation 门禁）**不做**到结构化工具与 `run` 成为瓶颈之后；`run` / `repl` 先按 **信任本机脚本** 落地。

配置各宿主通用：

```json
{
  "mcpServers": {
    "autowire": {
      "command": "/path/to/autowire",
      "args": ["mcp"],
      "env": { "AUTOWIRE_ROOT": "/path/to/rtl/workspace" }
    }
  }
}
```

写入位置：Cursor（`.cursor/mcp.json`）、Claude Desktop、Claude Code、Pi（项目 `.mcp.json` 或 `~/.config/mcp/mcp.json`）。可用 `autowire mcp install` 合并。

---

## 调试页

`autowire ui` 只绑 `127.0.0.1`。页面与 MCP 共用 query，懒加载树、trace 路径、generation、unmatched / 分析失败。第一版只读。静态资源打进同一二进制。

---

## 第一阶段顺序

1. Bun 骨架与单文件编译  
2. Block / Cell / Table 与 packer  
3. RtlIndex 契约 + Rust sidecar 对接（只读落盘、generation 原子切换、失败队列）  
4. 连接 IR 与 SV printer  
5. CLI（含 workspace lock）  
6. `run` / `repl` 与 stdio MCP（互斥入口）  
7. 本机 UI  

后置：WASM 弱索引兜底、嵌入 JS 沙箱门禁、HTTP MCP、更细的增量调度。
