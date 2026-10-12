# TypeScript 代码：现状评估与优化方向

> 2026-10-12 评审。范围：`src/plugins/wishbone-{bus,regfile}/`（DSL、发射器、软件图）、对应的 `test/wishbone-*.test.ts`，以及它们写出的 RTL。`src/core`（connect / printer）的性能工作见 [core-perf.md](./core-perf.md)，本文不重复。
> 评审基线：v2.4.0 `main` + 分组 `Crossbar()`（[wishbone-bus.md §4.2](../plugins/wishbone-bus.md)）。
> 本文是**方向与约束**，不是排期。每一项落地前仍以 [`docs/`](../README.md) 契约为准；改变产物的项必须重跑 demo 冒烟并重新 baseline。

## 0. 结论

| 维度 | 评价 | 一句话 |
|---|---|---|
| 架构 / 分层 | 好 | DSL → `BusDef` → 发射器 → 软件图单向流；加一种拓扑只碰发射器 body，demo 产物零 diff |
| 构造期校验 | 好 | 错误全部在 SoT `import` 时抛出，文案带名字与原因 |
| 工程纪律 | 好 | biome + tsc 必须干净、CJK 守卫、help/docs 强制同步、生成物带 SoT 指向 |
| 发射器实现 | 中 | 1574 行 `emit.ts`，`emitCrossbarBody` ≈285 行；手工 `padEnd` 对齐 34 处；两处重复、一处靠字符串反推语义 |
| 测试 | 中上 | 文本断言 ≈250 个（脆）+ Verilator 行为仿真（真）；Windows 上仿真层默认 skip |
| 生成 RTL | 合格 | 无 LATCH / MULTIDRIVEN / COMBDLY / CASEINCOMPLETE；`-Wall` 下 PINMISSING / UNUSEDSIGNAL / WIDTHTRUNC 三类风格告警可系统清掉 |

## 1. 当前数据

### 1.1 规模

| 文件 | 行数 | 最长函数 |
|---|---|---|
| `wishbone-bus/emit.ts` | 1574 | `emitCrossbarBody` ≈285、`emitBusSv` ≈115、`emitInterconnectBody` ≈105、`emitDecodeAndSlaves` ≈95 |
| `wishbone-bus/dsl.ts` | 1362 | 类型、构造器、校验、级联、tag 全在一个文件 |
| `wishbone-regfile/emit.ts` | 1055 | — |
| `wishbone-bus/emit-master.ts` | 684 | — |
| `wishbone-bus/emit-attach.ts` | 410 | 已走 `src/core/printer.ts`（`RenderModule` + `printSv`） |

### 1.2 生成 RTL 的 Verilator `-Wall` 告警（`-Wno-DECLFILENAME -Wno-UNUSEDPARAM`）

| 模块 | PINMISSING | UNUSEDSIGNAL | WIDTHTRUNC | 结构性 |
|---|---|---|---|---|
| `soc_wb_interconnect` | 10 | 13 | 2 | 0 |
| `sd_sha_interconnect` | 6 | 6 | 2 | 0 |
| `hbm_interconnect` | 0 | 0 | 0 | 0 |
| `hbm_ch_decoder` | 0 | 2 | 0 | 0 |
| `xb_crossbar`（测试拓扑） | 2 | 5 | 2 | 0 |
| `wb_cfg_pipe` / `wb_cdc` 模板 | — | 5 / 0 | 2 / 3 | 0 |
| `smoke_regfile` / `sha256_regfile` | — | 4 / 11 | 0 | 0 |

三类告警的根因都在生成器或模板里，见 §3.1。

## 2. 已经是对的（勿"优化"）

- `Bus()` / `Crossbar()` 返回同一种 `BusDef`；下游（wrapper、Excel、C/UVM、print-tree、`SlaveBus` 级联）不感知拓扑。**不要**为 crossbar 另起一套 IR。
- DSL 判定是结构式（`kind` 字段、鸭子类型，无 `instanceof`）：bundle 内置 DSL 与 `.autowire/dsl/` 副本不会冲突。**不要**改成 class。
- `noUncheckedIndexedAccess` 已开，发射器里的 `if (s === undefined) continue` 不是冗余。
- 构造期校验（重叠、广播、tag 切分、级联成环、组名）放在 DSL 而不是发射器，位置正确。
- 生成物增量写（`writeIfChanged`）、Excel 总是重写，符合 `cli.md` 的默认增量契约。

## 3. 优化方向

按"收益 / 风险"排序。**P1 不改产物语义（或只改 lint 层），P2 一次性改产物，P3 是重构。**

### 3.1 P1：让生成 RTL 过 `-Wall`（已落地）

回归门是 `test/wishbone-rtl-lint.test.ts`（`verilator --lint-only -Wall -Wno-DECLFILENAME -Wno-UNUSEDPARAM`，没有 verilator 时 skip）。没有 tag 时例化 `.TW(1)`（参数最小为 1，端口 `[TW-1:0]`）。`.s_tga()` 空接会变成 `PINCONNECTEMPTY`，所以接到一个被 `_unused_*` 读掉的网。没有 slave 消费的 `g_tga_*`、纯组合 decoder 的 `clk`/`rst_n`、regfile 字地址低 2 位和未覆盖的 `DAT`/`SEL` 位同样收进 sink。

