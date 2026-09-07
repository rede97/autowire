// Agent 接手说明。改行为时同步改这里，不要另写项目提示词。
// 打印：`bun index.ts help` 或 `autowire help [topic]`

export const HELP_TOPICS = [
  "agent",
  "status",
  "workspace",
  "connect",
  "web",
  "dump",
  "cli",
  "deps",
  "dont",
] as const;

export type HelpTopic = (typeof HELP_TOPICS)[number];

const SECTIONS: Record<HelpTopic, string> = {
  agent: `\
Autowire — Agent 接手说明

先读完再动手。本输出即工作约定，不要另写项目提示词。
切片：autowire help <topic>   topic = ${HELP_TOPICS.join(" | ")}

这是什么
  连接描述是一份 HTML + <script>。浏览器跑完 script，活 DOM 就是连接关系。
  把渲染结果交给 autowire，由它写成 RTL，后面走 DV。

  前期 autowire 是 Web 前端库（aw.js 自定义元素 + 本机页）。
  隔离和调试交给 Playwright（无头 + Playwright MCP）。
  等页面用例和 golden 够了，再用这些用例约束完全无头的 cli。
  不为连接层自研 MCP。

为什么这样
  作者输入     一份可嵌多层的 HTML，静态标签 + <script>
  渲染         真浏览器跑 aw.js（Custom Elements）
  调试 / 隔离  Playwright 无头打开本机页；Agent 用 Playwright MCP
  安全         浏览器沙箱 + 127.0.0.1；页面不直接写盘
  落盘         POST 渲染结果 → autowire Web API → 写工作区 RTL → DV
  谁写 script  不管（人或 Agent）
  无头 CLI     后做；必须通过已有 Web / Playwright 测试与 golden

  没有平行连接 IR，没有 emacs 进程，没有连接专用 MCP 工具表。

你现在就能做
  1. 读本 help，按「禁止」约束自己。
  2. 用 deps 看叶子 RTL 层级（RtlIndex / hdxml）。
  3. 按 connect 方言写或改 HTML（完整约束 docs/connect-html.md；即便 aw.js 还没落地）。
  4. web / dump / cli 未落地时：不要假装已经能渲染或写盘；先补库和测试。

web 落地后怎么干活（连接）
  1. 在工作区启动：autowire web [html]
  2. 等本机页首屏渲染完成（aw.js 定义完、script 跑完）。
  3. 用 Playwright MCP 挂无头 Chromium：navigate / snapshot / evaluate。
     看的是活 DOM（可访问名字），不是源 HTML 原文。
  4. 需要落盘时，从页面或 Playwright POST 同源 /api/dump。
     浏览器不写磁盘；autowire 校验工作区路径后写 .sv；对错由 DV 测文件。
  5. 没有浏览器的机器等 cli；cli 必须先通过现有 Web 用例，禁止先做 cli。

流水线
  autowire.toml（.f + svh/宏）
      →  hdxml → RtlIndex（只读）
      →  HTML + script
      →  ① 顶→底 param  ② 底→顶连线（elaboration）
      →  活 DOM = 连接关系
      →  POST /api/dump
      →  autowire 写 .sv
      →  DV
`,

  status: `\
当前状态（以代码为准，不要臆造已完成的命令）

已落地
  autowire help [topic]     本说明
  autowire deps <path>      RTL 模块依赖树
                            path = RtlIndex 目录（含 index.xml）
                                 或 RTL 源码目录（先调 hdxml sidecar 分析）
  hdxml sidecar             Rust；analysis → RtlIndex XML；只读消费
  Playwright 环境           无头 Chromium（headless shell）已装；Playwright MCP 经 .mcp.json
                            提供（--headless --isolated，只放行 127.0.0.1/localhost 源）

未落地（按此顺序做，不要跳）
  autowire.toml 读取        工作区 .f / 宏 / .svh → 喂 hdxml（约束见 docs/workspace-toml.md）
  aw.js + 约束 HTML 自定义元素
  autowire web [html]       本机 HTTP，渲染页
  POST /api/dump            浏览器不写盘，autowire 写工作区 RTL
  Playwright 用例 / golden  同一 HTML → 同一 RTL
  autowire cli              完全无头；必须被上述用例锁死

并列、不堵连接
  寄存器 Table + Block/Cell（类型是数据；Excel 只出文档）
  叶子端口表从 RtlIndex 只读喂给连接页
`,

  workspace: `\
工作区配置 autowire.toml（草稿，未实现）

完整约束：docs/workspace-toml.md

同一份顶层配置，供 deps / web / cli 共享 RTL 宇宙：
  源码入口 .f（及 walk/sources）
  宏 defines + define .svh（对齐 hdxml --define-headers）
  incdir、RtlIndex 输出目录等

边界
  toml = 工程配置（喂 hdxml / 校验 definesFp）
  HTML = 连接 SoT（禁止把连线写进 toml）
  不是旧 stune mods_info.toml 缓存的回归

衔接 elaboration
  toml 固定宏与 filelist → RtlIndex
  → 顶→底推 aw-param → 底→顶连线（见 help connect / docs/connect-html.md）
`,

  connect: `\
HTML 方言（连接 SoT）— 草稿

完整约束与示例（后续实现必须遵守，先不要当已落地）：
  docs/connect-html.md
  docs/examples/connect/
  docs/workspace-toml.md   （.f / 宏；与连接衔接）

两层，不要混
  作者 HTML（源）     模块名 + 可选参数；例化 / 连线 / param 的模板
  渲染后活 DOM（结果） 具体 instance、连线、导出端口（生成物）
                       类似 elaborated XML：生成的 port、生成的实例

打印机 / dump / golden 只认渲染后 DOM，不认源文件原文。
静态规则对齐 emacs Verilog-mode 心智（rewrite 捕获、@、[]、AUTO 子集），
不对齐 emacs 进程。属性名未冻结；改 docs/connect-html.md 时同步本段。

作者标签
  aw-mod / aw-param / aw-inst / aw-connect / aw-rewrite
  嵌套 aw-mod = 层次；aw-inst@id 在父路径下唯一
  <script type="module">：clone 模板、改 id；只用 DOM / aw.*

Elaboration（引擎顺序，语义冻结）
  ① 顶 → 底：绑定/求值 aw-param（expr → value）
  ② 底 → 顶：叶子端口表展开 rewrite → aw-connect，再推导导出 aw-port
  宏（toml/.svh）≠ 模块 param；先固定宏再推 param
  连接顶不必是全芯片 RTL top；子树内部仍按上述顺序

渲染后（dump 输入）
  保留 aw-mod / aw-inst；rewrite 落成逐条 aw-connect
  生成 aw-port（导出）；模板 clone 生成具体实例
  详见 docs/examples/connect/*-rendered-*.html
`,

  web: `\
autowire web（前期主入口，尚未落地）

  autowire web [html]

本机起 HTTP，给人用有头浏览器，给 Agent 用无头。
全程无头 Chromium 打开 web 的 URL，首屏完成后再让 Agent 介入。

Agent 只用 Playwright MCP（navigate / snapshot / evaluate / click），
和调普通前端一样。不要为连接层加 outline / apply / rewrite MCP。

启动可以是：先 web，再挂 Playwright MCP；或一条脚本两个都拉起。
隔离：独立浏览器上下文，只打本机页。
安全：渲染在浏览器里；写文件只经 autowire API。
`,

  dump: `\
写回

浏览器不碰磁盘。页面或 Playwright 把「渲染后活 DOM」POST 到同源 /api/dump
（具体 instance / aw-connect / 导出 aw-port，不是作者源 HTML）。
autowire 校验工作区路径后写 RTL。对错由 DV 测文件，不靠禁止 dump。

web 与将来的 cli 必须走同一套写盘代码。
未落地前不要手写「假装 dump」的旁路脚本当正式路径。
`,

  cli: `\
autowire cli（后期，禁止现在做）

  autowire cli phy.html --dump gen/

等 Web / Playwright 测试和 golden 稳定，再做完全无头 CLI。
同一套 aw.js 抽取逻辑（进程内或无头浏览器）。

用例约束后端：cli 必须通过现有 Web 测试（同一 HTML → 同一 RTL）。
先做 cli、再补测试，不允许。

deps 等 RtlIndex 查询可挂在 cli 上，与连接渲染分开。
`,

  deps: `\
autowire deps — RTL 模块依赖树（已落地）

  bun index.ts deps <path>
  bun index.ts deps <path> --top <name> --depth <n>
  bun index.ts deps <rtl-dir> -I <incdir> --hdxml <bin>

<path>
  RtlIndex 目录（含 index.xml）直接读
  否则当作 RTL 源码目录，调 hdxml sidecar 分析到 tmp/rtlindex

hdxml 查找顺序
  --hdxml > $HDXML_BIN > 仓库 hdxml/target/{release,debug}/hdxml > PATH

输出
  摘要行：tool / files / modules / tops；错误文件标红
  每顶层一棵树：顶层青、普通绿、blackbox 黄、环红

连接页只读端口表，不在 deps 里改 RTL。
`,

  dont: `\
禁止

  XML / 一层一份连接文件当 SoT
  连接专用 MCP（outline、apply、rewrite …）
  mcp / run / repl 当主入口
  浏览器直接写工作区
  先做 cli 再补 Web 用例
  两套连线语义（Web 与 cli 必须同一 aw.js + 同一 golden）
  为每个芯片项目复制一份连接提示词（改本 help）
  把 README 写成第二套约定却不改 help
  在 hdxml/docs/ 再放文档（统一 docs/）
  把连接关系写进 autowire.toml（toml 只做工程配置）
`,
};

function topicsIndex(): string {
  return [
    "autowire help [topic]",
    "",
    "  agent     接手说明（默认；无 topic 时打印全文）",
    "  status    已落地 / 未落地",
    "  workspace 顶层 autowire.toml（.f / 宏）",
    "  connect   HTML 方言（作者模板 vs 渲染结果）",
    "  web       本机页 + Playwright",
    "  dump      写回 RTL",
    "  cli       后期无头（先测后做）",
    "  deps      RtlIndex 依赖树",
    "  dont      禁止事项",
    "",
  ].join("\n");
}

export function renderHelp(topic?: string): string {
  if (topic === "topics") return topicsIndex();
  if (!topic) {
    return HELP_TOPICS.map((t) => SECTIONS[t].trimEnd()).join("\n\n");
  }
  if ((HELP_TOPICS as readonly string[]).includes(topic)) {
    return SECTIONS[topic as HelpTopic].trimEnd() + "\n";
  }
  throw new Error(`未知 help topic: ${topic}\n\n${topicsIndex()}`);
}
