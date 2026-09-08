# Web 部分实现：功能覆盖报告与设计修改意见

> 日期：2026-09-08。范围：`aw.js` 引擎、`autowire web` / `autowire check`、`POST /api/check` / `POST /api/dump`、Playwright 用例与 golden、demo（`connect/phy_wrap*.html`，基于 common_cells 测试材料）。

## 1. 落地组件

| 组件 | 文件 | 说明 |
|---|---|---|
| elaboration 引擎 | `web/aw.js` | check + elaborate + 生命周期钩子 + 快照序列化；浏览器与 linkedom 同码运行 |
| 页面控制器 | `web/page.js` | 布局（web-ui.md §1）、按钮与 GET 共用动作链、`#aw-status` 完成信号 |
| Web 服务 | `src/web.ts` | 127.0.0.1 绑定；`/api/units|rtlindex|module|author|connect|check|dump` |
| 单元加载/跨单元 | `src/connect.ts` | 作者 HTML 加载、deps 快照解析、引擎 ctx 构建 |
| 叶子端口表 | `src/leaf.ts` | RtlIndex 只读消费（`docs/hdxml/rtlindex-xml.md`） |
| SV 打印机 | `src/printer.ts` | `aw-render` 快照 → `.sv`；dump 门禁（拒绝残留 template/rewrite） |
| CLI 接线 | `index.ts` | `autowire web [unit]`、`autowire check [unit]` |
| 测试 | `src/aw.test.ts`（17）、`src/printer.test.ts`（4）、`src/examples.test.ts`（3）、`src/e2e-web.test.ts`（7，Playwright 无头 Chromium） | 48 用例全绿 |

## 2. Demo 案例（`autowire.toml` 既有 `[connect.phy_wrap]` / `[connect.phy_wrap_tb]`）

| 单元 | 内容 | 覆盖点 |
|---|---|---|
| `connect/phy_wrap.html` | 两个 `cc_counter` 切片 + 嵌套 `gray_pair`（`cc_binary_to_gray`/`cc_gray_to_binary`）+ 兄弟 `gray_tap`（deps=gray_pair）+ 钩子生成 `cc_onehot_to_bin` | 模板复用/overwrite、`$1` 捕获 + `${idx}`、共享总线 width+part、`packed=auto`、嵌套 submods、兄弟 deps、`before-instances`/`on-template` |
| `connect/phy_wrap_tb.html` | 跨单元例化 `phy_wrap` 包装模 + `cc_lfsr` | 跨单元快照引用、包装模参数 override（非折叠表达式 `TB_W/2`）、`before-dump` 只读钩子 |

产物：`gen/{phy_wrap,phy_wrap_tb,gray_pair,gray_tap}.sv`；快照 `.autowire/connect/{phy_wrap,phy_wrap_tb}.html`；golden 锁定于 `test/golden/`。

## 3. 功能覆盖矩阵