| 告警 | 根因 | 修法 | 改产物？ |
|---|---|---|---|
| WIDTHTRUNC `(TW?TW:1)` | `wb_cfg_pipe_template.sv` / `wb_cdc_template.sv` 把 32 位参数当布尔 | `TW` 默认 1，端口 `[TW-1:0]`；没有 tag 的例化传 `.TW(1)` | 模板；没有 tag 时 beat 多 1 位（值为 0） |
| PINMISSING `.m_tga` / `.s_tga` | 没有 tag 时发射器故意不连（模板注释允许） | `.TW(1)`、`.m_tga(1'b0)`，`.s_tga` 接到被读掉的网（空接是 PINCONNECTEMPTY） | 是 |
| UNUSEDSIGNAL `m<i>_*_q`（interconnect） | 任一 master 有 `pipe` 时对 **所有** master 发射 `emitMasterPipe`；`pipe=0` 的网声明并驱动但不用，`m<i>_rdat_q/ack_q` 既不驱动也不用 | 只给 `pipe>0` 的 master 发射（crossbar body 已如此） | 是（删死网） |
| UNUSEDSIGNAL `wr_sel_*`（regfile） | RO 寄存器也生成写选通 | 只给有可写字段的寄存器发 `wr_sel_*` | 是 |
| UNUSEDSIGNAL `i_wb_adr[1:0]` / `i_wb_sel[3:1]` / `clk,rst_n`（纯组合 decoder） | 协议允许不用 | 发射一个 `_unused` 吸收网，或在模块头 `/* verilator lint_off UNUSEDSIGNAL */` 圈住 | 是 |
| UNUSEDSIGNAL `beat_t` 部分字段（pipe 模板） | 一个 struct 双向复用，每跳只用部分字段 | 模板内 `lint_off` 圈住；结构不改 | 模板 |

落地方式：`test/wishbone-rtl-lint.test.ts`（`verilatorTest`，缺 verilator 时 skip）对 demo/soc、demo/hbm 和 crossbar 测试拓扑跑 `verilator --lint-only -Wall`，断言零告警。此后 "lint 过" 成为生成 RTL 的回归门，不再只靠 "仿真过"。

### 3.2 P1：Windows 也跑仿真层

Verilator 行为用例是最有价值的测试，但在 Windows 上默认 skip。要求：MSYS2 UCRT64 装 `mingw-w64-ucrt-x86_64-{verilator,make,python}`（`verilated.mk` 用 `python3` 生成 `*__ALL.cpp`，缺 python 时 `Error 49`），PATH 只加 `C:\msys64\ucrt64\bin`。细节在 [windows-msys2.md](./windows-msys2.md)。`test/fixtures/verilator.ts` 已处理 `verilator_bin` + `mingw32-make` + `VERILATOR_ROOT`。

### 3.3 P2：测试从"文本片段"转向"golden + 语义"

现状：5 个 wishbone 测试文件 ≈250 个 `toContain` / `toMatch`，很多是整行精确匹配。格式一变全红，但不说明语义变没变。

方向：

1. **Golden 文件**：对 demo/soc、demo/hbm 和几个合成拓扑（decoder / interconnect / crossbar / tagged / piped / broadcast）把 `emitBusSv` 输出存为 `test/golden/wishbone/*.sv`，比对整文件。重 baseline 必须是独立 commit，diff 要能被人读。
2. **语义断言**保留在 `BusDef` 层（地址、mask、组、tag plan、端口列表），不在 SV 文本层。
3. **行为用例**：现有 `wb_master_tb.sv` / `wb_crossbar_tb.sv` 模式，每种拓扑特性至少一个 TB；TB 的 BFM 统一成一个 `wb_bfm` 模块复用（当前每个 TB 内重复写 `*_xfer` task）。
4. **lint 用例**：§3.1。

### 3.4 P3：发射器从字符串模板转向结构化模型

现状：`emit.ts` 用模板字符串 + `padEnd(7)` 手工对齐（34 处）；`arbiterLogic` 里 `else              ` 是写死的空格，对 `mg_<g>_` 前缀对不齐（crossbar 输出已可见）。Type-A wrapper（`emit-attach.ts`）早已走 `src/core/printer.ts` 的 `RenderModule` + `printSv`，对齐由 `PrintStyle` 决定。

方向：**fabric body 也走同一个模型**。`RenderModule` 目前有 `ports / signals / localparams / insts / assigns`，缺 `always_comb` / `always_ff` 块。两条路：

- **a. 扩 `RenderModule`**：加 `blocks?: { kind: "comb" | "ff"; sens?: string; lines: string[] }[]`，块内文本仍由发射器写，但声明、assign、例化、localparam 全部走 printer 对齐。改动小，立刻消灭大部分 `padEnd`。
- **b. 小型 SV builder**：`sv.decl(name, width)`, `sv.assign(lhs, rhs)`, `sv.comb(() => ...)`, `sv.ifChain([...])`，最后一次性打印。更彻底，但要重写整个 `emit.ts`，产物格式必然变。

