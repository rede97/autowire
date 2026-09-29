# CDP 调试范式（无头浏览器驱动 connect 页面）

> 状态：已验证（2026-09-28，obscura 0.2.3 / VCS 工作流联调）。  
> 辅助函数集：[`scripts/cdp-helper.ts`](../../../scripts/cdp-helper.ts)。  
> 相关：[`../workspace/web-ui.md`](../workspace/web-ui.md)（页面契约）、[`../architecture.md`](../architecture.md) §3（工具与 MCP 的边界）。

任何讲 CDP 协议的无头浏览器都可以驱动 `connect web` 页面：Playwright Chromium、obscura。手段统一为 **Playwright `chromium.connectOverCDP`**——Playwright 只做 CDP 客户端，不启动自己的浏览器。

## 1. 最小链路

```bash
# 终端 1：CDP 端点（obscura 例；本机回环必须 --allow-private-network）
obscura_c7 serve --port 9222 --allow-private-network
# 终端 2：页面会话（静态，不写工作区）
bun index.ts connect web soc_top --port 4173   # 在 demo/soc 下
```

```typescript
import { connectCdp, openPage, runSession, authorFaceText } from "../scripts/cdp-helper.ts";

const { browser, page } = await connectCdp("http://127.0.0.1:9222");
await openPage(page, "http://127.0.0.1:4173/?ui=min");
const sv = await runSession(page);      // 全链，返回 .sv 文本（= connect run 写盘内容）
const html = await authorFaceText(page); // 活作者面（aw-render 已剥空）
await browser.close();
```

## 2. 页面会话 = 调试界面

`window.aw.session(step)` 逐步推进：`check → elaborate → before-dump → run`；`save-sv` / `save-html` 各给一份下载文本（语义见 web-ui.md）。无头打开 `/?ui=min`（前端是 `/?unit=<id>`）。

输入和产物是两条工作区，不是就地覆盖：

- `#aw-source`：作者 HTML，含经典 `<script>`。CDP 直接改这些节点和脚本文本。
- `#aw-live`：编译结果（脚本 / `on-init` / `on-template` / elaborate）。下次 elaborate 会整段换掉它。

改输入后调用 `elaborate` 再编译。钩子不会写回 `#aw-source`。`save-html` 下载的是 Processed 作者面（`aw-render` 已剥空）。

elaborate 期间，别的 `[data-unit]` 会摘掉。`document.querySelector("aw-mod")` 只看到当前单元。

## 3. 轻量浏览器的坑（obscura 实测）

| 现象 | 规避 |
|---|---|
| 无页面生命周期事件：`setContent` / `addScriptTag` 挂死 | 只用 `goto(url, { waitUntil: "domcontentloaded" })`；脚本注入改为页内 `await import("/aw.js")` |
| `blob:` / `data:` URL 被禁 | 同上，模块从服务器 http 路径加载 |
| 点击下载链接触发导航，evaluate 上下文销毁 | 只取文本时先存根 `HTMLAnchorElement.prototype.click = () => {}` |
| `text/xml` 的 DOMParser 可能套 HTML 骨架、`tagName` 大写 | 解析用 `querySelector` + `localName`（`src/core/printer.ts` `parseSnapshot` 已按此写） |
| 回环/内网地址默认被 SSRF 防护拦截 | 启动加 `--allow-private-network` |
| 内联 `type="module"` 被改写成 `data:` 后拒绝加载 | 作者脚本必须是经典 `<script>`，由页面直接执行。`src` 走 `/raw/`。索引页用普通 script |
| 坐标点击打在自定义元素上，按钮的 `getBoundingClientRect` 与命中不一致 | 无头页用 `element.click()` 或 `window.aw.session`，不要用坐标点击 |

## 4. 测试的浏览器回退

`test/` 与 CI 不再钉死 Chromium：`scripts/cdp-helper.ts` 的 `launchBrowser()` 先尝试 `chromium.launch()`（已安装的平台直接用），失败后自动 spawn `obscura_c7 serve`（`OBSCURA_BIN` 或 `~/.local/bin/obscura_c7`）并 CDP 挂上；也可用 `AW_CDP_ENDPOINT` 指向已在跑的端点。两者都没有则报错并写明安装/环境变量指引。`test/happydom.test.ts` 的快照等价测试与 `test/e2e-web.test.ts` 都走这一层。

## 5. 等价性基线

页面与 CLI 的字节一致性是可验证的：引擎快照（`serializeSnapshot`）在 happy-dom 与 obscura 下逐字节一致；`.sv` 亦然（`connect run` 产物 vs 页面 Run 视图）。connect sidecar 的端口顺序是语义键（`writeRender` 按它给 connect 排序），格式必须保序——不要复用 Bun.XML「按标签分组」的读法（会把 input/output 重排）。
