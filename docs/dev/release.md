# 生产发布包

> 状态：**hdxml 与单文件 `autowire.js` 自 0.9.1 起由主干 GitHub Actions 发布**。obscura、安装器、Linux aarch64 与编译版 `autowire` 仍不做。开发与 CI 继续用 Bun 跑 `index.ts`，调试浏览器仍是 Playwright Chromium。
> 开发与 CI 仍按仓库现况：Bun、Playwright 及其 Chromium、`bun test`。本文只规定**发给用户的生产包里有什么**。
> Windows 开发环境见 [windows-msys2.md](./windows-msys2.md)，不由本包覆盖。

## 1. 三颗二进制

并排分发，各自独立进程。禁止把其中一颗编译或静态链接进另一颗。

| 二进制 | 职责 | 生产包 |
|---|---|---|
| `autowire` 或 `autowire.js` | CLI：`analysis` / `connect` / `plugin wishbone run`。两种产物见 §1.1，能力相同 | 二选一，必需 |
| `hdxml` | RtlIndex sidecar（Rust） | 必需 |
| `obscura` | 生产包唯一的调试浏览器（CDP 协议，CentOS 7 兼容构建）。同一文件的子命令 `mcp` 与 `serve` | 调试网页时带上；生成 RTL 不需要 |

`autowire connect run` 用包内的 happy-dom 完成脚本、check、elaborate 和写 `.sv`，不启动浏览器。

### 1.1 autowire 的两种产物

开发与测试用仓库里的 `bun index.ts`。生产环境不发 TypeScript 源码，也不要求用户安装 `node_modules`。`bun run build:bin` 打出两个等价入口，前端源码已经打进同一个文件：

| 产物 | 是什么 | 怎么跑 |
|---|---|---|
| `out/autowire.js` | 单个脚本。`bun build index.ts --target bun`，依赖和 `out/web/aw.js`、`out/web/page.js` 都打进去 | 本机已有 Bun 时：`bun out/autowire.js help` |
| `out/autowire` | 同上，再用 `bun build --compile` 把 Bun 运行时链进可执行文件 | 直接执行。Windows 上是 `autowire.exe` |

两条命令都先跑 `build:web`，再把仓库的 `docs/` 和 `demo/` 的可运行源文件 zstd 压缩后嵌进同一个文件。页面脚本不会留在包外单独分发，文档和示例也不会。禁止让生产入口再去读仓库里的 `index.ts`、`src/` 或 `web/*.js`。hdxml 与 obscura 仍是旁边的独立进程，不链进这两个文件。

打包跳过本地构建产物（`.autowire/`、固件 `build/`、Verilator `obj_dir*`、`vcs/work/`）、git 元数据（`.git` 指针、`.github`）与导出物（`*.xlsx`、`ucli.key`、`~$*`）。`demo/*/ip/` 只打该 demo 的 `.f` filelist 引用到的源文件；`demo/*/patches/` 的补丁在打包时已应用；demo `sot/*.ts` 的 DSL 导入被改写到 `.autowire/dsl/`（独立树没有 `src/`）。解包后的 demo 可直接跑 `analysis run` → `plugin wishbone run` → `connect run` 全链路（包里已带 `rtl/gen`）。若 filelist 点名的生成物还不在盘上，`analysis run` 会指出先跑 `plugin wishbone run` 或 `connect run`。`*.sh` 解包后保持可执行。Agent 要读契约或示例时：

```text
autowire docs unpack <dir>
```

解出 `<dir>/docs/` 和 `<dir>/demo/`。同名文件会被覆盖。开发时这条命令读的是仓库本身，不读包内压缩块。帮助是 `help docs`。

开发与 CI 的帮助入口是 `bun index.ts help`。生产包里把同一组子命令交给 `autowire` 或 `bun autowire.js`。不要在生产文档里教用户跑 `index.ts`。

## 2. 浏览器分工

| | 生产包 | 开发 / CI |
|---|---|---|
| 调试网页 | obscura（CDP） | Playwright + `bunx playwright install chromium` 得到的 Chromium |
| 写 RTL | happy-dom（在 `autowire` 内） | 同左 |
| 快照黄金 | 不携带 Playwright | headless Chromium；须与 happy-dom 同一份 HTML 的快照一致 |

obscura 自带协议服务，生产包不再附带 Chromium、Playwright 或 chromedriver。

- `obscura mcp`：MCP，默认 stdio。
- `obscura serve --port 9222 --allow-private-network`：CDP（回环访问必须 `--allow-private-network`）。外部客户端可以 `connectOverCDP`；该客户端不属于生产包。
- obscura 面向 CentOS 7（glibc 2.17）兼容构建，官方 Lightpanda 构建因 glibc 要求过高已从支持列表移除。

开发机上的 `.mcp.json` 继续是 Playwright MCP。换成生产包里的 `obscura mcp` 属于打包落地时的事，现在不改。

## 3. 平台

- Linux x86_64、Linux aarch64、macOS、Windows x64（仅 hdxml；`hdxml.exe`）。
- obscura 以 CentOS 7（glibc 2.17）为基线，覆盖老发行版；musl（如 Alpine）不在支持列表。
- autowire 与 obscura 无原生 Windows 构建。Windows 上开发、测试、跑 demo 继续走 [windows-msys2.md](./windows-msys2.md)；发布的 `hdxml.exe` 可直接用。

## 4. 许可证与版本

- obscura 的许可证以其构建来源为准，生产包附带对应许可证文本。
- 发布物钉住一次具体构建。不用会移动的 `nightly` 标签充当版本号。

## 5. 发布（0.9.1 起）

- 触发：推送 `main` 只跑检查与构建（不发布）。**只有推送 `v*` tag 才发布**；tag 由人创建并推送，CI 永不创建/移动/重建 tag，已存在的 release 直接拒发。
- 版本与 Release 说明取 `CHANGELOG.md` 最上面一条 `## [x.y.z]`；`package.json` 的 `version` 必须一致（`scripts/check-version.ts` 把关），且 tag 名必须等于 `v<版本>` 否则发布失败。hdxml 用自己的版本（`hdxml/Cargo.toml`），不受 autowire 版本约束。
- 产物：`autowire.js`（单文件 Bun 脚本，内嵌版本/提交/构建时间）、`hdxml-linux-x64.tar.xz`（Ubuntu 22.04 跑 `hdxml/dist.sh`，glibc 2.17）、`hdxml-macos-arm64.tar.xz`、`hdxml-macos-x64.tar.xz`、`hdxml-windows-x64.zip`。
- 发布流程：改 `CHANGELOG.md` + `package.json` → 推 `main`（CI 只验证）→ 人工 `git tag v<x.y.z> && git push origin v<x.y.z>` → CI 发布。
- `doc-pack.generated.ts` 每次构建由 `scripts/pack-docs.ts` 重新生成，不入库；文档包含仓库根目录 `AGENTS.md`。

## 6. 暂时不做

这个阶段不实现：

- obscura 二进制、安装布局、PATH 约定、Linux aarch64、编译版 `out/autowire`。
- 把开发用 `.mcp.json` 换成生产包的 `obscura mcp`。

有新的发布需求再打开。
