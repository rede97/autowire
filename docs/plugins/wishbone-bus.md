# Wishbone 块内配置总线（bridge / arbiter / decoder）

> 状态：**implementing now**（最小 decoder/interconnect + named slaves + 生成 `wb_cfg_pipe`；arb 策略后补）。不堵连接轨道。  
> 寄存器叶子：[`wishbone-regfile.md`](./wishbone-regfile.md)。  
> 插件登记：[`README.md`](./README.md)。改本文时同步 `help status` / [`../architecture.md`](../architecture.md) §5。

关键字「必须 / 应当 / 可以」按 RFC 2119。

## 1. 目标与边界

为 **IP / 子系统内部** 配置通路生成 Wishbone Classic 互联：

```text
[可选 bridge，如 apb2wb]
      →  Arbiter（多 master → 一下行）
      →  Decoder 树（地址窗 → 子 decoder / RegfilePort）
      →  Regfile 叶子（见 wishbone-regfile.md）
```

- **默认拓扑必须是树**（bridge + arbiter + decoder），**禁止**把全互连 matrix 当默认生成物。  
- **单 outstanding**（与 §2 一致）；配置流量稀，不靠 crossbar 换吞吐。  
- **SoC 级系统互联**（AXI/NoC/商业 fabric）**禁止**纳入本插件范围——交给专业 interconnect EDA；本插件只在 IP 边界提供 WB（或可选 APB）口以便挂接。  
- IP 内部 **没有必要**上商业 NoC/matrix；一层 arb + 地址树即可。

## 2. Wishbone Classic 子集（冻结）

端点命名（与 regfile 同裁，**带 name**）：

| 角色 | 口名 |
|---|---|
| Regfile / IC slave | **`{name}_i_wb_*` / `{name}_o_wb_*`**（叶视角；与 `RegfileDef.name` **同名 → identity**；异名束用一条 rewrite，见 connect §3.5.5） |
| 多主（interconnect） | **`{master}_o_wb_*`**（master 驱动：ADR/DAT_O/SEL/CYC/STB/WE/+TGA）/ **`{master}_i_wb_{dat,ack}`**（master 接收）；单主 decoder 仍 flat `m_*` |

  > **命名空间**：master 口与 slave 口共享 `{name}_*_wb_*` 空间；同一叶子**双角色**（既是 master 又是 slave，如 DMA 引擎 + 其 CSR 口）时两个角色**必须**取不同名（demo：`dma0` = CSR slave / `dma0m` = 引擎 master），否则 `o_wb_dat`/`i_wb_dat` 撞网。
| clk/rst | `clk` / `rst_n`（fabric） |

例：`smoke_i_wb_cyc`、`smoke_o_wb_ack`、`smoke_i_wb_adr`。

| 信号 | 方向（slave / 叶） | 要求 |
|---|---|---|
| `CYC` | in | 事务周期；单拍外设 **可以**与 `STB` 同断言 |
| `STB` | in | 本拍有效 |
| `WE` | in | 1=写，0=读 |
| `ADR` | in | 位宽 = 叶子必填 `addr_width`；**字节地址**（与 [`wishbone-regfile.md`](./wishbone-regfile.md) §5.6 **同裁：byte**） |
| `DAT_O` | in | 写数据（master→slave）；**固定 32**；端口**最终名**随 regfile §5.4 前缀方案 |
| `SEL` | in | 字节选通；**固定 4**（随 DAT=32） |
| `ACK` | out | 完成；regfile 叶子 **同拍** ACK（[`wishbone-regfile.md`](./wishbone-regfile.md) §5.5）；fabric **pipe** 可整体推迟；RWE+`read_write_block` 可拖 ACK |
| `DAT_I` | out | 读数据；**固定 32**；与读 `ACK` 同拍有效 |
| `ERR` | out | 可选；默认 0 |
| `RTY` | — | **禁止**（本子集不实现） |
| `TGA` / `TGC` / `TGD` | 随事务 | **可选** user tag。Regfile shadow **仅**用 **`wb_tga`（TGA）**（[`wishbone-regfile.md`](./wishbone-regfile.md) §5.7；**无** local/takeover）。启用 TGA 时 arb/decoder/pipe **必须**透传；未用可省略 |

