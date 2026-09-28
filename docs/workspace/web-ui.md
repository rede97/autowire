# Web 界面与 GET 动作（`autowire connect web`）

> 状态：**已实现**（`autowire connect web`；引擎 `src/core/aw.ts`（打包产物 `web/aw.js`），页面控制 `src/web/page.ts`（打包产物 `web/page.js`），服务 `src/web/server.ts`）。本文约束页面布局与「GET 参数 → 自动动作」契约。静态服务只读。写 `.sv` 是 `connect run`，不在页面。
> 关键字「必须 / 应当 / 可以」按 RFC 2119。

## 1. 页面布局

```text
┌──────────────────────────────────────────────────────────┐
│ header：工作区 / HTML 名  [Check] [Elaborate] [Run] [Save SV] [Save HTML] [Reset] │
├────────────────────┬─────────────────────────────────────┤
│ 左栏               │ 右栏                                │
│ · dep tree         │ 选中模块信息（人工预览，只读）：      │
│   （RtlIndex       │   params / imports / ports /        │
│    hierarchy 展开，│   instances（来自 RtlIndex 文件 XML）│
│    黑盒标注）      │   render 后追加：该 aw-mod 的        │
│ · DB 摘要          │   aw-render 预览                    │
│   files / modules /│                                     │
│   packages /       │                                     │
│   errorFiles /     │                                     │
│   definesFp        │                                     │
└────────────────────┴─────────────────────────────────────┘
```

- 左栏数据 **必须**只读 RtlIndex（index.xml 摘要 + 各文件 XML）；**禁止**在页面重解析 RTL。
- 右栏默认展示 RtlIndex 事实；`aw-render` 预览只在 render 之后存在。
- header **必须**提供人工按钮 **[Check] [Elaborate] [Run] [Save SV] [Save HTML] [Reset]**；无 GET 时靠按钮触发（见 §2–§3）。**[Save SV]** 下载 `#aw-generated` 里可见的 `.sv` 文本（与 `connect run` 写盘同一份，不含 render XML）；**[Save HTML]** 下载当前单元活作者面（`aw-render` 已剥空）——agent 调试改完作者面后取中间成果用。两者都走浏览器保存，**不**向 autowire 提交路径，**不**写作者 HTML。Save **不**进入 §3 的 GET 动作链。
- 生成源码 **必须**出现在 `#aw-generated`，供人阅读，也供浏览器驱动打印。MCP 读这块文本再自己落盘。
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

`window.aw.session(step)` 给 MCP 单步用，比按钮更严：`check` 要求本会话已跑 `before-instances`；`elaborate` 要求本会话 check 无 error；`before-dump` 要求本会话已 elaborate。`run` 自己走完整条链，不要求事先单步。`help` 返回这段说明。

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

- 自动链结束 **必须**写 `#aw-status` 节点：`data-state="done"` 或 `data-state="error"`，文本为摘要（error 时含第一条错误）；`document.title` 同步追加 `[done]` / `[error]`。
- Playwright 介入点：无参 = 首屏渲染完成；带参 = 等 `#aw-status[data-state]` 出现。
- 无 GET 参数时 `#aw-status` 保持 `data-state="idle"`。

## 5. 数据接口与 `.autowire` 加载

浏览器 **禁止**直接读工作区文件。两类生成 XML **必须**经同源 API，服务端分别从固定目录加载：

| 端点 | 方法 | 磁盘来源 | 内容 |
|---|---|---|---|
| `/api/rtlindex` | GET | **`.autowire/hdxml/`** `index.xml` | files / modules / packages / errorFiles、definesFp、hierarchy |
| `/api/module?name=` | GET | **`.autowire/hdxml/`** 对应模块文件 XML | params / imports / ports / instances（叶子事实） |
| `/api/connect?id=` | GET | **`.autowire/connect/`** 该单元快照 | 已由 `connect run` 写出的 `aw-render`（跨单元 deps / 预览）；**不是**作者 HTML |
| `/api/units` | GET | `autowire.toml` | 单元列表、deps、默认单元 |
| `/api/author?id=` | GET | 作者 `html=` | 作者 HTML 原文 |

加载要求（与 [`toml.md`](./toml.md) §4.2 一致）：

1. 叶子端口表 **必须**来自 hdxml API；索引缺失或 `definesFp` 过期 → 需要叶子信息的动作 **报错**。  
2. 跨 `[connect.<id>]` 引用 **必须**能加载 deps 单元在 `.autowire/connect/` 的快照（或本会话刚 elaborate 的等价物）；缺失 → **报错**。  
3. **禁止**用 `/api/connect` 冒充作者 SoT。  
4. 前端和这些 GET **禁止**写盘。`.sv` 只由 `connect run` 写，或由 MCP 保存 `#aw-generated`。check **禁止**写 `.sv` / `gen/`。没有 `POST /api/dump`、`POST /api/save`、`POST /api/check`。
