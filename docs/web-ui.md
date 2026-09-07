# Web 界面与 GET 动作 API（`autowire web`）

> 状态：草稿，未实现。本文约束页面布局与「GET 参数 → 自动动作」契约；组件定位见 [architecture.md](./architecture.md) §2.3–2.5；校验见 `help check`，写回见 `/api/dump`（`help dump`）。
> 关键字「必须 / 应当 / 可以」按 RFC 2119。

## 1. 页面布局

```text
┌──────────────────────────────────────────────────────────┐
│ header：工作区 / HTML 名     [Render] [Check] [Dump] [Reset] │
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
- header **必须**提供人工按钮 **[Render] [Check] [Dump] [Reset]**；无 GET 时靠按钮触发（见 §2–§3）。  
- 节点 **应当**带可访问名字（connect-html.md §3.8），便于 Playwright snapshot。

## 2. 两种模式

| 打开方式 | 行为 | 面向 |
|---|---|---|
| 无 GET 动作参数 | 只加载页面与数据，**不**自动跑动作；人工点 [Render] / [Check] / [Dump] | 人工预览与手检 |
| 带 GET 动作参数 | 自动执行动作链（§3），完成后落状态（§4） | Agent（Playwright 无头） |

## 3. 三个页面动作 + 前置依赖 + GET 识别

页面上 **Render / Check / Dump** 是**三个并列动作**（外加 Reset / `select`）。按钮与 GET **必须**共用同一套 action 实现。

### 3.1 前置依赖（按钮与 GET 相同）

| 动作 | 作用面 | 前置 | 未满足时 |
|---|---|---|---|
| **Check** | **作者面 `aw-content` + `aw-submods` + toml deps**（**不是** `aw-render`） | 无 | 直接校验 |
| **Render** | 写出 / 刷新 `aw-render` | **必须先 Check 无 error** | **自动先跑 Check**；check 有 error 则 **中止** render，**禁止**对未通过 check 的 content 出 render |
| **Dump** | 读 **冻结的 `aw-render`** 写 RTL | **必须先有有效 render**（因而也已过 check） | **自动** `check → render`；任一步 error 则中止；另验 render 可印（无残留 template/rewrite） |

依赖链（必须写清）：

```text
Check（作者面）  ←── 无前置
   ↑
Render           ←── 依赖 Check
   ↑
Dump             ←── 依赖 Render（传递依赖 Check）
```

- [Check]：**不**依赖 Render / Dump；可只点 Check。  
- [Render]：**依赖 Check**（与「Check 不依赖 Render」同时成立，方向不可反）。  
- [Dump]：依赖 Render（及 Check）。

### 3.2 GET 参数 ↔ 按钮

| GET 参数 | 值 | 对应按钮 | 动作 |
|---|---|---|---|
| `select` | 模块名 | （右栏选中） | 选中并展示该模块 |
| `check` | `1` | [Check] | 校验 **aw-content** 方言 + deps；**不写** `.sv`；**不**隐含 render |
| `render` | `1` | [Render] | elaboration；**隐含** `check=1` |
| `dump` | `1` | [Dump] | `POST /api/dump`；**隐含** `check=1` 与 `render=1` |

**隐含示例**

| 触发 | 实际执行 |
|---|---|
| 点 [Check] / `?check=1` | **只** check（作者面） |
| 点 [Render] / `?render=1` | check → render（render **依赖** check） |
| 点 [Dump] / `?dump=1` | check → render → dump |
| `?select=MOD&check=1` | select → check（**不** render / dump） |
| `?check=1&render=1` | check → render |

- 执行顺序 **固定**为 `select → check → render → dump`（同时请求多个时），与参数书写顺序无关。  
- 三个动作 **可以**单独出现在 URL 里被识别。  
- 未知参数 **必须**忽略（向后兼容）。  
- check 有 **error** 时 **必须**中止后续 render / dump，并落 `#aw-status[data-state=error]`；**警告**（如多余 deps）不阻止 render/dump，但 **应当**出现在状态摘要里。  
- 人工点 [Check] 结束后 **应当**在页面可见处给出通过 / 警告 / 失败摘要（可与 `#aw-status` 同源）。

示例：

```text
/path/to/page?check=1
/path/to/page?render=1
/path/to/page?dump=1
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
| `/api/connect?id=` | GET | **`.autowire/connect/`** 该单元快照 | 已 elaborate 的 `aw-render`（跨单元 deps / 预览）；**不是**作者 HTML |
| `/api/check` | POST | 作者 HTML +（按需）上列只读 API | 校验 **aw-content** + deps；**不写盘** |
| `/api/dump` | POST | 活 DOM `aw-render` → 可写入 **`.autowire/connect/`** 再印 SV | 唯一 RTL 写路径 |

加载要求（与 [`workspace-toml.md`](./workspace-toml.md) §4.2 一致）：

1. 叶子端口表 **必须**来自 hdxml API；索引缺失或 `definesFp` 过期 → 需要叶子信息的动作 **报错**。  
2. 跨 `[connect.<id>]` 引用 **必须**能加载 deps 单元在 `.autowire/connect/` 的快照（或本会话刚写出的等价物）；缺失 → **报错**。  
3. **禁止**用 `/api/connect` 冒充作者 SoT；**禁止** dump 回读作者 `html=`。  
4. 前端 **禁止**直接写盘；RTL 写只经 `/api/dump`。check **禁止**写 `.sv` / `gen/`。
