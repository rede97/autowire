# Autowire v2.0

连接描述是一份 **HTML + script**。浏览器跑完 script，活 DOM 就是连接关系。把渲染结果交给 autowire，由它写成 RTL，后面走 DV。

**Agent 接手：先跑 `bun index.ts help`（或 `autowire help`）。那就是用法和思路，不要另写项目提示词。改行为时同步改 `src/help.ts`。格式约束见 [`docs/`](docs/README.md)。**

---

## 设计思想

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

## 方法论

- **先文档约束，后实现**：未在 help status 开放的步骤不实现、不假装能渲染或 dump。
- **用例约束后端**：无头 `cli` 后做，且必须通过现有 Web / Playwright 测试（同一 HTML → 同一 RTL）；先做 cli、再补测试，不允许。
- **单一事实源**：用法与思路只写 `src/help.ts`；格式与实现约束只写 `docs/`；二者同步，不为项目复制提示词。

## 流水线

```text
autowire.toml（.f + svh/宏）
    →  hdxml → RtlIndex（只读）
    →  HTML（aw-content + aw-submods）
    →  elaboration → aw-render
    →  POST /api/dump（读 aw-render）
    →  autowire 写 .sv
    →  DV
```

组件、写回、Playwright 隔离、入口阶段：[docs/architecture.md](docs/architecture.md)。
工作区配置：[docs/workspace-toml.md](docs/workspace-toml.md)。连接方言：[docs/connect-html.md](docs/connect-html.md)。细则小结：[docs/connect-rules.md](docs/connect-rules.md)。

## 不做

- 连接关系用 XML / 一层一份文件当 SoT（RtlIndex XML 是只读索引，不是连接 SoT）
- 连接专用 MCP（`outline`、`apply`、`rewrite`…）
- 浏览器直接写工作区
- 先做 cli 再补 Web 用例
- 两套连线语义（Web 与 cli 必须同一 `aw.js` + 同一 golden）
- 把连接关系写进 `autowire.toml`（toml 只做工程 / RTL 宇宙配置）
- 为每个芯片项目复制一份连接提示词（改 `src/help.ts`）
