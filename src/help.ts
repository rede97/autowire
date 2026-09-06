// Agent 接手说明。改行为时同步改这里，不要另写项目提示词。
// 打印：`bun index.ts help` 或 `autowire help [topic]`

export const HELP_TOPICS = [
  "agent",
  "status",
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
  3. 按 connect 方言写或改 HTML（即便 aw.js 还没落地，方言已定）。
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
  HTML + script
      →  浏览器 / Playwright 渲染（elaboration）
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

未落地（按此顺序做，不要跳）
  aw.js + 约束 HTML 自定义元素
  autowire web [html]       本机 HTTP，渲染页
  POST /api/dump            浏览器不写盘，autowire 写工作区 RTL
  Playwright 用例 / golden  同一 HTML → 同一 RTL
  autowire cli              完全无头；必须被上述用例锁死

并列、不堵连接
  寄存器 Table + Block/Cell（类型是数据；Excel 只出文档）
  叶子端口表从 RtlIndex 只读喂给连接页
`,

  connect: `\
HTML 方言（连接 SoT）

一份文件可嵌套多层。打印机看 script 跑完的 DOM，不是源文件原文。
静态规则对齐 emacs Verilog-mode 心智（rewrite 捕获、@、[]、AUTO 子集语义），
不对齐 emacs 进程。

标签（小写、属性加引号）
  aw-mod       一个包装 / 层次
  aw-inst      例化；id 在路径下唯一
  aw-connect   端口连接
  aw-rewrite   端口名改写
  aw-param     参数

脚本
  <script type="module"> 做复杂例化（clone、改 id）
  只用 DOM / aw.*，不要依赖 layout，不要对外 fetch

节点带可访问名字，方便 Playwright snapshot。

示例
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

浏览器不碰磁盘。页面或 Playwright 把渲染结果 POST 到同源 /api/dump。
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
`,
};

function topicsIndex(): string {
  return [
    "autowire help [topic]",
    "",
    "  agent    接手说明（默认；无 topic 时打印全文）",
    "  status   已落地 / 未落地",
    "  connect  HTML 方言",
    "  web      本机页 + Playwright",
    "  dump     写回 RTL",
    "  cli      后期无头（先测后做）",
    "  deps     RtlIndex 依赖树",
    "  dont     禁止事项",
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
