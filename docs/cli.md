# 命令全景

> 状态：**已落地**。现网命令以 `bun index.ts help` 为准：`analysis`、`connect`、`plugin wishbone run`。打包脚本仍见 [dev/release.md](./dev/release.md)，不在本文。

## 1. 标准在 connect，`run` 不属于共用实现

connect 是命令形状的设计标准。插件遵守这个形状，但每个插件的 `run` 是它自己的默认完整操作，不调用 connect 的相位，也不和 connect 共用一个执行器。

标准只有这几条：

- `run` 不加相位名就做完该宿主的默认全流程，不需要额外参数。
- 不写目标时，处理该宿主在 `autowire.toml` 里配置的全部对象。
- 对外只暴露有结果的入口。内部相位可以拆，但不单独成命令。
- 默认增量。要整范围重做或只刷新一个对象时，用细分参数，不改默认行为。
- 插件可以登记自己的子命令和参数。这些必须写出该插件自己的产物，不是 connect 的内部相位。

connect 的最后一步就是写 `.sv`，所以最终入口只有 `run`，不再另设 `dump`。插件的最终入口也是它自己的 `run`。

## 2. connect

本地和浏览器走同一套作者脚本。`check` 只做静态检查，不跑脚本。`elaborate` 跑经典脚本、`on-init` / `on-template`，写出 `aw-render`，不写 `.sv`。

```text
check（静态）    elaborate（脚本 + on-init + on-template + aw-render）    connect run 写 .sv
```

| 命令 | 行为 |
|---|---|
| `connect run [unit]` | happy-dom 跑经典 `<script>`，elaborate 后写 `.sv`。内容没变的文件不重写。`--force` 强制重写 |
| `connect check [unit]` | 不跑脚本。只做作者面和依赖的规则检查，打印错误和警告，不写盘 |
| `connect elaborate [unit]` | 跑脚本和 `on-init` / `on-template`，含展开期门禁，不写盘 |
| `connect web [unit]` | 只起静态页。浏览器在页面里跑同一批脚本；不把结果交给 autowire 写盘 |

`check` 是快速规则工具，不是半成品生成。`connect check` 和页面里的 Check 都只报告错误和警告。`connect run` 内部先做同样的 check，不通过就不写。没有单独的 `connect dump`；`connect elaborate` 覆盖展开期校验但不落盘，适合 CI 门禁。

`connect web` 起一个有状态的页面会话，不写工作区。静态服务只提供页面、`aw.js` 和只读数据：单元列表、作者 HTML、RtlIndex、已有的 connect 快照。会话里的活 DOM 由前端接口推进，MCP 一次调用一步。

```text
check → elaborate → before-dump
```

| 会话接口 | 作用 | 前序 |
|---|---|---|
| `check` | 静态规则检查，不跑脚本 | 无 |
| `elaborate` | 跑经典脚本和 `on-init` / `on-template`，写出冻结的 `aw-render` | 无。按钮链会先做静态 check |
| `before-dump` | 返回已冻结快照，没有作者钩子 | 本会话已 `elaborate` |
| `run` | 静态 check 通过后 elaborate，行为与 `connect run` 相同 | 无 |
| `save` | 返回当前会话里 MCP 可以落盘的文本 | 至少完成所要保存的那一步 |
| `help` | 返回上述接口的说明：顺序、前序、返回什么、不写哪些文件 | 无 |

`run` 和 CLI 走同一条相位链，得到同一份快照和 `.sv` 文本。差别只在落盘：CLI 的 `connect run` 自己写文件；页面 `run` 把同样的结果留在会话里，等 `save` 交出去。

`save` 不接收路径，也不写盘。生成结果先放进页面上可见的代码结构，再由人的保存或 MCP 的驱动取走：

- 已编辑的 `<autowire>` 作者面、connect 快照、各模块的 `.sv` 都显示在页面的代码区里，不是只留在隐藏返回值中。
- 浏览器驱动可以直接读这块可见源码并打印或 dump。MCP 再决定把它存到哪里，也可以先存到本地，再自己合并回原始 HTML。
- 人用浏览器自带的保存或下载，把当前代码区存到本地。页面不向 autowire 提交写入路径。

页面保留给人用的按钮，和以前的手动操作一样：选择单元、Check、Run、Save、Reset，以及依赖树和状态。按钮调用的就是上面的会话接口。Check 只显示错误和警告。Run 走完相位后把源码放进代码区。Save 触发浏览器保存，不写工作区。单步接口仍给 MCP 用，不必每一步都做按钮。

页面、`connect web` 和这些会话接口都不修改作者 HTML、`.sv` 或快照。合并、覆盖、选择目录都是 MCP 或人在浏览器保存对话框里做的。

`help` 用文档说明每一步能做什么、必须先完成哪一步、代码区里会出现哪一种文本，以及这一步不写文件。MCP 先读 `help`，再单步调用。

