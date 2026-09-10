# 插件生成代码质量审计：wishbone-regfile / wishbone-bus

> 日期：2026-09-10。
> 范围：`demo/soc/gen/plugins/` 下 4 个生成 SV 文件，及对应生成器源码 `src/plugins/wishbone-regfile/`、`src/plugins/wishbone-bus/`。
> 约束：生成物头部标注 `Do not edit`，**所有修复必须落在生成器源码**，改完重跑生成以复现。

## 1. 审查对象

| 文件 | 角色 | 来源插件 |
|---|---|---|
| `demo/soc/gen/plugins/wishbone-regfile/smoke_regfile.sv` | regfile（RC/RO/RW/RWW/RWE/W1P/W1C/shadow/wide） | `src/plugins/wishbone-regfile/` |
| `demo/soc/gen/plugins/wishbone-regfile/sha256_0_regfile.sv` | regfile（RW/W1P/RO） | 同上 |
| `demo/soc/gen/plugins/wishbone-regfile/sha256_1_regfile.sv` | regfile（RW/W1P/RO） | 同上 |
| `demo/soc/gen/plugins/wishbone-bus/soc_wb_interconnect.sv` | 3-master / 12-slave 优先级仲裁互联矩阵 | `src/plugins/wishbone-bus/` |

审查方法：读完整生成物 + 完整生成器（`emit.ts` / `dsl.ts`），逐项对照 Wishbone classic 协议与 DSL 契约，识别正确性缺陷、语义不一致、死代码、宽度/可移植性不一致。未做综合/lint 验证（见 §5）。

## 2. 结论摘要

| ID | 严重度 | 类别 | 位置 | 一句话 |
|---|---|---|---|---|
| W-1 | Critical | 正确性 | regfile 写路径 | `i_wb_sel` 被忽略，部分字写会整字覆盖 |
| W-2 | High | 功能缺口 | W1C 存储 | sticky 无硬件置位通路，输出恒 0 |
| W-3 | High | 语义不一致 | shadow 读路径 | 读用副本 OR，侧带用 `o_sel` 选一，广播 remap 下分裂 |
| W-4 | Medium | 契约缺失 | RWW 存储 | SW/HW 同周期写优先级未定义、未文档化 |
| W-5 | Medium | 可移植性 | bus decode | 互联矩阵硬编码 32-bit 地址，regfile 却参数化 `aw` |
| W-6 | Low | 冗余 | wr/rd_sel | `hit` 与 `addr_hit_x` 重复 |
| W-7 | Low | 死代码 | interconnect | `integer si; integer oi;` 未使用 |
| W-8 | Low | 冗余 | 仲裁 | `grant_nxt` 循环体内重复清零 |
| W-9 | Low | 噪声 | read mux | 每分支重复 `rd_data = 32'h0` |
| W-10 | Low | 误导 | shadow decode | 2-bit TGA 下 `< 4` 死条件、`miss keeps 0` 注释不可达 |

结论：**可合成、无锁存/组合环，结构规整**；但 W-1 是真 bug（静默数据破坏），W-2 是死逻辑，W-3 是广播 remap 下的潜在 bug。三项都值得在生成器层修复，其余为清理项。

## 3. 发现

### 3.1 [Critical] W-1 —— 字节使能 `i_wb_sel` 被忽略

**证据**（`smoke_regfile.sv`，三个 regfile 一致）：

- 端口 `smoke_i_wb_sel` 声明于第 41 行，但整个文件体中**从不引用**。
- 写路径（第 261、267、276、333 行等）直接整字段赋值，无 sel 屏蔽：

```systemverilog
else if (wr_sel_8) rg_enable_q <= smoke_i_wb_dat[0:0];
```

**生成器证据**（`src/plugins/wishbone-regfile/emit.ts`）：

- `i_wb_sel` 仅出现在 `collectPorts`（第 255 行生成端口）与 `wbPortComment`（第 185 行注释），`emitFieldStorage` 的写表达式只拼 `i_wb_dat[hi:lo]`，从不乘 sel。

**影响**：master 用 `sel=4'b0001` 写单字节时，整 32 位字段被覆盖，静默破坏同字段相邻位。互联矩阵已把 `g_sel → {slave}_i_wb_sel` 一路转发（`emitDecodeAndSlaves`），链路铺好、最后一跳缺失——这正是 Wishbone classic 协议违反，不是 demo 可忽略项。

**修复方向**：写路径按 sel 屏蔽字节；先在 `docs/plugins/wishbone-regfile.md` 定义部分字写语义（屏蔽 vs 报错），再落地 `emitFieldStorage`。优先项。

