# 实战：用 fsm DSL 写一个 IP 的控制状态机

> 来源：UCIe PHY 的 RDI 控制逻辑迁移（`klxip_uciephy_v1_ss4_48g_ns_ap`，`tools/autowire/sot/fsm/`）。原来是 4 个手写模块（约 1850 行），改成 3 个 `.mjs`（约 850 行），生成 5 个 `.sv`。DSL 规则以 [`../state/async-fsm.md`](../state/async-fsm.md) 和 `help fsm` 为准；本文只记录在真实 IP 里证明可行的组织方式、命名方式和踩过的坑。

## 1. 流程

```text
plugin wishbone run   →  regfile（RWW 字段给状态机写）
plugin fsm run        →  vmod/<ip>/fsm/*.sv（[plugins.fsm] dir 写进 RTL 树）
analysis run          →  RtlIndex（生成的 _wrap 模块是叶子）
connect run / check   →  例化 _wrap、接 regfile
dtsim regr <group>    →  回归；-d <label> 另开目录，不覆盖别人正在跑的 regression
```

- 改了 Wishbone SoT 先跑 `plugin wishbone run`；改了 `.mjs` 跑 `plugin fsm run`；两者都要在 `analysis run` 之前。
- IP 仓库里放的是单文件 `autowire.js`（`bun run build:js`）。生成器有改动时，先重建它，再用它重新生成，确认 `fsm: outputs unchanged` 后再提交。

## 2. 源码组织

| 文件 | 内容 | 输出 |
|---|---|---|
| `rdi_types.mjs` | 全部编码：`@SvEnum`（状态码、LTSM 操作、错误类型、LinkMgmt 码、中断位），一个空的 `@FsmGroup({ file: "dphy_rdi_fsm_pkg" })` | `dphy_rdi_fsm_pkg.sv` |
| `rdi_ctl.mjs` | 几台小状态机（LinkMgmt 收发记录、PM 应答、时钟握手） | `[fsm.rdi_ctl] split = true`：每台一个 `.sv` |
| `rdi_sm.mjs` | 主流程 | `@FsmGroup({ file: "dphy_rdi_sm" })` |

- **一个 package 装全部编码**：每台状态机写 `@Fsm({ pkg: "dphy_rdi_fsm_pkg", statePrefix: "SM" })`，状态 enum 和 `action_t` 都进这个 package，TB、手写叶子和其他工具只 import 它一个。共用 package 时 `statePrefix` 必写（`SM_` / `LM_` / `PM_` / `CLK_`），否则 `IDLE` 这类名字重名，编译报错。
- **手写的定义 package 可以删掉**：原 `dphy_rdi_def_pkg` 的 enum 全部改成 `@SvEnum`。`@SvEnum` 只生成 enum，不生成 `localparam`：要个数时在用到的模块里由最后一个成员算（`localparam int unsigned RDI_INTR_NUM = int'(RDI_INTR_ACT_PEER_REQ) + 1;`）；TB 需要的别名在 TB 里定义（`localparam logic [3:0] RDI_REQ_NOP = RDI_RESET;`）。
- **filelist 顺序**：package 文件在最前，然后是各状态机文件。拆分（`split`）或改 `file` 之后，旧的 `.sv` 不会自动删除：手动删掉，并同步 filelist。

## 3. 和连线器、regfile 对接

- **每台 `@Fsm` 写 `wrap: true`**。连线器只认 `logic` 端口，connect HTML 例化 `<模块名>_wrap`；EDA 仍从原模块识别状态机。手写叶子的端口也用 `logic`，不用 enum。
- **Adapter / 硬件拥有的输出做成 regfile 的 RWW 字段**，状态机里声明成 `Dff(N, { external: true })`，生成 `<名字>_set` / `<名字>_next`（从不读 `.val` 时没有 `_val` 输入）。connect HTML 用 rewrite 接到 regfile：

  ```html
  <aw-rewrite match="^(rdi_\w+)_set$" to="rg_$1_strb"></aw-rewrite>
  <aw-rewrite match="^(rdi_\w+)_next$" to="rg_$1_hwdata"></aw-rewrite>
  <aw-rewrite match="^(rdi_\w+)_val$" to="rg_$1"></aw-rewrite>
  <aw-rewrite match="^state_(set|next)_o$" type="open"></aw-rewrite>
  ```

  RWW 字段软件也能写：总线写会写整个寄存器，所以软件必须读-改-写，文档里要写清楚。
