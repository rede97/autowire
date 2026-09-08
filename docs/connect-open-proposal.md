# 提案：显式悬空端口（`type="open"`）

> 状态：**提案，待评审**。评审通过后并入 `connect-html.md` §3.5.3 邻节 + `connect-rules.md`，再动代码。
> 关联：[`connect-const-proposal.md`](./connect-const-proposal.md)（常量连线，`type` 属性同源扩展）。

## 1. 问题

叶子/包装模的端口**未被任何规则提及**时，现状是静默省略（printer 不生成该 pin 连接）：

- 作者无法区分「忘了连」与「故意不连」；
- EDA 对省略 pin 报 PINMISSING 类告警，无法压制；
- output 悬空在 SV 里写成 `.q_o()`（显式 open）才是自文档化且无告警的形态。

## 2. 方案：`type` 三态 `net | const | open`

`type` 属性（常量连线已裁定引入的可选断言）扩展第三态：

```html
<aw-connect port="q_o" type="open"></aw-connect>          <!-- 显式悬空，无 to -->
<aw-rewrite match="^dbg_" type="open"></aw-rewrite>       <!-- 批量悬空：命中的端口全部 open -->
```

### 2.1 规则

| 面 | 规则 |
|---|---|
| 写法 | `aw-connect` / `aw-rewrite` 带 `type="open"`；**禁止**同时写 `to` / `part` / 维度属性 / `nettype` |
| 推断 | 无 `to` 且 `type` 缺省 → 报错「缺 `to`（或显式 `type="open"`）」——**open 必须显式**，防止漏写 `to` 被当悬空 |
| 方向 | open 只允许 **output** / **inout**；input 悬空 → 报错并提示改用常量绑死（`connect-const-proposal` §2.5 能力边界同原则） |
| `aw-signals` | open 不建网、不参与维度/导出（与常量一致） |
| render 表示 | `<aw-connect port="q_o" type="open">`（无 `to`）——golden 里可见的意图记录 |
| dump 打印 | `.q_o()`（空连接，SV 合法、PINMISSING 静音） |
| rewrite | `match` 命中的端口全部 open；`to` 禁写（无捕获语义问题——没有替换文本） |

### 2.2 未提及端口（ omission ）的辅助告警

与 open 配套：elaborate 时，目标模块端口中**未被任何规则覆盖**的（既未连线、也未常量、也未 open）产生 **warning**（不阻止），文案列出 `inst.port`。让「忘了连」在 check/render 摘要里可见，而 open 是消警的显式手段。

- 警告而非报错：大量遗留 IP 端口常态不接，报错会逼作者写一堆 open。
- 首版即可做（端口表在引擎手里，diff 一下即可）。

## 3. 备选（不推荐）

**B. 空 `to` / 魔法值**（`to=""`、`to="open"`）：魔法字符串，check 难写，golden 不可读。  
**C. 新标签 `<aw-dangle port=…>`**：又多一个标签；与 template 覆盖机制要再对一套（`type` 属性复用现有覆盖语义：同端口后写覆盖，open 可被后续 net/const 规则覆盖回来，反之亦然）。

## 4. 影响面（实施清单）

| 处 | 改动 |
|---|---|
| `web/aw.js` | check：`type="open"` 合法性（无 `to`/维度/`part`）、方向检查；elaborate：open 规则入库（覆盖语义同 net/const）、wires 跳过、render 落 `type="open"`；未覆盖端口 warning |
| `src/printer.ts` | `type="open"` → `.port()` 空连接 |
| 测试 | open 正例（output 悬空、批量 rewrite open）、负例（input open、open+to、缺 to 且无 type）、覆盖往返（open 被后续 net 覆盖）、未覆盖端口 warning |
| demo | `phy_wrap` 的 `overflow_o` 改显式 open（真实闭合，消 PINMISSING 类验证） |
| docs | connect-html 3.5.4 / connect-rules §5 / 本提案转约束 / 覆盖报告 |

## 5. 开放项（评审裁定）

1. input 悬空是报错还是警告？（建议**报错**：input 悬空几乎总是 bug；常量绑死已有正式路径）  
2. 未提及端口 warning 是否纳入首版？（建议纳入）  
3. inout 允许 open 还是仅 output？（建议允许 inout；SV 合法）