### 3.2 [High] W-2 —— W1C sticky 无硬件置位通路

**证据**（`smoke_regfile.sv` 第 303-306 行）：

```systemverilog
always_ff @(posedge i_clk or negedge i_rst_n) begin
    if (!i_rst_n) c_rg_sticky_q <= 1'h0;
    else if (wr_sel_18) c_rg_sticky_q <= c_rg_sticky_q & ~smoke_i_wb_dat[0:0];
end
assign c_rg_sticky = c_rg_sticky_q;
```

复位后 `c_rg_sticky_q` 只能被 W1C 清零，**没有任何 set 输入能把它拉高**，`c_rg_sticky` 输出恒 0。"Sticky IRQ" 寄存器是死逻辑。

**根因**：DSL `Access` 无 W1S（`src/plugins/wishbone-regfile/dsl.ts` 注释明确 `Access has RC, no W1S`），W1C 的侧带前缀 `c_rg` 只有输出、无置位输入。这是 DSL 层的功能缺口，不是 emit bug。

**修复方向**：二选一——(a) 给 W1C 增加硬件 set 侧带（`i_` 输入）；(b) 文档化本 DSL 的 W1C 为 clear-only，要求置位侧带走外部 RO/胶水逻辑。当前 demo 表 spec 未提供置位源，需与 spec 作者确认意图。

### 3.3 [High] W-3 —— shadow 读路径 OR 副本，与侧带选一不一致

**证据**：

- 读路径（`smoke_regfile.sv` BANK 分支第 415-423 行；`emit.ts::emitFieldRead` 第 819-829 行）：

```systemverilog
logic [7:0] __v;
__v = 8'h0;
for (int __c = 0; __c < 4; __c++) begin
    if (mask_bank[__c]) __v |= rg_cfg_q[__c];
end
rd_data[7:0] = __v;
```

- 输出侧带（`smoke_regfile.sv` 第 326 行；`emit.ts` 第 783 行）：

```systemverilog
assign rg_cfg = rg_cfg_q[o_bank_sel];
```

**影响**：`mask_bank` 为 one-hot 时两者等价（OR 单个选中项 = 选中值），当前 smoke 表无 remap 故不显现。但 DSL 支持 `Shadow.remaps` 广播位掩码（如 `0b1111`）——一旦广播写，读路径 OR 出全部副本，侧带只读 copy0，语义分裂。RO 带 shadow 的读（`emitFieldRead` 第 793-801 行）同样用 OR 循环，同样受影响。

**修复方向**：读路径统一改用 `stem_q[o_{shadow}_sel]`（与侧带一致），删除 OR 循环。除非广播 remap 的读语义确实定义为"多副本归约"，否则应选一。

### 3.4 [Medium] W-4 —— RWW 的 SW/HW 写优先级未文档化

**证据**（`smoke_regfile.sv` 第 274-278 行；`emit.ts` 非 shadow RWW 分支）：

```systemverilog
if (!i_rst_n) rg_capture_q <= 16'h0;
else if (wr_sel_c) rg_capture_q <= smoke_i_wb_dat[15:0];
else if (rg_capture_strb) rg_capture_q <= rg_capture_hwdata;
```

SW 写（`wr_sel_c`）优先于 HW 写（`rg_capture_strb`），同周期两者同时有效时 HW 写被吞。该优先级合理但**未在 DSL 契约或文档中说明**。

**修复方向**：`docs/plugins/wishbone-regfile.md` 补一行契约：RWW 同周期 SW 优先于 HW（或改 HW 优先，须与表 spec 对齐后定）。

### 3.5 [Medium] W-5 —— 地址宽度不对称

**证据**：

- regfile decode 参数化：`addr_hit_x = (adr[aw-1:2] == …)`（`emit.ts` 第 536-541 行用 `${aw - 1}:2`）。
- 互联矩阵硬编码 32-bit：`emitDecodeAndSlaves` 中 `g_adr & 32'h{mask}`、`g_adr` 声明为 `[31:0]`（`emit.ts::emitInterconnectBody`）。

**影响**：`addr_width ≠ 32` 时 regfile 能正确窄 decode，但 bus 侧 mask 截断/错位。demo 全 32-bit 不显现，但两个插件对 `aw` 的假设不一致，是隐藏的地雷。

**修复方向**：bus 侧 mask 与 `g_adr` 宽度参数化到 `def.addr_width`，与 regfile 对齐；或明确声明 bus 只支持 32-bit 并在 `dsl.ts` 加运行时断言。

### 3.6 [Low] W-6 —— `hit` 冗余