| 特性（契约条款） | 覆盖 | 验证 |
|---|---|---|
| `<autowire>` 唯一根 / 骨架分组 | ✅ | aw.test（结构检查）+ demo |
| `aw-template` 具名/匿名/`base` overwrite/多模板后写覆盖 | ✅ | aw.test + examples.test(03) + demo |
| `aw-template@inst_name` 默认 `${id}` / `${id}_${idx}` | ✅ | aw.test + demo（`u_cnt_0/1`） |
| `aw-rewrite` RegExp + `$1`/`$<name>` + 变量 | ✅ | demo + examples.test |
| 捕获仅限 `aw-rewrite@to`；`to` 禁 `[]` | ✅ | aw.test 负例 |
| `packed/width/unpacked/part/nettype`；width=一维简写；冲突报错 | ✅ | aw.test + examples.test(04) + demo |
| `packed=auto` 跟叶子端口（含 §7.4 参数改写 `Mod__Inst__Param`） | ✅ | aw.test + demo（`phy_wrap__u_cnt_0__Width`） |
| `part` 常量求值（`8*${idx}+7` → `15:8`） | ✅ | aw.test + demo |
| 多维 packed / unpacked | ✅ | examples.test(04)（common_cells 无多维叶子，见 §5 缺口） |
| 参数折叠 §7.2（修正后，见 §4-C） | ✅ | aw.test 四形态 + demo（`CNT_W` 不折叠 / `LfsrWidth=16` 折叠 / `TB_W/2` 表达式不折叠） |
| 内部 localparam 链 | ✅ | demo（`GRAY_W=CNT_W`） |
| 同名信号维度冲突（常量折叠后语义比较） | ✅ | aw.test 负例 + demo（`pair_mid` 双侧 uniquify 名不同但同值不误报） |
| 自动导出端口（仅 input 网→input；含 inout→inout；output 驱动保持内部） | ✅ | aw.test + examples.test(03) + demo |
| 显式 `aw-port` 优先 | ✅ | demo（`phy_gray_o` / `tb_gray_o`） |
| `aw-imports` 去重 + 自底向上继承 | ✅ | 引擎实现；demo 未用 package 端口（§5 缺口） |
| 嵌套 `aw-submods` + 兄弟 deps 可见集 | ✅ | aw.test（缺边/环/自依赖/未知名/死边警告）+ demo |
| 跨 `[connect.<id>]` deps：未声明报错 / 缺快照报错 / 死边警告 | ✅ | aw.test + e2e（tb 缺快照 → error） |
| 生命周期：before-instances（preposs）/ on-template（中间态）/ before-dump（只读） | ✅ | demo 两写一冻全覆盖；aw.test（钩子生成例化） |
| render 冻结 / dump 门禁（残留 template→422） | ✅ | e2e（dump gate 用例） |
| GET `?check/?render/?dump/?select` 与按钮同链；`?check=1` 不 render 不写盘 | ✅ | e2e 7 用例 |
| `#aw-status[data-state]` + `document.title` 完成信号 | ✅ | e2e |
| Render 依赖 Check / Dump 依赖 Render（自动前序） | ✅ | e2e（按钮与 GET） |
| 常量连线（`to` = 字面量/拼接/宏/param·localparam 引用；不建网；禁 part/维度；常量 rewrite 批量 tie-off 禁捕获；能力边界=复杂组合走集成小模块） | ✅ | aw.test 7 例 + printer.test + examples.test(05) + demo（tb `clr_i`→`1'b0`，Verilator 闭合） |
| `type` 三态（net 默认；const/open 必须显式；推断校验不一致报错） | ✅ | aw.test（缺声明报错/声明不符报错） |
| 显式悬空 `type="open"`（output/inout；input 报错；批量 rewrite；`.port()` 打印；覆盖往返；未覆盖端口 warning） | ✅ | aw.test 4 例 + printer.test + demo（`overflow_o` open → PINMISSING 归零） |
| 快照字节稳定（golden） | ✅ | `test/golden/*.sv` 逐字节比对 |
| 127.0.0.1 隔离 / 路径逃逸拒绝 | ✅ | e2e（`../escape` → 400） |

## 4. 设计修改意见报告（实现期裁定，均已回落到 docs）

**A. `aw-submods` 可见集公式矛盾（connect-html §3.3）。** 原公式 `visible(child) ⊇ {parent 的直接子 aw-mod}` 使兄弟模无需 deps 即可见，与同表「兄弟互引必须写 deps」冲突。裁定：`visible(M) = {M 的直接子} ∪ M.deps ∪ 祖先路径 deps`；兄弟不自动可见。已改文档。

**B. elaboration 顺序（connect-html §5）。** 原顺序把 submods 递归放在父模连线之后，但父模可例化子包装模、需要其 render 端口表。裁定：子模按 deps 拓扑先 elaborate，父模连线在后。已改文档。

**C. 参数折叠修正（connect-rules §7.2）。** 原规则「单一标识符 = 本模 aw-param → 折叠到已解析值」在父模 override 该参数时产生错误常量（demo 实抓：`gray_pair` 的 `Width=GWIDTH` 被折叠成默认值 8，`gray_tap` override `GWIDTH=16` 后 Verilator 报 WIDTHTRUNC）。裁定：模块 parameter 永不折叠（overridable）；内部 localparam 链终于常量才折叠。已改文档与示例 01-rendered。