规则：

1. Master 在 `ACK` 前 **禁止**发下一拍。  
2. 写完成 = `ACK`（**禁止**用读 vld 冒充）；读完成 = `ACK` + `DAT_I`。  
3. **禁止** v1 端点使用 Pipelined `STALL`。  
4. **禁止**再引入第二套 cfg 内核信号名。  
5. Tag 位语义由 **叶子 / 系统约定**解释（如 shadow 切片）；互联 **只透传、不解释**。
6. **TGA 建模（已裁定）**：`Bus(..., { tagWidth? })` = fabric tag 位宽（缺省 = 各 slave `tag` 最大值，皆无则 0 = 不出 TGA 口）；`Slave(name, desc, base, mask, tag? | { tag?, pipe? })` 声明该 slave 透传的 tag 位宽（必须 ≤ bus `tag_width`）。启用时：decoder 出 `m_tga_i`；interconnect 出 `{master}_o_wb_tga`；仲裁 **必须** 随 grant 透传到 `g_tga`。无 pipe 的 slave：`{slave}_i_wb_tga = g_tga[tag-1:0]`（不随 slot_sel 屏蔽，由 CYC/STB 限定事务）。有 pipe 的 slave：例化 `wb_cfg_pipe`；`TW = Slave.tag`。模块 **始终** 带 `m_tga` / `s_tga`；`TW=0` 时例化 **不连** 这两口。`TW>0` 时模块内 `{m_tga, m_adr}` 进 beat，叶口再拆。
7. **Decode 槽位名**：生成 `localparam SLOT_<SLAVE>`（slave 名大写，从 0 起）；`slot_sel` 下标与 one-hot 赋值 **必须**用该名（`slot_sel[SLOT_SD1]`、`slot_sel = NS'd1 << SLOT_SD1`），**禁止**裸十进制下标。

## 3. 长路径 pipe（写 posted / 读阻塞）

Pipe **内建**在 decoder / interconnect 的 **slave 口**上：`plugin generate` 写出通用模 [`wb_cfg_pipe`](./rtl/wb_cfg_pipe_template.sv) → `plugins_dir/wishbone-bus/wb_cfg_pipe.sv`，每口 PIPE>0 例化一次。connect **不必**例化 `wb_cfg_pipe`。

### 3.1 谁配置

| 侧 | 配置 |
|---|---|
| **Slave** | `Slave(name, desc, base, mask, { pipe: N, tag? })`；`N=0`（缺省）= 组合直通；`N>0` = 本口插入 N 级打拍（1..16） |
| **Master** | **本模块不配**。上一级 fabric 已在其 slave 口（即本模块 master 的对端）插入 pipe |

第五参仍可写数字：`Slave(..., 2)` = `tag=2`（兼容）；pipe 必须走 options 对象。

### 3.2 协议（对齐 [`rtl/wb_cfg_pipe_template.sv`](./rtl/wb_cfg_pipe_template.sv)）

| 操作 | 入口 ACK | 行为 |
|---|---|---|
| **写** | `m_cyc & m_stb & !pipe[1].stb`（下一级空） | posted；不要求已落到叶子 |
| **读** | `m_cyc & m_stb & pipe[1].ack` | **全程阻塞**，等叶数据返回 |

```text
[0] comb ← grant/decode
[1 .. PIPE] FF stages
[PIPE] → {slave}_i_wb_*
[PIPE+1] comb tap（不是请求拷贝）
```

