# Web 界面与 GET 动作（`autowire connect web`）

> 状态：**已实现**（`autowire connect web`；引擎 `src/core/aw.ts`（打包产物 `web/aw.js`），页面控制 `src/web/page.ts`（打包产物 `web/page.js`），服务 `src/web/server.ts`）。本文约束页面布局与「GET 参数 → 自动动作」契约。静态服务只读。写 `.sv` 是 `connect run`，不在页面。
> 关键字「必须 / 应当 / 可以」按 RFC 2119。

## 1. 页面布局

两种入口：

| URL | 用途 |
|---|---|
| `/` | 单元索引，链到 `/?unit=<id>` |
| `/?unit=<id>` | 前端。侧栏 RtlIndex / Connect；作者面两个工作区 |
| `/?ui=min` | 无头 / CDP。同一套工作区和按钮，不做树和着色 |

前端：

```text
┌──────────────────────────────────────────────────────────────┐
│ header：工作区 / 单元  [Check] [Elaborate] [Run] [Save SV] [Save HTML] [Reset] │
├──────────────┬───────────────────────────────────────────────┤
│ 侧栏         │ 作者面（三个 tab，互不覆盖）                    │
│ RtlIndex     │  Source：#aw-source 作者 HTML（含经典 script） │
│  摘要+搜索   │  Processed：#aw-live elaborate 之后的 HTML      │
│ Connect      │  RtlIndex：点侧栏模块 → 该 tab 显示模块详情     │
│  单元链接    │ 成果（两个 tab）：Rendered / SystemVerilog      │
│              │  #aw-generated；各 tab 出自己的产物或该阶段错误 │
└──────────────┴───────────────────────────────────────────────┘
```

- **Source 与 Processed 是独立工作区**，关系像 `.c` 编译成 `.o`。脚本、`on-init`、`on-template`、elaborate **只写** `#aw-live`。**禁止**把结果回写 `#aw-source`。下一次编译从当前输入重新克隆，替换 Processed，不改 Source。
- 前端页的 Source / Processed **必须**渲染成 **可折叠 / 展开的代码结构**，但 **禁止**把 `aw-*` 节点本身当作可见树：真实节点留在 `#aw-source` / `#aw-live` 里（`display:none`），旁边另建一棵视图树（`#aw-source-view` / `#aw-live-view`）。每个有子节点的元素是一个 `<details open>`，`<summary>` 一行：折叠三角与节点标题在同一行；叶子是单行。`aw-template` 内的 `aw-connect` / `aw-rewrite` / `aw-param` **必须**按列对齐：类型、内容、目标。只有真有子节点的节点才有三角，**禁止**在空节点或行尾画三角。默认 **展开**。折叠只改视图树，不改真实 DOM：Playwright 选择器（`#aw-live aw-mod`、`aw-render > aw-insts > aw-inst` 等）**必须**照旧命中。无头页（`?ui=min`）**不**做树与着色，保持纯结构。
- 侧栏 RtlIndex 模块点击后，**必须**在作者面开出与 Source / Processed **平级的第三个 tab「RtlIndex」**，自动选中并展开显示该模块详情（params / imports / ports / instances，来自 `/api/module`），内容 **应当**同样用可折叠结构呈现，与 Source / Processed 风格一致。不再整屏切到独立的 `#module-view`。RtlIndex 只读 index（见下），tab 内容 **禁止**在页面重解析 RTL。
- 字体 **优先等宽**：页面根 `font-family: ui-monospace, monospace`，Source / Processed / RtlIndex / 成果各栏与 `#aw-generated` 都沿用。
- elaborate 期间，当前单元以外的 `[data-unit]` 从文档摘掉。`document.querySelector("aw-mod")` 只能看到正在编译的单元。
- CDP **可以**改 `#aw-source` 里的作者节点和经典 `<script>` 文本。改完后 [Elaborate] 再编译。Reset 从作者文件重新装入，丢掉这些编辑。
- 侧栏 RtlIndex **必须**只读 index（`/api/rtlindex`、`/api/modules`、`/api/module`）；**禁止**在页面重解析 RTL。
- header **必须**提供 **[Check] [Elaborate] [Run] [Save SV] [Save HTML] [Reset]**；无 GET 时靠按钮触发（见 §2–§3）。**[Save SV]** 下载本次 Run 的 `.sv` 文本（与 `connect run` 写盘同一份，不含 render XML）；**[Save HTML]** 下载 Processed 作者面（`aw-render` 已剥空）。两者都走浏览器保存，**不**写工作区。Save **不**进入 §3 的 GET 动作链。
- **状态直接显示在对应动作按钮上**，不再单独显示状态条目。Check / Elaborate / Run 各自的按钮 **必须**反映自己那一步的状态：`data-state` = `idle` / `running` / `done` / `error`（页面用它上色，例如 error 红、done 绿、running 黄）。动作链 `check → elaborate → run` 连走多步时，每一步在自己的按钮上落状态。机器同步信号仍由隐藏的 `#aw-status` 承载（见 §4），人只看按钮。
- 成果栏 **必须**是两个并列 tab：**Rendered**（`aw-render` 快照树，来自本次 elaborate 或 `connect run` 写出的快照）与 **SystemVerilog**（本次 Run 印出的 `.sv` 文本）。当前选中 tab 的文本 **必须**落在 `#aw-generated`；`?run=1` 后 **默认**停在 **SystemVerilog**，即 `#aw-generated` 是 `.sv`（不含 `aw-render` 字样）。无头页只有纯文本 `#aw-generated`（`.sv`），不做 tab 与着色。Save SV 始终下载 `.sv` 字符串，不下载着色后的 HTML。
- **成果栏错误按阶段分栏**：`Check`（作者面静态检查）与 `elaborate` / render 阶段报错 → 错误文本进 **Rendered** tab（check 失败会挡住 elaborate/render，归同一栏）；`Run` 的 `.sv` 打印阶段报错 → 进 **SystemVerilog** tab。出错的 tab **应当**自动选中，另一 tab 保留上次成功的产物或空。无论进哪栏，都 **必须**照 §4 落全局 `#aw-status` / 出错按钮 / 标题。
- 节点 **应当**带可访问名字（docs/connect/html.md §3.8），便于 Playwright snapshot。
- CDP 驱动（obscura / Chromium 等讲 CDP 的浏览器通用）：[`../dev/cdp-debug.md`](../dev/cdp-debug.md)（`bun index.ts help cdp`）。

