# 生产发布包

> 状态：**目标已裁定，打包脚本尚未落地**。未出现在 `help status` 的 Landed 列表里，不要提前做安装器或把开发调试改成依赖 Lightpanda。
> 开发与 CI 仍按仓库现况：Bun、Playwright 及其 Chromium、`bun test`。本文只规定**发给用户的生产包里有什么**。
> Windows 开发环境见 [windows-msys2.md](./windows-msys2.md)，不由本包覆盖。

## 1. 三颗二进制

并排分发，各自独立进程。禁止把其中一颗编译或静态链接进另一颗。

| 二进制 | 职责 | 生产包 |
|---|---|---|
| `autowire` | CLI：`analysis` / `connect` / `plugin wishbone run`。由 `bun build --compile` 产出，happy-dom 打在里面 | 必需 |
| `hdxml` | RtlIndex sidecar（Rust） | 必需 |
| `lightpanda` | 唯一捆绑的调试浏览器。同一文件的子命令 `mcp` 与 `serve` | 调试网页时带上；生成 RTL 不需要 |

`autowire connect run` 用包内的 happy-dom 完成脚本、check、elaborate 和写 `.sv`，不启动浏览器。

## 2. 浏览器分工

| | 生产包 | 开发 / CI |
|---|---|---|
| 调试网页 | Lightpanda | Playwright + `bunx playwright install chromium` 得到的 Chromium |
| 写 RTL | happy-dom（在 `autowire` 内） | 同左 |
| 快照黄金 | 不携带 Playwright | headless Chromium；须与 happy-dom 同一份 HTML 的快照一致 |

Lightpanda 自带协议服务，生产包不再附带 Chromium、Playwright 或 chromedriver。

- `lightpanda mcp`：MCP，默认 stdio。HTTP 用 `--port`（客户端 POST `/mcp`，用 `Mcp-Session-Id` 区分会话）。
- `lightpanda serve --host 127.0.0.1 --port 9222`：CDP。外部客户端可以 `connectOverCDP`；该客户端不属于生产包。
- `lightpanda mcp --cdp-port <n>` 可在同一次进程里同时开 MCP 与 CDP。它与 `--port` 不能合用（共用一个监听端口）。
- 启动时设置 `LIGHTPANDA_DISABLE_TELEMETRY=true`。

开发机上的 `.mcp.json` 继续是 Playwright MCP。换成生产包里的 `lightpanda mcp` 属于打包落地时的事，现在不改。

## 3. 平台

- Linux x86_64、Linux aarch64、macOS。
- Linux 官方 Lightpanda 构建依赖 glibc，不覆盖 musl（如 Alpine）。
- 无原生 Windows 构建。Windows 上开发、测试、跑 demo 继续走 [windows-msys2.md](./windows-msys2.md)。

## 4. 许可证与版本

- Lightpanda 以 **AGPL-3.0** 分发。生产包附带其许可证，并提供**该次构建所对应源码**的获取方式。
- 发布物钉住一次具体构建。不用会移动的 `nightly` 标签充当版本号。

## 5. 尚未落地

- 打包脚本、版本钉、安装布局、PATH 约定。
- 把开发用 `.mcp.json` 换成生产包的 `lightpanda mcp`。