- `[PIPE+1].ack = s_stb & s_ack & !s_we`（**仅读返回**）；`[PIPE+1].stb = s_stb & !s_ack`（叶尚未接受）。  
- 写从末级卸载：`we & !next.stb`（叶 ACK 使 tap `.stb=0`）。**禁止**把写 ACK 放到返回路径。  
- Classic 主机在 ACK 拍仍持 STB：空级不回灌完成中的读（`prev.stb && (we || !ack) && !self.ack`）。  
- 因此注册级 `ack <= next.ack` 即可，不必再 `& !we`（叶口已拦截）。  
- 叶口 `CYC` = **pipe 占用**，不是 master 当前 CYC（posted 后 master 可撤 CYC）。  
- TGA：`wb_cfg_pipe` **始终**带 `m_tga`/`s_tga`；`TW>0` 时入口 `{tga, window_adr}`，出口再解。`TW=0` 时例化省略这两口（`TW=0` 打包路径不读 `m_tga`）。  
- `PIPE=0`：跳过 pipe，组合直通（与今日行为相同）。  
- 生成 RTL：一份 `wb_cfg_pipe`（参数 `PIPE`/`AW`/`TW`）；级间 `for (genvar …)` 交给综合器展开。Icarus 不能对结构体数组做 `q[i].field`：级寄存整拍 `q[i] <= nxtq`；入口旁路 `pipe_q1 = q[1]`；叶口 `pipe_h = q[PIPE]` 再拆字段。comb 口 `pipe_m`/`pipe_s` 与 FF 数组拆开。  

范本审逻辑用 [`rtl/wb_cfg_pipe_template.sv`](./rtl/wb_cfg_pipe_template.sv)；generate 拷到 `plugins_dir`，decoder/IC **例化**该 module。

**RWE + `read_write_block`**：见 regfile §；缺省 `false`；posted 下打开有锁死总线风险。

### 3.3 透明 register slice（备选，仅换时序）

仅打拍、不改完成语义（前向/返回级数相同，ACK 仍表示叶完成）时可用对称 FF slice；与上表 **写 posted** 不同，二者勿混称为同一种 pipe。

## 4. 拓扑：默认 tree，不是 matrix

| | **树（默认，必须支持）** | **Matrix / crossbar（可选，非默认）** |
|---|---|---|
| 形态 | arbiter → decoder 树 → 叶子 | M×N 交叉 |
| 适用 | IP 内 cfg、稀流量 | 少数 master **并发**打不相交窗口且 N 很小 |
| 与旧 Python | 同构 | 新路径，慎用 |

- Decoder：地址窗 + 可选 broadcast；下行仍是 WB（`STB` 扇出，`ACK`/`DAT` 回并）。  
- Arbiter：多 WB master；口 `rb_grant_en`：**0** = 固定优先级（最低 master 下标胜）；**1** = round-robin（上次 grant 之后的下一个请求者，绕回最低下标）。事务中 `CYC` 锁定 grant。demo/soc：`smoke` `FABRIC.rb_grant_en`（复位 0）驱动 `u_ic.rb_grant_en`；`basic_smoke` 打开后双 DMA 并发 SRAM KAT。  
- Bridge：仅边界协议转换（如 `apb2wb`）；**禁止**让 APB 成为 decoder/regfile 原生口。  
- 即便将来提供 `topology = crossbar`，slave 侧 **仍必须**有地址窗/选通；matrix **不能**取消译码职责。

## 5. IP 内 vs SoC interconnect

| 层级 | 谁做 |
|---|---|
| IP / 子系统 **配置树**（本文） | autowire **生成器插件** |
| 块内简单点对点 / 功能口 | 手写或 connect 例化 |
| SoC **系统互联**（AXI/NoC/商业 crossbar） | **专业 interconnect EDA**；本插件只导出标准 WB/桥接口供挂接 |

**禁止**在本插件内实现 QoS、多 outstanding NoC、多协议系统 fabric。

### 5.1 固件窗 + DMA / 连续写（后期，非 v1）

大量固件 **不应当**走逐字段 CSR 启动（CPU 一拍一拍 poke 会拉长 init）。**应当**：