**D. 导出端口维度自包含。** 端口维度是模块契约：uniquify localparam 名不能逃逸到父模。裁定：信号维度保留 `Mod__Inst__Param`（§7.4 原文），导出端口维度把 uniquify/localparam 替换为其值文本（常量则折叠成数）。

**E. `part` 求值（connect-html §3.6「render 宜保留求值后的 part」）。** 实现内置常量算术求值器（`+ - * / %` 括号、based literal），`8*${idx}+7:8*${idx}` 落成 `15:8`；含符号/宏则保留原文。

**F. render 维度规范化。** 统一 `packed`/`unpacked`（RtlIndex 形，裸区间补 `[]`）；废弃示例中端口上的 `width=` 写法；`nettype="wire"` 默认值不落地。示例 01/03/04 rendered 已规范化（03 另补漏画的 `dbg→lane_dbg` 连线）。

**G. 生命周期开放项（connect-lifecycle §6）。** 裁定：`aw.on(phase, fn)`；钩子按连接单元隔离（页面用哨兵脚本等注册完成）；同步钩子；子模整段先于父模连线。已改文档。

**H. `before-instances` 前置 prepass。** 钩子生成的例化也参与叶子表预取，故引擎拆出 `runBeforeInstances(doc, unitId)`：先跑钩子、再取叶子端口表、再 elaborate。

**I. hdxml bug 修复（非 web 范围但阻塞正确性）。** `hdxml/src/db/extract.rs` 的参数默认值捕获在嵌套表达式（三元/`$clog2`）上截断为首个子表达式（`BinWidth = OnehotWidth == 1 ? 1 : $clog2(OnehotWidth)` 曾被截成 `OnehotWidth`），导致 `packed=auto` 抄错宽度。修复：外层表达式窗口先开先收，嵌套节点压 `Skip` 占位配对；加回归测试；36 个 hdxml 测试全绿，重建索引后 `phy_bin_o` 宽度正确。

**J. `autowire web` 的参数语义。** `web [html]` 实现为 `web [unit]`（unit id 或 html 路径尾匹配），默认取 deps 拓扑第一个单元；页面另有 `?unit=`。

## 5. 验证记录与已知缺口

**验证**
- `bun test`：48 用例全绿（引擎/打印机/文档示例/Playwright e2e）。
- `bun run lint`（Biome）：0 error；`src/lang-guard.test.ts` 强制 TS 英文注释。
- Verilator `--lint-only`（真实叶子源码闭合）：`phy_wrap` 子树**零告警**；含 tb 全链仅剩 `cc_lfsr` 上游断言代码自身在 `LfsrWidth=16` 下的两条宽度告警（测试材料固有，非生成代码缺陷）。
- iverilog 交叉验证：iverilog 对 common_cells 上游 SV 特性（断言/typedef）不支持，仅作记录，不采信。
- 无头浏览器实测（headless Chromium）：首屏 idle、按钮链、GET 各组合、错误路径（缺快照 → `#aw-status[data-state=error]` + 标题 `[error]`）、dump 门禁 422、未知 GET 参数忽略。

**已知缺口（诚实清单）**
1. 多维 packed/unpacked、interface/modport 端口：引擎与打印机已实现并有单元测试，但 common_cells 无此类叶子，demo 未走真实 RTL 闭合（建议后续引入含 interface 的测试材料，如 `cc_stream_intf` 或自建小叶）。
2. `aw-imports` 的 package 类型端口自动继承（`pkg::` 扫描）已实现，demo 未触发（所选叶子端口无 package 类型）。
3. `inout` 自动导出由文档示例 03 锁定，真实叶子闭合未覆盖（common_cells 无 inout 叶子）。
4. `part` 与已声明维度的越界静态检查未实现（依赖维度求值，超出常量范围时报错目前靠下游 EDA）。

5. `autowire cli` 按契约**未实现**（等 Web 用例/golden 稳定后再做）。