## 2. 两种模式

| 打开方式 | 行为 | 面向 |
|---|---|---|
| 无 GET 动作参数 | 只加载页面与数据，**不**自动跑动作；人工点 [Check] / [Elaborate] / [Run] | 人工预览与手检 |
| 带 GET 动作参数 | 自动执行动作链（§3），完成后落状态（§4） | Agent（Playwright 无头） |

## 3. 页面动作 + 前置依赖 + GET 识别

页面上 **Check / Elaborate / Run** 是并列动作（外加 Reset / `select`）。按钮与 GET **必须**共用同一套 action 实现。这些动作都不写工作区。

### 3.1 前置依赖（按钮与 GET 相同）

| 动作 | 作用面 | 前置 | 未满足时 |
|---|---|---|---|
| **Check** | **作者面 `aw-content` + `aw-submods` + toml deps**（**不是** `aw-render`） | 无 | 直接校验 |
| **Elaborate** | 写出 / 刷新 `aw-render` | **必须先 Check 无 error** | **自动先跑 Check**；check 有 error 则 **中止**，**禁止**对未通过 check 的 content 出 render |
| **Run** | 读 **冻结的 `aw-render`**，把源码放进 `#aw-generated` | **必须先有有效 elaborate**（因而也已过 check） | **自动** `check → elaborate`；任一步 error 则中止；另验 render 可印（无残留 template/rewrite）。**不写文件** |

`window.aw.session(step)` 给 MCP 单步用。`check` 是静态检查，无前置。`elaborate` 自己跑脚本，不要求事先 check。`before-dump` 要求本会话已 elaborate。`run` 自己走静态 check 再 elaborate。`help` 返回这段说明。

依赖链：

```text
Check（作者面）  ←── 无前置
   ↑
Elaborate        ←── 依赖 Check
   ↑
Run              ←── 依赖 Elaborate（传递依赖 Check）；只显示源码
```

### 3.2 GET 参数 ↔ 按钮

| GET 参数 | 值 | 对应按钮 | 动作 |
|---|---|---|---|
| `select` | 模块名 | （右栏选中） | 选中并展示该模块 |
| `check` | `1` | [Check] | 校验 **aw-content** 方言 + deps；**不写** `.sv`；**不**隐含 elaborate |
| `elaborate` | `1` | [Elaborate] | elaboration；**隐含** `check=1`。旧名 `render=1` 同等 |
| `run` | `1` | [Run] | 把快照放进 `#aw-generated`；**隐含** `check=1` 与 `elaborate=1`。旧名 `dump=1` 同等，但仍不写盘 |