| 路径 | 用途 |
|---|---|
| CSR regfile | 控制/状态、少量 mailbox |
| **Firmware memory 窗** | SRAM/ROM 映射在 decoder 下一扇 **整窗 slave**（非 Cell 阵列） |
| **DMA（WB master）** | 从片外/SoC 一次灌窗；显著缩短 IP 启动配置 |

**Wishbone Classic 能否连续写？能。** 不必上 Pipelined B4：

- **块周期（block cycle）**：`CYC` 拉高，多拍 `STB`→`ACK`，地址递增（或 DMA 自己加地址）。单 outstanding 仍可：**一拍一 ACK，但 CYC 不断**，slice/arb 比「每字拆开 CYC」便宜。  
- **DMA master**：内部突发源数据，对外仍是连续 Classic 写；IP 启动时间由存储器带宽与 DMA 决定，不由「寄存器译码」决定。  
- **真正 burst-in-flight / STALL**：Pipelined Wishbone，**后期可选**；v1 端点仍禁止 `STALL`。固件灌装用块周期 + DMA 通常够。

纪律（后期做时仍必须遵守）：

1. 固件窗 **禁止**当 Table 里数千寄存器生成。  
2. DMA 是 **WB master** 挂在 arbiter 上（与 CPU 口仲裁）；**禁止**为灌固件改成 SoC 级 matrix。  
3. 启动完成后 **可以**锁窗（CSR 控制写保护）。  
4. 跨时钟灌数走 DMA+CDC，不要靠拉长 CSR pipe。

v1 **只预留**：decoder 上的 **memory range / opaque slave 口**（不生成 RAM 内容）。DMA 与块周期连续写 **可以**作为同一插件的后期项。

## 6. 与 regfile 插件的关系

- 协议子集与 pipe **以本文为准**；叶子口 **必须**遵守。  
- 生成编排 **可以**同一 plugin id 一次打出 arb+decoder+regfile，或分插件；每个生成模经 **analysis → RtlIndex 普通叶子**；connect 侧一律 `aw-inst` 例化（**禁止**插件树私有口表向上递推）。  
- 地址图数据在 Table/端口模型里；**禁止**把 pin 级连线写进 `autowire.toml`。  
- 产物进 `plugins_dir/<plugin-id>/`；与 connect/sim dump 目录分家（[`README.md`](./README.md) §3）。

## 7. 工作区

```toml
[bus.soc]
ts = "bus/soc_wb.ts"
# exports = ["soc_wb"]   # 可选；省略 = 全部 BusDef

# out → plugins_dir/wishbone-bus/wb_cfg_pipe.sv
#                      + <name>_decoder.sv | <name>_interconnect.sv
# NM<=1 → decoder；NM>1 → interconnect（priority arb + named slaves）
# demo/soc：各 slave PIPE 不等长（0/1/2/3/4）；跨 slave 的 posted 写后固件读屏障
#           smoke FABRIC.rb_grant_en（复位 0）驱动 interconnect rb_grant_en
```

## 8. 仍开放

1. Arbiter 更多默认策略（v1：`rb_grant_en` 固定 / 轮转已落地；其它策略后补）。  
2. 是否提供 `topology = crossbar` 以及 M/N 上限。  
3. Bridge 目录：仅 `apb2wb` 还是可插其它。  
4. 固件窗 + DMA：块周期连续写是否进 v2。  
5. 默认 slave `pipe`（现缺省 0；作者按口配置）。  
6. **软件地址图**（C overlay / `uvm_reg_block` map）：由本插件组装 `Slave(base)` 窗 + 身份匹配 regfile 的 cell 相对 offset + TGA/shadow tag。regfile 插件的 C/`uvm_reg` **只**出字段 layout（见 [`wishbone-regfile.md`](./wishbone-regfile.md) §6.1）。

**已裁定口名**：slave `{name}_i_wb_*` / `{name}_o_wb_*`；interconnect master `{master}_o_wb_*` / `{master}_i_wb_{dat,ack}`；单 master → decoder（flat `m_*`）。