建议 a 先行；b 只有在 a 之后还嫌不够时再做。无论哪条，先有 §3.3 的 golden，再动。

### 3.5 P3：发射器函数分解与去重（不改产物）

| 位置 | 问题 | 修法 |
|---|---|---|
| `slaveTagPorts` → `emitSlaveCombo` | 用 `p.name.slice(p.name.lastIndexOf("_tga_") + 5)` 从端口名切回 tag 域名 | `slaveTagPorts` 返回 `{ domain, port, width }`，调用方不再解析字符串 |
| `emitSlaveCombo` / `emitSlavePipe` | 各自算一遍 `hit` / `offset` / `masked`（≈20 行 × 2） | 抽 `slaveSelect(s, scope, adr) → { hit, winAdr }` |
| `emitSlavePipe` | 同一个 `def.tags.filter(...)` 写三次 | 算一次存局部 |
| `emitCrossbarBody` | ≈285 行 | 拆 `emitMasterGroup(mg)` / `emitSlaveGroup(sg)` / `emitCrossbarResponses()`，目标每函数 < 80 行 |
| `emitBusSv` | 头注释、端口、body 三段混在一起 | `emitHeader(def)` / `emitPorts(def)` / body 分发 |
| `crossbarViews` | 每个成员 `find`，O(n·m) | `Map<name, …>`；规模小，优先级最低 |

守住的回归：demo/soc、demo/hbm `plugin wishbone run` 后 `git status` 零 diff（现有做法），加 §3.3 golden 后更稳。

### 3.6 P3：`dsl.ts` 拆文件

1362 行一个文件：类型、`Size`/`Slave*`/`Master`/`Bus`/`Crossbar` 构造器、十余个 `assert*`、tag 归一化、级联。建议：

```
wishbone-bus/
  dsl.ts            ← 只 re-export（保持 import 路径与 pack 闭包不变）
  dsl/types.ts      WbSlave / WbMaster / BusDef / Tag*
  dsl/slave.ts      Size / Slave / SlaveRegion / SlaveRegfile / SlaveBus
  dsl/master.ts     Master / MasterOpts
  dsl/bus.ts        Bus / Crossbar / MasterGroup / SlaveGroup / buildBus
  dsl/validate.ts   assert*（重叠、广播、tag、级联、组）
  dsl/tags.ts       normalizeTags / orderAddrTags / domainWidth
```

**约束**：`src/cli/pack.ts` 把 `wishbone-bus/dsl.ts`、`wishbone-regfile/{dsl,layout}.ts` 打进 `.autowire/dsl/` 供独立工作区 import。拆文件后 pack 闭包要改成按目录收集，并在 `scripts/smoke-bundle.ts` 验证独立工作区还能 `import { Crossbar } from "../.autowire/dsl/wishbone-bus/dsl.ts"`。

### 3.7 类型层面

- `WbSlave` 现在是"可选字段大杂烩"（`regfile?` / `bus?` / `broadcast?` / `tag?` / `window`）。可以收成判别联合：`{ kind: "raw" | "region" | "regfile" | "bus" | "broadcast", … }`，发射器里的 `if (s.regfile) … else if (s.bus) …` 变成穷举 `switch`，漏分支由 tsc 报。改动面大，放在 §3.6 之后。
- 地址 / 掩码目前是裸 `number`，32 位以上要靠 `>>> 0` 小心处理。可以引入 `type Addr = number & { __addr: true }` 这类品牌类型，或至少集中到 `addr.ts` 里的 `hex()` / `windowBytes()` / `align()`，不在发射器里直接位运算。
- `tsconfig` 可以再开 `noUnusedLocals` / `noUnusedParameters`（当前关着），先看报多少。
- biome 可加 `complexity/noExcessiveCognitiveComplexity`（阈值 25 左右）作为函数长度的机械门。

### 3.8 不做

- 不把 Wishbone 发射器改成通用 HDL 模板引擎（Jinja 类）。字符串模板的问题是**对齐和重复**，不是表达力；printer 模型足够。
- 不为 crossbar 增加独立 IR 或第二份 `BusDef`。
- 不在 `connect` 相位里跑 Wishbone 发射（契约：类型 A 插件自己的 `run`，见 `cli.md`）。
- 不追 `emit.ts` 的运行时性能：一次 `plugin wishbone run` 的发射部分在毫秒级，瓶颈在 Excel 写出与 Bun 启动。

## 4. 顺序建议

1. §3.2 Windows 跑通仿真层（环境项，不改代码）。
2. §3.1 `-Wall` 清零 + lint 用例。模板两项先做（不改产物），再做三项改产物的，一次性 re-baseline demo 并跑 `sim/verilator/run.sh` 全部冒烟。
3. §3.3 golden 文件。此后才有资格动 §3.4 / §3.5。
4. §3.5 去重 / 分解（产物零 diff，golden 守）。
5. §3.4a 扩 `RenderModule`，fabric 声明 / assign / 例化走 printer。
6. §3.6 / §3.7 拆文件与类型收紧。