**隐含示例**

| 触发 | 实际执行 |
|---|---|
| 点 [Check] / `?check=1` | **只** check（作者面） |
| 点 [Elaborate] / `?elaborate=1` | check → elaborate |
| 点 [Run] / `?run=1` | check → elaborate → 源码进 `#aw-generated` |
| `?select=MOD&check=1` | select → check（**不** elaborate / run） |
| `?check=1&elaborate=1` | check → elaborate |

- 执行顺序 **固定**为 `select → check → elaborate → run`（同时请求多个时），与参数书写顺序无关。  
- 未知参数 **必须**忽略（向后兼容）。  
- check 有 **error** 时 **必须**中止后续 elaborate / run，并落 `#aw-status[data-state=error]`；**警告**（如多余 deps）不阻止后续，但 **应当**出现在状态摘要里。  
- 人工点 [Check] 结束后 **应当**在页面可见处给出通过 / 警告 / 失败摘要（可与 `#aw-status` 同源）。

示例：

```text
/path/to/page?check=1
/path/to/page?elaborate=1
/path/to/page?run=1
/path/to/page?select=phy_wrap&check=1
```

## 4. 完成信号（Agent 同步）

- 状态对人 **显示在动作按钮上**（§1）：`#btn-check` / `#btn-elaborate` / `#btn-run` 各带 `data-state`（`idle` / `running` / `done` / `error`）。不再有单独可见的状态条目。
- 机器同步仍走隐藏的 `#aw-status` 节点：自动链结束 **必须**写 `data-state="done"` 或 `data-state="error"`，文本为摘要（error 时含第一条错误）；`document.title` 同步追加 `[done]` / `[error]`。该节点视觉隐藏但 **必须**留在 DOM 里，供 Playwright 等待。
- 错误文本除了进 `#aw-status` 与出错那步的按钮，还 **必须**按 §1 的阶段分栏进对应的成果 tab（render 阶段 → Rendered，`.sv` 打印阶段 → SystemVerilog），并自动选中出错的 tab。
- Playwright 介入点：无参 = 首屏渲染完成；带参 = 等 `#aw-status[data-state]` 出现。
- 无 GET 参数时 `#aw-status` 保持 `data-state="idle"`，按钮也都是 `idle`。

## 5. 数据接口与 `.autowire` 加载

浏览器 **禁止**直接读工作区文件。两类生成 XML **必须**经同源 API，服务端分别从固定目录加载：

| 端点 | 方法 | 磁盘来源 | 内容 |
|---|---|---|---|
| `/api/rtlindex` | GET | **`.autowire/hdxml/`** `index.xml` | files / modules / packages / errorFiles、definesFp、hierarchy |
| `/api/modules` | GET | **`.autowire/hdxml/`** `index.xml` | 模块与 package 名字列表（侧栏搜索） |
| `/api/module?name=` | GET | **`.autowire/hdxml/`** 对应模块文件 XML | params / imports / ports / instances（叶子事实） |
| `/api/connect?id=` | GET | **`.autowire/connect/`** 该单元快照 | 已由 `connect run` 写出的 `aw-render`（跨单元 deps / 预览）；**不是**作者 HTML |
| `/api/units` | GET | `autowire.toml` | 单元列表、deps、默认单元 |
| `/api/author?id=` | GET | 作者 `html=` | 作者 HTML 原文 |
| `/api/hook-script` | POST | 进程内存 | 把钩子脚本文本换成一次性 URL（obscura 拒绝 `data:` 模块）。**不**写工作区 |
| `/api/hook-script/<id>.js` | GET | 同上 | 该次编译要执行的模块脚本 |

加载要求（与 [`toml.md`](./toml.md) §4.2 一致）：

1. 叶子端口表 **必须**来自 hdxml API；索引缺失或 `definesFp` 过期 → 需要叶子信息的动作 **报错**。  
2. 跨 `[connect.<id>]` 引用 **必须**能加载 deps 单元在 `.autowire/connect/` 的快照（或本会话刚 elaborate 的等价物）；缺失 → **报错**。  
3. **禁止**用 `/api/connect` 冒充作者 SoT。  
4. 前端和这些 GET **禁止**写盘。`.sv` 只由 `connect run` 写，或由 MCP 保存 `#aw-generated`。check **禁止**写 `.sv` / `gen/`。没有 `POST /api/dump`、`POST /api/save`、`POST /api/check`。`POST /api/hook-script` 只在内存里放本次编译的脚本，响应后由浏览器用 GET 取回。