`emit.ts` 第 556-557 行生成 `wr_sel_x = wr_fire && hit && addr_hit_x`，而 `addr_hit_x` 已蕴含 `hit`。合成器会优化掉，属纯噪声。若保留 `hit` 是为可读性，可只在 `wr_fire`/`rd_fire` 处体现。

### 3.7 [Low] W-7 —— 未使用的整型循环变量

`emit.ts::emitInterconnectBody` 输出 `integer si;`、`integer oi;`，但正文只用了 `gi`/`mi`/`ri`。删除两个未用声明。

### 3.8 [Low] W-8 —— `grant_nxt` 循环内冗余复位

`emit.ts::emitInterconnectBody` 仲裁循环：

```systemverilog
for (gi = 2; gi >= 0; gi = gi - 1)
    if (m_cyc_i[gi]) begin
        grant_nxt = 3'b0;      // 冗余：循环前已清零
        grant_nxt[gi] = 1'b1;
    end
```

循环体每次命中都整体清零再置位，只需循环前清零一次。逻辑正确（高→低迭代保证最低索引胜），纯冗余。

### 3.9 [Low] W-9 —— read mux 重复初始化

`emit.ts` 第 617 行每个 `rd_sel_x` 分支都先 `rd_data = 32'h0`，而 `always_comb` 顶部已初始化。无害噪声，可去。

### 3.10 [Low] W-10 —— shadow decode 死条件与误导注释

`smoke_regfile.sv` 第 233-240 行：

```systemverilog
assign raw_bank = smoke_i_wb_tga[1:0];
always_comb begin
    mask_bank = 4'h0;
    if (raw_bank < 4) mask_bank = 4'd1 << raw_bank;   // 2-bit TGA，恒真
end
// one-hot mask → bin index (first set bit); miss keeps 0   // 2-bit 不可达 miss
```

`raw_bank` 是 2-bit，`< 4` 恒真；`miss keeps 0` 对 4 副本/2-bit tag 不可达。注释描述的是通用情形，但此处误导读者以为存在 miss 分支。属清理项。

## 4. 修复优先级

| 顺序 | 项 | 动作 | 风险 |
|---|---|---|---|
| 1 | W-1 | `emitFieldStorage` 加 sel 屏蔽 + docs 定义部分写语义 | 中（需先定语义） |
| 2 | W-3 | `emitFieldRead` shadow 读统一 `_q[o_sel]` | 低（one-hot 下行为不变） |
| 3 | W-2 | DSL 加 W1C set 侧带，或文档化 clear-only | 中（牵动表 spec） |
| 4 | W-4 | docs 补 RWW 优先级契约 | 无 |
| 5 | W-5 | bus mask 宽度参数化 | 低（32-bit 下无变化） |
| 6 | W-6/W-7/W-8/W-9/W-10 | 一次性清理 | 无 |

## 5. 验证建议

- **W-1 回归**：regfile 加一个部分字写用例——`sel=4'b0001` 写字节 0，断言仅 `[7:0]` 更新、`[31:8]` 不变。修后通过、修前失败。
- **W-3 回归**：给 shadow 表加 `remaps` 广播（如 `0b1111`），断言读回与 `o_sel` 侧带一致。
- **W-2**：若选 (a) 方案，加 W1C 置位→清零往返用例。
- **合成/lint**：重跑生成后跑一次 lint/synth（项目约束 `bun run lint`），确认 W-5 参数化不引入宽度告警。

## 6. 证据索引

| 项 | 生成物位置 | 生成器位置 |
|---|---|---|
| W-1 | `smoke_regfile.sv:41,261,267,276,333` | `emit.ts:255`（仅端口）、`emitFieldStorage`（无 sel） |
| W-2 | `smoke_regfile.sv:303-306` | `emit.ts` W1C 分支、`dsl.ts` Access 注释 |
| W-3 | `smoke_regfile.sv:326,415-423` | `emit.ts:783` vs `emit.ts:819-829`（RO 793-801） |
| W-4 | `smoke_regfile.sv:274-278` | `emit.ts` 非 shadow RWW 分支 |
| W-5 | `soc_wb_interconnect.sv` decode 段 | `emit.ts:536-541` vs `emitDecodeAndSlaves` |
| W-6 | `smoke_regfile.sv:202-223` | `emit.ts:556-557` |
| W-7 | `soc_wb_interconnect.sv` 声明段 | `emit.ts::emitInterconnectBody` |
| W-8 | `soc_wb_interconnect.sv` 仲裁段 | `emit.ts::emitInterconnectBody` |
| W-9 | `smoke_regfile.sv:380-441` | `emit.ts:617` |
| W-10 | `smoke_regfile.sv:233-240` | `emit.ts:565-588` |
