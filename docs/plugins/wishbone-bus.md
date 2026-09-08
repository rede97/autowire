# Wishbone 块内配置总线（bridge / arbiter / decoder）

> 状态：**草稿，先约束后实现**。不堵连接轨道。  
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

端点命名可与 `demo/soc` 对齐（`i_wb_*` / `o_wb_*`）：

| 信号 | 方向（slave） | 要求 |
|---|---|---|
| `CYC` | in | 事务周期；单拍外设 **可以**与 `STB` 同断言 |
| `STB` | in | 本拍有效 |
| `WE` | in | 1=写，0=读 |
| `ADR` | in | 字节或字；实现 **必须**与 regfile 同一裁定 |
| `DAT_O` | in | 写数据；默认 32 |
| `SEL` | in | 字节选通 |
| `ACK` | out | 完成；可晚于 `STB`（stall） |
| `DAT_I` | out | 读数据；与读 `ACK` 同拍有效 |
| `ERR` | out | 可选；默认 0 |
| `RTY` | — | **禁止**（本子集不实现） |

规则：

1. Master 在 `ACK` 前 **禁止**发下一拍。  
2. 写完成 = `ACK`（**禁止**用读 vld 冒充）；读完成 = `ACK` + `DAT_I`。  
3. **禁止** v1 端点使用 Pipelined `STALL`。  
4. **禁止**再引入第二套 cfg 内核信号名。

## 3. 长路径 pipe（register slice）

Pipe 是 **互联属性**，不是第二种总线。

```text
Master ──req──▶ [slice × N] ──▶ Decoder / Regfile
       ◀─rsp──  [slice × N] ◀── ACK / DAT_I
```

| 前向 | 返回 |
|---|---|
| `CYC`, `STB`, `WE`, `ADR`, `DAT_O`, `SEL` | `ACK`, `DAT_I`, 可选 `ERR` |

1. 前向与返回级数 **必须**相同（`PIPE_NUM`，默认 0）。  
2. `CYC` 贯穿整笔；slice **禁止**拆事务。  
3. 单 outstanding ⇒ **不必**事务标签。  
4. **可以**「先 slice 再译码」或「译码后每支路再 slice」。

## 4. 拓扑：默认 tree，不是 matrix

| | **树（默认，必须支持）** | **Matrix / crossbar（可选，非默认）** |
|---|---|---|
| 形态 | arbiter → decoder 树 → 叶子 | M×N 交叉 |
| 适用 | IP 内 cfg、稀流量 | 少数 master **并发**打不相交窗口且 N 很小 |
| 与旧 Python | 同构 | 新路径，慎用 |

- Decoder：地址窗 + 可选 broadcast；下行仍是 WB（`STB` 扇出，`ACK`/`DAT` 回并）。  
- Arbiter：多 WB master；默认策略实现前钉死（开放项）。  
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
- 生成编排 **可以**同一 plugin id 一次打出 arb+decoder+regfile，或分插件；connect 侧一律 `aw-inst` 例化。  
- 地址图数据在 Table/端口模型里；**禁止**把 pin 级连线写进 `autowire.toml`。

## 7. 工作区（草案）

```toml
[regfile.phy.bus]
topology = "tree"     # 默认；crossbar 仅显式开启
pipe = 1
# arbiter = "fixed" | "round_robin"   — 开放项
```

## 8. 仍开放

1. Arbiter 默认策略。  
2. 是否提供 `topology = crossbar` 以及 M/N 上限。  
3. 地址字节 vs 字（与 regfile 同时钉死）。  
4. Bridge 目录：仅 `apb2wb` 还是可插其它。  
5. 固件窗 + DMA：块周期连续写是否进 v2；是否生成最小 WB DMA master。

裁定后改本文 + [`wishbone-regfile.md`](./wishbone-regfile.md) + `help status` Parallel，再动代码。
