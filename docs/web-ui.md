# Web 界面与 GET 动作 API（`autowire web`）

> 状态：草稿，未实现。本文约束页面布局与「GET 参数 → 自动动作」契约；组件定位见 [architecture.md](./architecture.md) §2.3，写回见 `/api/dump`（`help dump`）。
> 关键字「必须 / 应当 / 可以」按 RFC 2119。

## 1. 页面布局

```text
┌──────────────────────────────────────────────────────────┐
│ header：工作区 / HTML 名              [Render] [Dump] [Reset] │
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
- 节点 **应当**带可访问名字（connect-html.md §3.8），便于 Playwright snapshot。

## 2. 两种模式

| 打开方式 | 行为 | 面向 |
|---|---|---|
| 无 GET 参数 | 只加载页面与数据，**不执行任何 action**；render / dump 只能点按钮 | 人工预览 |
| 带 GET 参数 | 自动执行动作链（§3），完成后落状态（§4） | Agent（Playwright 无头） |

## 3. GET 参数与动作链

| 参数 | 值 | 动作 |
|---|---|---|
| `select` | 模块名 | 右栏选中并展示该模块 |
| `render` | `1` | 全量 elaboration（`aw-content` → `aw-render`） |
| `dump` | `1` | render 完成后 `POST /api/dump`；**隐含** `render=1` |

- 执行顺序 **固定**为 `select → render → dump`，与参数书写顺序无关（与流水线同向）。
- 未知参数 **必须**忽略（向后兼容：新增参数不破坏旧链接）。
- 无 GET 参数时等价于全不执行；按钮与 GET 走**同一条** action 实现，不允许两套逻辑。

## 4. 完成信号（Agent 同步）

- 自动链结束 **必须**写 `#aw-status` 节点：`data-state="done"` 或 `data-state="error"`，文本为摘要（error 时含第一条错误）；`document.title` 同步追加 `[done]` / `[error]`。
- Playwright 介入点：无参 = 首屏渲染完成；带参 = 等 `#aw-status[data-state]` 出现。
- 无 GET 参数时 `#aw-status` 保持 `data-state="idle"`。

## 5. 数据接口

| 端点 | 方法 | 内容 |
|---|---|---|
| `/api/rtlindex` | GET | index.xml 摘要：files / modules / packages / errorFiles、definesFp、hierarchy（dep tree 数据源） |
| `/api/module?name=<模块>` | GET | 单模块文件 XML 内容（params / imports / ports / instances） |
| `/api/dump` | POST | 唯一写路径：序列化各 `aw-mod` 的 `aw-render`（`help dump`） |

前端 **禁止**直接写盘；所有写只经 `/api/dump`。
