# Wishbone Master 接口：CDC / APB / JTAG

> 状态：**已落地**（`Master(..., { apb | jtag | cdc })`、`wb_cdc` / `wb_apb2wb` / `wb_jtag_tdr`、ICL/PDL；demo/soc 已接 JTAG）。§8 暂时不动。  
> 上位约束：[`wishbone-bus.md`](./wishbone-bus.md)（WB Classic 子集、arbiter、`<bus>_bus_cfg` wrapper）。  
> 参考主干：`master:autowire/cfgbus/cfg_apb.py`（`CfgApbBridge`）、`cfg_arbiter.py`（`CfgArbiter`）。  
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
| FIFO 模块 | 外部 `async_fifo` 路径参数；但 `u_apb2cfg_afifo` 硬编码 `M2_ASYNC_FIFO` | 两个 FIFO 名字不一致（缺陷） |
| 仲裁 | `CfgArbiter`：`arb_clk` 单域 round-robin；固定 `RD_PIPE` 读延迟 | 所有 CDC 都在仲裁之前完成——v2 沿用 |
| JTAG | **无**（主干仅 APB） | v2 新增 |

结论：主干「CDC 在 master 口、仲裁/译码单时钟」的分层是对的；v2 **把 CDC 从协议桥里拆出来**，并补齐错误 / 挂死路径。

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
2. **WB Classic 单 outstanding** → **不需要 async FIFO**：四相 **req/ack 握手 + 数据束保持稳定（bundled data）**。只有 `req` / `ack` / `alive` 三个单 bit 走 `wb_sync_cell`；请求束由同步后的 `req` 在目标域重新打拍，应答束由同步后的 `ack` 在源域采样。**禁止**逐 bit 同步数据。
3. 仲裁 / 译码 / regfile **保持单时钟**；fabric（`<bus>_decoder` / `<bus>_interconnect`）生成物 **不变**，全部桥接逻辑在 `<bus>_bus_cfg` wrapper 内。
4. 延迟：每事务约 `2×(2~3)` 个对端时钟的握手往返。配置流量稀，可接受；大批量灌数按 [`wishbone-bus.md`](./wishbone-bus.md) §5.1 走 DMA。

`wb_cdc` 规则（已实现）：

| 场景 | 行为 |
|---|---|
| fabric 在复位（`alive=0`） | 源侧 **立即** `ERR`，不发请求 |
| `TIMEOUT` 个源时钟内无 ack（`TIMEOUT=0` 关闭） | `ERR` 并进入 drain；目标侧仍会把已发出的事务做完（副作用可能已发生） |
| drain 中的新请求 | 立即 `ERR`，直到 `ack` 回落且 `alive=1` |
| 单侧复位打断在飞事务 | 四相 level 协议，两侧回 idle 后自洽；源侧 idle 时见到 `ack=1` 一律 `ERR` |
| 写语义 | **非 posted**：`ACK` = 叶子已应答（v1 无 posted 选项） |
| 同步器 | 全部经 `wb_sync_cell`（行为模型 2FF；签核时换 foundry sync cell，**保持端口不变**） |

错误回报：WB 子集 `ERR` 可选（默认 0）；fabric **不**生成 ERR。`wb_cdc` 源侧出 `s_err`，协议桥映射为 APB `PSLVERR` / JTAG 状态码 / 异步 WB 口的 `{m}_i_wb_err`。

## 4. APB master（`wb_apb2wb`）

- APB3/APB4 completer，`PCLK` 域同步桥；`PSTRB` → `SEL`（读恒 `4'hf`；APB3 请把 `PSTRB` 拉 `4'hf`）；`PADDR` 字节地址 → WB `ADR`。
- `PREADY` 等 WB `ACK/ERR`（非 posted）；`ERR` → `PSLVERR=1`。
- `PPROT` 过滤：`(PPROT & mask) !== value` 时 **立即** `PREADY=1, PSLVERR=1`，不发 WB（修复主干挂死）。缺省 mask=0 全收。
- `cdc: false`（缺省）时桥跑在 fabric `clk`/`rst_n`，wrapper 不出 `{m}_pclk` / `{m}_presetn`，`wb_err` 接 `1'b0`。
- APB **禁止**成为 decoder / regfile 原生口（[`wishbone-bus.md`](./wishbone-bus.md) §4）。

## 5. JTAG master：接入 DFT 全局 JTAG

### 5.1 生成 TDR 仪器，不生成 TAP

- 芯片 TAP（IR、BYPASS、IDCODE、BSR、TLR）由 **DFT 流程拥有**（Tessent / TestMAX 等插入）。IEEE 1149.1 要求对外只有一个合规 TAP；IP 私自带 TAP 会破坏 BSDL / 边界扫描链。
- 插件生成 `wb_jtag_tdr`：IEEE 1149.1 **user-DR 客户端**口形，同时是 IEEE 1687（IJTAG）的 ScanInterface，可挂在芯片 TAP 的 user 指令下，或挂在 SIB 网络里。
- 同时生成 `<bus>_bus_cfg.icl`（ScanInterface / ScanRegister / Alias）与 `<bus>_bus_cfg.pdl`（`<m>_write` / `<m>_read`：launch → `iRunLoop idle -tck` → 轮询 `st`）。ICL **未**建模 CaptureSource（捕获值来自内部状态），接入前 **应当**由 DFT 评审方言差异。
- 私有 TAP：v1 **不**提供。

### 5.2 端口（TCK 域）

