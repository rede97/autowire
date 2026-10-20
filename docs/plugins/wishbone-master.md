# Wishbone Master 接口：CDC / APB / JTAG

> 状态：**已落地**（`Master(..., { apb | jtag | cdc })`、`wb_cdc` / `wb_apb2wb` / `wb_jtag_tdr`、ICL/PDL；demo/soc 已接 JTAG）。§8 暂时不动。
> 上位约束：[`wishbone-bus.md`](./wishbone-bus.md)（WB Classic 子集、arbiter、`<bus>_bus_cfg` wrapper）。
> 参考实现：[Gitee master `435180e`](https://gitee.com/lunamiko/autowire/tree/435180e61a2580d5db3f3cc6f8f4e622b638876b) 的 `autowire/cfgbus/cfg_apb.py`（`CfgApbBridge`）。用户提供的硅验证结论适用于该参考实现；本仓库迁移其 posted 语义，但以目标 WB ACK 适配 cfg ready/data-valid，并保留 TGA、APB PPROT 拒绝行为，不是原版逐字复制。新增 WB 适配与默认 FIFO **不宣称经过硅验证**。
> 改本文时同步 `help status` 与 [`wishbone-bus.md`](./wishbone-bus.md) §1 / §8。

关键字「必须 / 应当 / 可以」按 RFC 2119。

## 1. 问题

`BusDef` 的 master 原先只有一种：与 fabric **同 `clk`** 的原生 WB 口（`{m}_o_wb_*` / `{m}_i_wb_{dat,ack}`）。需求：

1. master 可以在 **异步时钟域**（CDC 跨时钟访问）。
2. master 可以是 **APB**（SoC 侧配置口）。
3. master 可以是 **JTAG**，且 **必须**能直接接入 DFT 流程的全局 JTAG（芯片 TAP），而不是私有 JTAG 口。

问：**APB / JTAG 先转成 WB，再在 WB 上做 CDC，是否可行？** 答：可行，已按此实现（§3）。

## 2. 主干（master 分支）现状

| 项 | 主干做法 | 评价 |
|---|---|---|
| APB 桥 | `apbctrl` FSM（`apb_clk`）+ 两个 async FIFO：命令 `apb2cfg`（depth 8：`{wdata, pstrb, rw, addr}`）、读数 `cfg2apb`（depth 2） | 协议转换与 CDC **融合**在一个模块；换协议就要重写 CDC |
| 写语义 | FIFO push 即回 `PREADY`（**posted 写**） | 吞吐好；写错误无法回报 |
| 读语义 | 等 `cfg2apb` 非空再回 `PREADY` | 正确；cfg 域停钟/复位时 APB **永久挂死** |
| PPROT | `apb_pprot == apb_pprot_pin` 才受理 | 不匹配时 FSM 停在 IDLE、**永不回 `PREADY`** → 总线挂死（缺陷） |
| PSLVERR | 恒 0 | 无错误通路（缺陷） |
| FIFO 模块 | 命令 FIFO 的模块名硬编码，返回 FIFO 的模块名来自参数 | 本仓库统一通过 wrapper 选择外部 `CELL_ASYNC_FIFO` |
| 仲裁 | `CfgArbiter`：`arb_clk` 单域 round-robin；固定 `RD_PIPE` 读延迟 | 所有 CDC 都在仲裁之前完成——v2 沿用 |
| JTAG | **无**（主干仅 APB） | v2 新增 |

结论：沿用主干「CDC 在 master 口、仲裁/译码单时钟」分层与 posted 写语义；把 CDC 从协议桥拆出，并保留 APB PPROT 拒绝错误，不增加超时或自动恢复机制。

## 3. 结构：先转 WB，再 CDC

```text
 源域 (PCLK / TCK / {m}_clk)                   │            fabric 域 (clk)
                                              │
 APB  ── wb_apb2wb (同步, PCLK) ──┐            │
 JTAG ── wb_jtag_tdr (同步, TCK) ─┼─ WB ─ wb_cdc ─ WB ─→ arbiter / decoder → leaf
 WB   ────────────────────────────┘            │
                                              │
 （同域 master：无 wb_cdc，直连 fabric；APB 可 cdc:false 跑在 clk）
```

理由：

1. **CDC 只写一份、验一份**。协议桥全是 **单时钟同步逻辑**，CDC 集中在 `wb_cdc`；签核只看一个结构。
2. **异步命令 FIFO + 读返回 FIFO**：命令深度 8，携带 `{we, adr, dat, sel, tga}`；返回深度 2，仅在目标读事务 WB ACK 后入队 `rdat`。写在命令入队时应答（**posted**），可连续接受写直到 FIFO 满；源端仍按 WB Classic 逐笔握手，读等待返回。默认 `wb_async_fifo` 包装同文件的 `wb_async_fifo_gray`，使用 Gray 指针及 `wb_sync_cell`，禁止逐 bit 同步数据。外部 FIFO 接入见 §3.1。
3. 仲裁 / 译码 / regfile **保持单时钟**；fabric（`<bus>_decoder` / `<bus>_interconnect`）生成物 **不变**，全部桥接逻辑在 `<bus>_bus_cfg` wrapper 内。
4. 延迟包含两向 FIFO 指针同步、寄存读出和目标 WB 应答。大批量灌数按 [`wishbone-bus.md`](./wishbone-bus.md) §5.1 走 DMA。

`wb_cdc` 规则（已实现）：

| 场景 | 行为 |
|---|---|
| 写语义 | 命令 FIFO 接受写即源侧 ACK；不表示目标或叶子完成，不能事后回报目标写错误 |
| 读语义 | 按命令顺序送至目标，等待目标 ACK 与读返回 FIFO 数据才源侧 ACK |
| 目标停钟或不应答 | 读持续等待；写可排队直到命令 FIFO 满，然后背压；`wb_cdc` 自身无超时，APB 源可用 `apb: { timeout }`（§4） |
| 源时钟停止 | 目标可继续处理已入队命令、缓存读响应；源恢复时钟后才能取回应答 |
| 链路复位 | `link_rst_n = s_rst_n & rst_n`：**任一侧**复位同时复位两个 FIFO 的两端（异步断言，对侧停钟也生效；各侧经本地同步器释放），单侧复位不会重放旧命令、不会发出 X 命令、不会让读数据错拍 |
| 复位丢失的读 | 读已入队（或已在目标执行）时发生链路复位：源侧回 **一次** `s_err`（源自身复位时除外）；随后新请求正常 |
| 已发出的目标拍 | 目标 `m_*` 只随 `rst_n` 复位：源侧单独复位时，已在 fabric 上的拍保持到 ACK（WB/PIPE 读不可撤销），其读数据被丢弃；之后的新命令排在它后面 |
| 链路未就绪 | 目标复位保持中或复位刚释放：新请求等待，`s_ack` / `s_err` 都为 0，直至链路同步完成 |
| 源放弃读 | 读挂起期间源侧撤掉 `CYC/STB`（如 APB 超时）：该读的迟到响应被静默排空，不会完成后续请求；新请求等其排空后再入队 |
| 同步器 | 全部经 `wb_sync_cell`：默认内建 `STAGES` 级触发器链（缺省 2），可用宏 `AUTOWIRE_SYNC_CELL` 换成外部 `CELL_SYNC`（§3.2），端口不变 |

复位仍会丢弃尚在命令 FIFO 中的写：**已返回 posted ACK 不保证写跨复位存活**，复位也不能回滚已经发生的副作用。不能用复位一侧或撤销请求当作取消/重试机制；超时或 `s_err` 后，软件应重新读回状态再决定是否重做。

同一 CDC 路径后续读只保证前序命令已经按序通过该路径；若下游 ACK 本身是 posted 入队，它不是全局下游写完成栅栏，也不保证其他路径、master 或分支已排空。

错误回报：fabric 不生成 ERR。`wb_cdc` 的 `s_err` 只在链路复位丢失挂起读时出现一次；停钟或不应答不报错（APB 由桥内 `TIMEOUT` 报 `PSLVERR`）。APB PPROT 拒绝仍由协议桥返回 `PSLVERR`；JTAG 本地访问使能/busy 违规仍可返回状态错误。

集成与签核注意事项：

- **RDC**：`link_rst_n` 是两路异步复位的组合 AND；源复位断言会异步清除目标域的 pop 流水与 `beat_owned`，目标复位断言会异步拉低源域的 `s_link`。这些是复位域交叉，RTL 仿真只覆盖功能，断言沿附近的亚稳态需 RDC 工具签核（或签核时换成复位单元）。在请求静默时断言复位仍是推荐做法。
- **复位脉宽**：两侧复位断言须满足 `wb_sync_cell` / CELL 的最小脉宽；释放后各侧至少两个本地时钟沿才就绪。源侧对链路复位的观测经 `s_clk` 同步，源时钟停止期间发生的目标复位会在 `s_clk` 恢复后被看到。
- **JTAG**：`{m}_trst_n` 与系统 `rst_n` 天然独立（调试器 TRST、看门狗/软复位），任一单独复位都按上表处理；系统复位丢失的读经 `wb_err` 进 TDR 的 sticky err，host 读到 err 后用 nop 清除再重发。
- **外部 CELL**：两侧端口接同一个 `link_rst_n`；CELL 必须允许两端在对侧停钟时异步复位，reset-busy 合并到 full/empty（§3.1）。

### 3.1 默认 FIFO 与外部 CELL 接入

默认生成可综合的 `wb_async_fifo.sv`，无配置、无外部 CELL 即可仿真，默认选择同文件内的 `wb_async_fifo_gray`。工程外部单元统一命名 `CELL_ASYNC_FIFO`；实际 CELL RTL 未随本仓库提供，默认实现不是已获硅验证的 vendor CELL。

外部 CELL 通过编译宏 `AUTOWIRE_ASYNC_FIFO_CELL` 选择模块名，**不要修改或排除生成的 `wb_async_fifo.sv`**：它在两种模式下都必须留在 filelist；另加入实际 CELL 或 adapter 及其依赖。Verilator 示例 `-DAUTOWIRE_ASYNC_FIFO_CELL=CELL_ASYNC_FIFO`；VCS 示例 `+define+AUTOWIRE_ASYNC_FIFO_CELL=CELL_ASYNC_FIFO`。analysis 必须使用相同宏和包含实际 CELL 的 filelist。没有该宏就用默认实现；指定模块缺失会编译失败，**不会静默回退**。不需要 TOML 选项。

| 项 | 所选外部模块的契约（CELL_ASYNC_FIFO ABI） |
|---|---|
| 参数 | `WIDTH`, `DEPTH`；WIDTH ≥ 1；DEPTH 为 ≥ 2 的 2 次幂；CDC 使用 8 和 2 |
| 写侧 | `wr_clk`, `wr_rst_n`, `wr_en`, `wr_data[WIDTH-1:0]`, `wr_full`, `wr_afull`；上升沿 `wr_en && !wr_full` 才接受 |
| 读侧 | `rd_clk`, `rd_rst_n`, `rd_en`, `rd_data[WIDTH-1:0]`, `rd_empty`, `rd_aempty`；上升沿 `rd_en && !rd_empty` 才接受 |
| 读延迟 | 接受 pop 的边沿后更新 `rd_data`，消费方在下一边沿采样；无 pop 时保持。FWFT CELL 须由 adapter 在 pop 时寄存队首数据，不能直接接组合队首 |
| 复位 | 低有效、异步断言，各侧同步释放；`wb_cdc` 把两端都接到 `link_rst_n`，任一侧断言即两端同时复位，对侧停钟时也必须生效。默认释放等待两个本地上升沿；释放前 `wr_full=1` / `rd_empty=1`，不接受操作 |
| reset-busy | 实际 CELL 的 reset-busy 必须由 adapter 合并到 full/empty，保证未就绪时不能接受读写；停钟时也须满足 CELL 的复位要求 |

不同端口、读延迟或复位约定的 CELL 必须提供真实 adapter，不能只改模块名。超过一拍的读延迟需预取以呈现上述 ABI。外部选择冒烟使用内建核心的测试 adapter，不是实际 vendor RTL 验证；工程必须用实际 CELL/adapter 重新验证 FIFO、CDC 与复位行为。

物理实现必须约束 Gray 指针跨域路径的最大延迟和位间 skew，正确映射双时钟存储/同步单元，满足复位脉宽与释放时序，并完成 CDC/RDC 签核。RTL 仿真和 `-Wall` 不覆盖亚稳态及布局布线。

### 3.2 同步单元 `wb_sync_cell` 与外部 CELL 接入

参数：`STAGES`（缺省 2，≥ 2）、`RESET_VAL`（缺省 0，复位时每一位都取该值）、`WIDTH`（缺省 1，≥ 1）；端口 `clk`、`rst_n`、`d[WIDTH-1:0]`、`q[WIDTH-1:0]`。现有调用方（FIFO 指针/复位释放、`wb_cdc` 链路检测、JTAG `en`）都用 `WIDTH=1`；`WIDTH` 是备用参数。

`WIDTH > 1` 等价于 `WIDTH` 个**互相独立**的单 bit 同步器，各位可能在不同边沿稳定，**不是**总线同步器：只能用于 Gray 码、每次只变一位或准静态的值，禁止用于二进制计数/多位数据（多位数据走 `wb_async_fifo`）。

外部 CELL 通过编译宏 `AUTOWIRE_SYNC_CELL` 选择模块名，规则与 §3.1 相同：生成的 `wb_sync_cell.sv` 两种模式下都留在 filelist，另加入实际 CELL/adapter；analysis 使用相同宏和 filelist；没有宏用内建实现；指定模块缺失编译失败，**不会静默回退**；无 TOML 选项。Verilator `-DAUTOWIRE_SYNC_CELL=CELL_SYNC`，VCS `+define+AUTOWIRE_SYNC_CELL=CELL_SYNC`。两个宏互相独立：选了外部 FIFO CELL 时，FIFO 内部同步由该 CELL 负责，`AUTOWIRE_SYNC_CELL` 仍作用于 `wb_cdc` 链路检测和 JTAG `en`。

| 项 | 所选外部模块的契约（CELL_SYNC ABI） |
|---|---|
| 参数 | `STAGES`, `RESET_VAL`, `WIDTH`，`wb_sync_cell` 原样透传，例化一次（`u_cell`）。CELL 自己处理多位：单 bit 的 vendor cell 由 adapter 按位 generate；只支持固定级数或宽度的 CELL 须在 adapter 中对不支持的值报 `$fatal`，不能静默忽略 |
| 端口 | `clk`, `rst_n`, `d[WIDTH-1:0]`, `q[WIDTH-1:0]` |
| 复位 | 低有效、异步断言，`q` 每一位立即为 `RESET_VAL`；对端停钟时也须生效。复位释放由本地 `clk` 同步 |
| 时序 | 每一位至少 `STAGES` 级触发器、各位独立；延迟可以多于 `STAGES` 拍（调用方只依赖“最终跟随”，不依赖精确拍数）；`q` 无毛刺 |

测试 adapter `test/fixtures/sync_cell_adapter.sv` 比内建实现多一级，只用于证明宏选择与 `WIDTH` 透传生效、CDC 对额外延迟不敏感，不是 vendor CELL 验证。

## 4. APB master（`wb_apb2wb`）

- APB3/APB4 completer，`PCLK` 域同步桥；`PSTRB` → `SEL`（读恒 `4'hf`；APB3 请把 `PSTRB` 拉 `4'hf`）；`PADDR` 字节地址 → WB `ADR`。
- `PREADY` 等 WB `ACK/ERR`；经 CDC 的写 ACK 表示入队（posted），读等返回；无 CDC 时完成语义由下游 WB/PIPE 决定。`ERR` → `PSLVERR=1`。
- `PPROT` 过滤：`(PPROT & mask) !== value` 时 **立即** `PREADY=1, PSLVERR=1`，不发 WB（修复主干挂死）。缺省 mask=0 全收。
- `cdc: false`（缺省）时桥跑在 fabric `clk`/`rst_n`，wrapper 不出 `{m}_pclk` / `{m}_presetn`，`wb_err` 接 `1'b0`。
- `apb: { timeout: N }`（PCLK 周期，1..65535；缺省/0 关闭；**必须** `cdc: true`）：WB 请求发出后 N 个 PCLK 内无 `ACK/ERR` → 撤 `CYC/STB`，`PREADY=1, PSLVERR=1, PRDATA=0`。`wb_cdc` 负责善后：已发到目标的拍继续做完，超时读的迟到响应被排空、不会交给下一笔；在命令 FIFO 满时超时的写未入队，不会落地；但与超时同拍入队的写仍可能落地。无 CDC 时拒绝该选项：撤 `CYC` 会撤销 fabric 上的拍，而 PIPE 读不可取消。
- 超时预算要覆盖最坏的 **排队** 时间：读排在命令 FIFO 中最多 8 笔已 posted 写之后，加上两向指针同步、目标应答和 PCLK/clk 频率比。预算太小会在目标正常但较慢时误报。超时后跟着的请求会等前一笔读排空，目标持续不应答时它也会超时。
- APB **禁止**成为 decoder / regfile 原生口（[`wishbone-bus.md`](./wishbone-bus.md) §4）。

## 5. JTAG master：接入 DFT 全局 JTAG

### 5.1 生成 TDR 仪器，不生成 TAP

- 芯片 TAP（IR、BYPASS、IDCODE、BSR、TLR）由 **DFT 流程拥有**（Tessent / TestMAX 等插入）。IEEE 1149.1 要求对外只有一个合规 TAP；IP 私自带 TAP 会破坏 BSDL / 边界扫描链。
- 插件生成 `wb_jtag_tdr`：IEEE 1149.1 **user-DR 客户端**口形，同时是 IEEE 1687（IJTAG）的 ScanInterface，可挂在芯片 TAP 的 user 指令下，或挂在 SIB 网络里。
- 同时生成 `<bus>_bus_cfg.icl`（ScanInterface / ScanRegister / Alias）与 Level-0 `<bus>_bus_cfg.pdl`（`<m>_write` / `<m>_read`：launch → `iRunLoop idle -tck` → 检查 `st=0`）。生成的 PDL 是固定等待后的比较，不自动重试 busy；read 的 `data` 参数是期望值。静态测试需配置足够的 idle；动态轮询由支持 Level-1 的工具或 host 实现，并设置重试上限、处理 err。状态比较失败后不能盲目重新 launch，原写可能已经发生。ICL **未**建模 CaptureSource（捕获值来自内部状态），接入前 **应当**由 DFT 评审方言差异。
- 私有 TAP：v1 **不**提供。

### 5.2 端口（TCK 域）

| 端口 | 方向 | 说明 |
|---|---|---|
| `{m}_tck` | in | TCK；同时是该 master `wb_cdc` 的源时钟 |
| `{m}_trst_n` | in | TDR/CDC 源侧低有效复位（1687 `ResetPort`），不复位 fabric；经 `wb_cdc` 链路复位同时清空两向 FIFO（§3），可独立于系统 `rst_n` 断言。demo/soc 的 `dbg_trst_n` 直接来自 `jtag_trst_n`，不是 TLR 状态派生复位 |
| `{m}_sel` | in | 本 TDR 被选中（IR 译码 / SIB 输出，DFT 驱动） |
| `{m}_capture_dr` / `{m}_shift_dr` / `{m}_update_dr` | in | TAP 状态解码（DFT 驱动） |
| `{m}_tdi` | in | 串入 |
| `{m}_tdo` | out | 串出 `dr[0]`（DFT 侧负责 TCK 下降沿重定时 / 多路选择） |
| `{m}_en` | in | 访问使能（lifecycle / fuse / DFT test mode），经 `wb_sync_cell` 同步到 TCK；为 0 时所有 op 记 err，不发 WB。**口必须存在**，可由作者接常量 |

### 5.3 DR 格式与时序

TCK 慢且 **只在扫描 / Run-Test-Idle 时翻转**：TCK 域逻辑 **不能**在一次扫描内等 fabric `ACK`。采用 **发起 / 轮询** 两段式（与 RISC-V DTM `dmi` 同构）：

```text
W = 2 + AW + 32，LSB 先移，tdo = dr[0]
shift in : { op[1:0], adr[AW-1:0], dat[31:0] }
capture  : { st[1:0], adr[AW-1:0], rdat[31:0] }   adr = 上次发出的地址

op: 0 nop   1 read   2 write   3 保留（按 nop）
st: 0 ok    1 busy（事务在飞）   2 err（sticky）
```

- `Update-DR`：op=read/write 且空闲、`en=1` → 锁存并拉起 TCK 域 WB 请求 → `wb_cdc` → fabric。
- busy 时再发 read/write：**丢弃**该 op 并置 err。
- err 来源：`en=0`、busy 时丢弃 op，以及桥输入 WB `ERR`（`wb_cdc` 仅在系统复位丢失挂起读时给出）；没有超时。空闲时一次 **nop 的 Update-DR 清 err**（其 Capture-DR 已先读出 err）。
- 写完成/`st=0` 表示命令已排入 CDC 队列，不表示叶子完成；读完成表示读数据返回。同一路径读可保持命令先后顺序，但不是跨路径或下游 posted 队列的全局栅栏。
- 源侧进展与读取响应需要 TCK 沿：两次扫描之间插入 N 个 Run-Test/Idle（PDL `iRunLoop`，`Master(..., { jtag: { idle } })`，缺省 16）；不足则读到 busy 再轮询。无硬件超时；host 停止轮询不会取消事务，不得盲目重新 launch。

### 5.4 DFT / 测试模式注意

- TDR 触发器属于 TCK 域；是否进 scan 链由 DFT 流程决定，生成物 **不**写 scan 属性。
- 扫描测试（ATPG）期间 **应当**由 DFT 把 `{m}_en` 拉 0，避免 shift 期间误写 CSR。
- 安全：JTAG 可读写全部 CSR，`{m}_en` 必须存在。

## 6. 作者面

```ts
Bus("soc_wb", "SoC cfg", {
  masters: [
    Master("cpu", "same-clock WB"),                                   // 原生口，不进 wrapper 逻辑
    Master("host", "SoC APB", {
      apb: { pprot: { value: 0b000, mask: 0b001 }, timeout: 64 },     // mask 缺省 0b111；timeout PCLK 周期，需 cdc
      cdc: true,
    }),
    Master("dbg", "DFT JTAG", { jtag: { idle: 16 } }),                // jtag 恒 cdc
    Master("wbx", "async WB", { cdc: true }),                         // 异步 WB 口
  ],
  // ...
});
```

- `apb` / `jtag` 互斥；`jtag` + `cdc: false` 报错；`apb.timeout` 范围 0..65535，`> 0` 时必须 `cdc: true`。
- 级联面（`child.uplink(name?)` 选出的 master 口）**禁止**带 apb/jtag/cdc；`Bus` 拒绝重名 master。
- 有任一桥接 master 时 generate **必须**打 `<bus>_bus_cfg`；fabric 上该 master 的 WB 口在 wrapper 内接 `{m}_fab_*`，协议桥源侧接 `{m}_src_*`。connect HTML 只看到：

| 形态 | wrapper 口 |
|---|---|
| APB | `{m}_pclk` / `{m}_presetn`（仅 cdc）、`{m}_paddr` / `psel` / `penable` / `pwrite` / `pwdata` / `pstrb` / `pprot` → `{m}_prdata` / `pready` / `pslverr` |
| JTAG | §5.2 |
| 异步 WB | `{m}_clk` / `{m}_rst_n`、`{m}_o_wb_*`（含 tga）→ `{m}_i_wb_dat` / `ack` / `err` |

原生 WB 面与 fabric master 面使用同一端点生成规则（名称、方向、位宽、TGA 域和可选 ERR），不在桥接发射器内另写一份 WB 端口表。APB / JTAG 的原生协议口不属于 WB 命名规则。

- TGA：异步 WB 口把每个继承域 `{m}_o_wb_tga_<domain>` 按声明顺序打包进 `wb_cdc` 的 `s_tga`（先声明的域在低位），目标侧再拆回 fabric 的同名口。域名不是 `tag` 时也走这条打包，不另造 `*_tga_tag`。APB / JTAG 桥把 tag 接 0。
- 公共模块：任一 bus 有桥接 master 时，`plugins_dir/wishbone/bus/` 额外出 `wb_sync_cell.sv`、`wb_async_fifo.sv`、`wb_cdc.sv`、`wb_apb2wb.sv`、`wb_jtag_tdr.sv`（模板在 [`rtl/`](./rtl/)，与 `wb_cfg_pipe` 同纪律）；手写 filelist 必须包含 `wb_sync_cell.sv` 与 `wb_async_fifo.sv`，选择外部 CELL 时另外加入 §3.1 / §3.2 的 CELL/adapter。有 JTAG master 的 bus 另出 `<bus>_bus_cfg.icl` / `.pdl`（非 SV，不进 filelist）。
- 单 master（NM=1 → decoder）同样适用：桥 / CDC 在 decoder 前。

## 7. 验证

`test/wishbone-master.test.ts`（Verilator `--binary --timing`，`test/fixtures/wb_master_tb.sv`；runner `test/fixtures/verilator.ts`）：fabric 10ns / PCLK 14ns / 异步 WB 6ns / TCK 50ns，四个 master 共享一个 TB 存储 slave：

- 同域 WB、APB（字节写、PPROT 违例 → PSLVERR 且不写）、异步 WB 读写。
- JTAG 写 / 读、busy 状态、busy 时丢弃 op → sticky err → nop 清除、`en=0` → err 且不写。
- CDC posted 写、读排序、停钟等待/满背压、协调复位，以及单侧/停钟复位不重放、丢失读回 ERR、源放弃读的响应排空；APB 超时经 CDC 的 PSLVERR 与善后。
- 四个 master 并发经仲裁写不同窗口后逐字校验。

- `test/async-fifo.test.ts`：深度 2/8 × 快写慢读/慢写快读，满/空保护、回绕顺序、并发生产消费、停读钟背压、停钟时复位清空及新数据读取。
- `test/wishbone-cdc.test.ts`：WB/APB 入口、时钟比、posted 写排队、读返回顺序、停钟与协调复位（`wb_cdc_boundary_tb.sv`）；任一侧单独复位或对侧停钟时复位不重放/无 X、丢失读一次 ERR、已发目标拍在源复位后做完且数据丢弃、源放弃读排空、目标复位保持中请求等待（`wb_cdc_reset_tb.sv`）；APB `TIMEOUT` 慢目标不误报、卡死目标 PSLVERR 及耗时、迟到响应排空、FIFO 满时超时写不落地（`wb_apb_timeout_tb.sv`）。
- `test/sync-cell.test.ts`：`wb_sync_cell` 内建与 `AUTOWIRE_SYNC_CELL` 测试 adapter 两种模式下，按 `STAGES` / `WIDTH` / `RESET_VAL` 检查逐位延迟与异步复位值；所选模块缺失时编译失败；CDC 复位与 APB 超时用例在 adapter 上重跑。
- `test/wishbone-master.test.ts`：APB/JTAG/异步 WB 经仲裁和 PIPE 的端到端行为；`test/wishbone-rtl-lint.test.ts` 检查生成 RTL 的 Verilator `-Wall`。这些是仓库回归范围，不构成硅验证或实际 vendor CELL 验证。

demo/soc 接入（JTAG）：`sot/wb_bus_soc.ts` 加 `Master("dbg", …, { jtag: true, pipe: 2 })`（fabric 侧、CDC 之后 2 级 posted 写 pipe）；`rtl/demo_tap.v` 为 **DFT 占位 TAP**（IDCODE / BYPASS / USER=1000 → `dbg_sel`），顶层引出 `jtag_*`，`dbg_en` 绑 1。外部 JTAG 冒烟与 CPU 固件并发（共享 soc_wb 仲裁）：

- `sim/verilator/run.sh`（默认 / `--regfile` / `--sd`）：C++ host `sim/verilator/jtag_host.h` 驱动 `jtag_*`。
- `sim/verilator/run.sh --tb-mod`：aw-tb-mod dump 的 `tb_soc`（`--binary --timing`），SV host `sim/tb_jtag.svh`。
- 序列：IDCODE → IR capture → BYPASS → USER：读 smoke ID、写读 SRAM `0x0000_8000`；两边都过才 PASS。

未做：CDC 工具签核（无开源 CDC 工具）；demo 真实 DFT TAP / SIB 替换 `demo_tap`（留给后续工程检验反馈）。

## 8. 暂时不做

已裁定且已实现：写 **posted**；`wb_cdc` 使用命令/读返回双异步 FIFO，默认可综合实现，也可按 §3.1 选择外部 CELL/adapter；任一侧复位经 `link_rst_n` 复位两向 FIFO，丢失读回 ERR，无自动重试；超时只在 APB 桥（`apb.timeout`，需 cdc）；JTAG **单 DR**、地址宽 = bus `addrWidth`；输出 PDL；无私有 TAP；同步单元可按 §3.2 用宏选择外部 CELL（无 toml 选项）。demo/soc 的 JTAG master 已接入。

等后续需求再追加：

1. 多笔读 outstanding / 带事务 ID 的乱序完成模式（当前读阻塞，写可 posted 排队）。
2. CDC 约束提示的输出格式。
3. ICL CaptureSource 建模与 Tessent / TestMAX 方言差异。
4. demo/soc 再加 APB master 作展示。
5. 用真实 DFT TAP / SIB 替换 demo 的 `demo_tap`。CDC 工具签核不在本仓库。
