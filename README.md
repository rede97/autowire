# Autowire v2.0

从零设计的 RTL 寄存器与连接工具：一份内存 IR，TypeScript / Bun 实现，stdio MCP 给 Agent，本机页给调试。不依赖 emacs，不用 class/装饰器当硬件类型，Excel 只出文档。

本分支只保留这份说明。实现另开。

---

## 产品

设计师用构造器描述 **功能寄存器（Block）** 和 **连接意图**。工具扫描已有叶子 RTL 的端口与参数，按 rewrite / connect 展开连接，打印可综合的 SystemVerilog。Agent 通过 MCP 查询与修改同一棵 IR，不把展开后的网表塞进上下文。

交付物是一个可执行文件：`autowire gen-reg`、`gen-conn`、`mcp`、`ui`。

---

## 事实源

| 层 | 唯一作者输入 | 派生（不可手改） |
|---|---|---|
| 寄存器 | `Table` + `Block` / `Cell` 构造器 | Cell IR、SV、RAL、C 头、Excel |
| 连接 | 紧凑连接 IR（可存 XML）：层级、例化、`connect`、`rewrite`、参数表达式 | 已连接 wrap SV |
| 叶子 RTL | 仓库里已有的 `.v` / `.sv` | RtlIndex（端口、参数、例化） |

宽度、宏、parameter 一律存 **源码表达式**，第一版不求值。HTML/XML 只描述摊平后的树和连接规则，不描述 Block 打包算法。

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

语法索引，不是 LSP，不是验证分析器。

每条模块记录：参数名与默认表达式、端口方向与宽度原文、例化（依赖图）。tree-sitter-systemverilog（WASM）抽 CST。`` `define `` / `` `ifdef `` 只做浅处理；失败列入 `unmatched`。

不索引 always 语义、UVM、SVA，不展开 generate，不求参数值。

---

## 生成 Verilog

连接层：遍历 IR 的 printer（TypeScript 模板字符串）。重复的 CSR 行为（W1C、shadow）用小函数或短模板。不用整文件 Jinja。

---

## 运行时与发布

TypeScript + Bun。执行时剥类型交给 JavaScriptCore，不是 `tsc` 出 ES。CI 与编辑器跑 `tsc --noEmit`。

`bun build --compile` 打成单文件。依赖只允许纯 JS 与 WASM（校验、Excel、MCP SDK、tree-sitter.wasm）。不上 `.node`、不上进程内 JS 解释器、不上 Rust 嵌脚本。slang 若需要，是以后的可选 native 后端。

---

## Agent：MCP

协议是 JSON-RPC。本地用 **stdio**：宿主启动 `autowire mcp`。不是 REST。不要给 Agent 做 REPL。

第一阶段工具（结果必须有界）：

`load` · `outline` · `port_groups` · `unmatched` · `deps` · `trace` · `rewrite` / `connect` / `set_param` · `preview` · `apply`

`trace` / `deps` 带 `maxHops`、`limit`、`cursor`。`why` 返回命中的规则，不返回整张网表。

嵌入 JS 沙箱（快照 + changeset + generation）**不做**，直到结构化工具往返成为瓶颈。

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

`autowire ui` 只绑 `127.0.0.1`。页面与 MCP 共用 query，懒加载树、trace 路径、generation、unmatched。第一版只读。静态资源打进同一二进制。

---

## 第一阶段顺序

1. Bun 骨架与单文件编译  
2. Block / Cell / Table 与 packer  
3. RtlIndex  
4. 连接 IR 与 SV printer  
5. CLI  
6. stdio MCP  
7. 本机 UI  

后置：宾客脚本、slang、HTTP MCP、增量 Ninja。