| 端口 | 方向 | 说明 |
|---|---|---|
| `{m}_tck` | in | TCK；同时是该 master `wb_cdc` 的源时钟 |
| `{m}_trst_n` | in | TAP Test-Logic-Reset 派生复位（1687 `ResetPort`，低有效）；**只**复位 TDR 与 `wb_cdc` 源侧，**不**复位 fabric |
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
- err 来源：WB `ERR`（fabric 复位 / 超时）、`en=0`、busy 时丢弃。空闲时一次 **nop 的 Update-DR 清 err**（其 Capture-DR 已先读出 err）。
- 应答经同步器回到 TCK 域 **需要 TCK 沿**：两次扫描之间插入 N 个 Run-Test/Idle（PDL `iRunLoop`，`Master(..., { jtag: { idle } })`，缺省 16）；不足则读到 busy 再轮询。
- JTAG `wb_cdc` 缺省 `TIMEOUT=0`（busy 可观测，由软件轮询决定放弃）；需要硬超时可设 `timeout`。

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
      apb: { pprot: { value: 0b000, mask: 0b001 } },                  // mask 缺省 0b111
      cdc: true,
      timeout: 64,                                                    // 源时钟周期；0 = 关
    }),
    Master("dbg", "DFT JTAG", { jtag: { idle: 16 } }),                // jtag 恒 cdc
    Master("wbx", "async WB", { cdc: true }),                         // 异步 WB 口
  ],
  // ...
});
```

- `apb` / `jtag` 互斥；`jtag` + `cdc: false` 报错；`timeout > 0` 需要 cdc。
- 级联面（`child.uplink(name?)` 选出的 master 口）**禁止**带 apb/jtag/cdc；`Bus` 拒绝重名 master。
- 有任一桥接 master 时 generate **必须**打 `<bus>_bus_cfg`；fabric 上该 master 的 WB 口在 wrapper 内接 `{m}_fab_*`，协议桥源侧接 `{m}_src_*`。connect HTML 只看到：

| 形态 | wrapper 口 |
|---|---|
| APB | `{m}_pclk` / `{m}_presetn`（仅 cdc）、`{m}_paddr` / `psel` / `penable` / `pwrite` / `pwdata` / `pstrb` / `pprot` → `{m}_prdata` / `pready` / `pslverr` |
| JTAG | §5.2 |
| 异步 WB | `{m}_clk` / `{m}_rst_n`、`{m}_o_wb_*`（含 tga）→ `{m}_i_wb_dat` / `ack` / `err` |

- TGA：异步 WB 口透传 `{m}_o_wb_tga`；APB / JTAG 桥把 tag 接 0。
- 公共模块：任一 bus 有桥接 master 时，`plugins_dir/wishbone/` 额外出 `wb_sync_cell.sv`、`wb_cdc.sv`、`wb_apb2wb.sv`、`wb_jtag_tdr.sv`（模板在 [`rtl/`](./rtl/)，与 `wb_cfg_pipe` 同纪律）；有 JTAG master 的 bus 另出 `<bus>_bus_cfg.icl` / `.pdl`（非 SV，不进 filelist）。
- 单 master（NM=1 → decoder）同样适用：桥 / CDC 在 decoder 前。

## 7. 验证

`test/wishbone-master.test.ts`（Verilator `--binary --timing`，`test/fixtures/wb_master_tb.sv`；runner `test/fixtures/verilator.ts`）：fabric 10ns / PCLK 14ns / 异步 WB 6ns / TCK 50ns，四个 master 共享一个 TB 存储 slave：

- 同域 WB、APB（字节写、PPROT 违例 → PSLVERR 且不写、叶子卡死 → 超时 PSLVERR 后恢复）、异步 WB 读写。
- JTAG 写 / 读、busy 状态、busy 时丢弃 op → sticky err → nop 清除、`en=0` → err 且不写。
- fabric 复位中：APB / 异步 WB / JTAG 全部立即报错不挂死；复位释放后恢复。
- 四个 master 并发经仲裁写不同窗口后逐字校验。

demo/soc 接入（JTAG）：`sot/wb_bus_soc.ts` 加 `Master("dbg", …, { jtag: true, pipe: 2 })`（fabric 侧、CDC 之后 2 级 posted 写 pipe）；`rtl/demo_tap.v` 为 **DFT 占位 TAP**（IDCODE / BYPASS / USER=1000 → `dbg_sel`），顶层引出 `jtag_*`，`dbg_en` 绑 1。外部 JTAG 冒烟与 CPU 固件并发（共享 soc_wb 仲裁）：

- `sim/verilator/run.sh`（默认 / `--regfile` / `--sd`）：C++ host `sim/verilator/jtag_host.h` 驱动 `jtag_*`。
- `sim/verilator/run.sh --tb-mod`：aw-tb-mod dump 的 `tb_soc`（`--binary --timing`），SV host `sim/tb_jtag.svh`。
- 序列：IDCODE → IR capture → BYPASS → USER：读 smoke ID、写读 SRAM `0x0000_8000`；两边都过才 PASS。

未做：CDC 工具签核（无开源 CDC 工具）；demo 真实 DFT TAP / SIB 替换 `demo_tap`（留给后续工程检验反馈）。

## 8. 暂时不做

已裁定且已实现：写 **非 posted**；`wb_cdc` v1 **只做握手**；JTAG **单 DR**、地址宽 = bus `addrWidth`；输出 PDL；v1 无私有 TAP；同步单元为可替换壳（无 toml 选项）。demo/soc 的 JTAG master 已接入。

等后续需求再追加：

1. posted 写 / async FIFO 模式（多笔写吞吐）。
2. CDC 约束提示的输出格式。
3. ICL CaptureSource 建模与 Tessent / TestMAX 方言差异。
4. demo/soc 再加 APB master 作展示。
5. 用真实 DFT TAP / SIB 替换 demo 的 `demo_tap`。CDC 工具签核不在本仓库。