- **状态上报**：`exportState: true`，`state_val_o` 接 RO 字段；不用的 `state_set_o` / `state_next_o` 在 connect 里 `type="open"`。`exportAction` 只在确实有外部消费者时打开，而且在 `_wrap` 上它是没有成员名的向量；需要事件时优先用有名字的口（例如 `rdi_if_pl_state_sts_set`）或专门的 `Output.pulse()`。

## 4. 进程拆分与写法

- **主流程一台，常驻的监视 / 应答拆成小状态机**，之间只走端口和 channel。原来 `sm_drv` 里"一直在跑"的逻辑（对端请求记录、PM 应答、时钟握手）各自成为一个进程，主流程用 `push` 发请求、用 `Dff` 端口给许可（`sm2lm_allow_*`、`sm2pm_claim`）。
- **可复用的步骤写成子状态机**：`ltsm_do`（发 LTSM 操作、等目标状态）、`entry_hs` / `exit_hs`（握手）。调用标签就是状态名前缀（`RESET_LTSM: await this.ltsm_do({...})` → `SM_RESET_LTSM_ISSUE`）。
- **一组固定的写入写成同步方法**：不带 `async` 的组方法，作为语句调用（`this.revoke_grants({...});`），不增加状态。比一串 `.set(0)` 好读，生成的 RTL 不变。
- **中止优先级用 `try` / `Escape` 的嵌套表达**：最外层是软件模式停放，然后是 LinkError，再里面是 Disabled / LinkReset。不要在每个状态里写一遍中止条件。
- **所有控制逻辑放在一个时钟上**（RDI 放在 `plclk_div`）。时钟变慢时，TB 的等待预算和计时器的计数要一起换算。

## 5. 命名

- **状态标签写成描述性的 UPPER_SNAKE**，按区域加前缀：`RESET_*`、`ACTIVE_*`、`RETRAIN_*`、`ABORT_*`、`LINK_ERROR_*`；子状态机内部用短而通用的标签（`ISSUE` / `WAIT_TARGET`、`SEND_REQ` / `WAIT_RSP`），展开后由调用标签区分。
- **状态做的事写进名字**：`*_CLR_SBMSG`（清本轮 sideband 消息记录）比 `*_CLEAR_RECORDS` 更具体。
- **局部名不要过度缩写**：`const` 会生成同名的线，波形里直接看到。`want_disable` / `want_link_reset` / `want_retrain` / `fatal_cause` / `exit_target` 好过 `want_dis` / `want_lr` / `rt_want` / `cause` / `tgt`；`Dff` 同理（`retrain_from_l1`、`resume_link_error`）。
- **端口按方向和对端命名**：`sm2lm_*`、`lm2sm_*`、`if2sm_*`、`rg_*`（regfile），与手写叶子的惯例一致。

## 6. 验证

- 生成后先对每个 `_wrap` 跑 Verilator `--lint-only -Wall`（带上 package 文件），再跑回归。
- TB 读主状态：`dut.<...>.u_<模块>.state_val`，类型 `dphy_rdi_fsm_pkg::dphy_rdi_sm_state_e`，比较用带前缀的成员（`dphy_rdi_fsm_pkg::SM_RETRAIN_WAIT_ACTIVE_REQ`）。封装成 `sm_state()` / `wait_sm_state(state, budget, what)` 两个 helper，用例里只按状态名写。
- **协议规则要有反向用例**：例如 Retrain 结束必须先 NOP 再 Active。只测正向路径时，漏掉 NOP 门控也能通过；反向用例是"不给 NOP 直接给 Active，状态机停在等待状态、`pl_state_sts` 不变"。
- 改名、拆文件、换 package 这类重构，最好让生成的 RTL 逐字节不变（例如抽同步方法）；变了就跑完整回归。

## 7. 坑

| 现象 | 原因 / 做法 |
|---|---|
| 连线器报不支持的端口类型 | 例化了原模块而不是 `_wrap`，或手写叶子用了 enum 端口 |
| package 里名字重复 | 几台状态机共用 `pkg` 却没写 `statePrefix` |
| 旧的 `.sv` 还在 filelist 里 | `split` / `file` 改了以后要手动删旧文件、改 filelist |
| IP 仓库里重新生成结果和开发版不同 | `tools/autowire/autowire.js` 没重建 |
| 软件写 RWW 寄存器后 helper 拥有的字段被清掉 | 总线写覆盖整个寄存器；软件读-改-写 |
| 改了 DSL 动作，外部依赖的 `action.*` 成员消失 | 只依赖 `enter_<S>`（`exportAction` / `exportState` 会强制生成），不依赖 `leave_*` / `A_to_B` / `keep_*` |