不写 `unit` 时，CLI 的 `run` 和 `check` 跑 toml 里全部 `[connect.<id>]` 和 `[sim.<id>]`，按 `deps` 拓扑。写了 unit id 或 HTML 路径时，包含该单元和它的依赖。`web` 不写 unit 时打开拓扑序的第一个，页面里可以切换。会话接口作用在当前打开的单元；要换单元先切换会话。

CLI `analysis run`、`connect run`、`plugin wishbone run` 默认都是增量：输出字节和已有文件相同就跳过。三条命令共用 `--force`，加上之后强制重写。analysis 的 `--force` 仍然是 hdxml 的全量重解析。wishbone 的 Excel 每次都写，因为它的工作簿带生成时间，不能靠字节判断。

`connect run` 是唯一写 `.sv` 的入口。页面会话不写文件。

## 3. analysis

`analysis` 是一组子命令。`init` 仍留在顶层。依赖树是 `analysis deps`，没有顶层 `deps`。

```text
autowire analysis run
autowire analysis deps [module]
autowire analysis search [options] <pattern>
autowire analysis info <module>
```

| 命令 | 行为 |
|---|---|
| `analysis run` | 按 `autowire.toml` 跑 hdxml，增量写出 `.autowire/hdxml`。`--force` 全量重解析 |
| `analysis deps [module]` | 打印 RTL 模块依赖。不写 module 时输出索引里的全部依赖关系 |
| `analysis search <pattern>` | 在索引里检索，不写盘 |
| `analysis info <module>` | 按准确模块名格式化打印该模块在 index 里的 param 和 port |

`deps` 的 module 是可选过滤器，只打印这一个模块的依赖关系。`--depth <n>` 限制展开深度。没有索引就报错，提示先 `analysis run`；它不自己临时解析 RTL。

`search` 的种类用参数选择，一次一种：

- `--module`
- `--port`
- `--package`
- `--enum`

不写种类时搜模块名。`<pattern>` 默认是模糊名称；`--regex` 时按正则。每条结果给出名字、命中的 index XML 文件，以及该定义所在的 RTL 文件。模块和 package 带声明行号；端口和 enum 带所属 module / package 的声明行号，因为索引没有成员自己的行号。同名多处命中都列出来。

`info` 只接受一个准确模块名。输出该模块在 index 里的 param、port，以及对应的 XML 文件和 RTL 文件。名字不存在就报错，不退回模糊搜索。

这四条都不修改作者 HTML、`.sv` 或 connect 快照。`run` 只更新 RtlIndex。`search` 和 `info` 是 [`mcp/workspace.md`](./mcp/workspace.md) 里快速检索的命令形态；MCP 若要查索引，调用这些命令，不另做一套检索。

## 4. 插件各自的 `run`

```text
autowire plugin <id> run [target]
autowire plugin <id> <插件自己的相位> [target]
```

`plugin wishbone run` 只做 wishbone 自己的全流程：

```text
import SoT
  → Bus() / Regfile() 构造期检查
  → layout
  → 列出的 regfile
  → flatten SlaveBus
  → 挂接但未单列的叶子
  → decoder / interconnect + <bus>_system
  → pipe / master 桥接模板
  → C / uvm_reg / Excel
```

地址重叠、广播二选一、同一广播的 `pipe` 等长，都发生在 SoT 被 import、`Bus()` 执行的时候。这不是 connect 的 `check`。类型 A 不进 connect 相位，也不由页面写盘。SV 仍进 `plugins_dir/<id>/`，软件路径仍由 `[plugins.wishbone]` 决定。

wishbone 可以登记自己的相位和参数，例如只印 regfile、只印某条 bus。这些相位的前序由 wishbone 声明。未登记的插件 id 直接报错。`wishbone-regfile` 和 `wishbone-bus` 不再是会改道执行的别名。

`run` 默认按 SoT 指纹增量。`--force` 重写所选范围。`--only <name>` 只处理 toml 里的一个 `[wishbone.<name>]` 源；不是 `RegfileDef.name`。被它挂接且指纹变了的叶子必须一起重写。不写 `--only` 时处理配置里的全部 wishbone 源。

## 5. 不改的边界

- `init <name>` 留在顶层。它创建 `autowire.toml`（带 `[workspace] name`，风格对齐 demo/soc）、`AGENTS-AUTOWIRE.md`（仓库根目录 `AGENTS.md` 的副本）、`.autowire/hdxml/`（RtlIndex 固定目录）和 `.autowire/dsl/`（wishbone DSL 源码，独立工作区 SoT 从这里 import；属可删缓存，`plugin wishbone run` 缺失时自动补回）；toml 或 AGENTS-AUTOWIRE.md 已存在则都不写。
- `plugin wishbone run` 不调用 `connect run`。生成出的 SV 仍要再经 `analysis run`，connect 才能把它当叶子例化。
- 类型 B 若落地，展开仍是 connect 相位链里 check 之前的一步，不另做一个顶层 `run`。
