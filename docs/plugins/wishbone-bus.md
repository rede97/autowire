# Wishbone 块内配置总线（bridge / arbiter / decoder）

> 状态：**已落地**（decoder / interconnect、named slaves、`wb_cfg_pipe`、region broadcast、`plugin wishbone run`）。§8 的开放项暂时不动，等后续需求再追加。  
> 寄存器叶子：[`wishbone-regfile.md`](./wishbone-regfile.md)。  
> 插件登记：[`README.md`](./README.md)。改本文时同步 `help status` / [`../architecture.md`](../architecture.md) §5。

关键字「必须 / 应当 / 可以」按 RFC 2119。

## 1. 目标与边界

为 **IP / 子系统内部** 配置通路生成 Wishbone Classic 互联：

```text
[可选 master 面：wb_apb2wb / wb_jtag_tdr → WB → wb_cdc，见 wishbone-master.md]
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

  > **命名空间**：master 口与 slave 口共享 `{name}_*_wb_*` 空间；同一叶子**双角色**（既是 master 又是 slave，如 DMA 引擎 + 其 CSR 口）时两个角色**必须**取不同名（demo channel：`dma` = CSR slave / `eng` = 引擎 master），否则 `o_wb_dat`/`i_wb_dat` 撞网。
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
6. **TGA 建模（已裁定）**：有 `tags` 时位宽由各域拼出来，见 §2.1。没有 `tags` 时，`Bus(..., { tagWidth? })` 仍是 fabric tag 位宽（缺省 = 各 slave `tag` 最大值，皆无则 0 = 不出 TGA 口）。`Slave` / `SlaveRegion` 的 `tag? | { tag?, pipe? }` 声明该 slave 透传的 tag 位宽（必须 ≤ bus `tag_width`）。`SlaveRegfile` 的 `tag` 缺省 = 叶子 `tga_width` 且 **必须**相等。启用时：decoder 出 `m_tga_i`；interconnect 出 `{master}_o_wb_tga`；仲裁 **必须** 随 grant 透传到 `g_tga`。无 pipe 的 slave：`{slave}_i_wb_tga = g_tga[tag-1:0]`（不随 slot_sel 屏蔽，由 CYC/STB 限定事务）。有 pipe 的 slave：例化 `wb_cfg_pipe`；`TW = Slave.tag`。模块 **始终** 带 `m_tga` / `s_tga`；`TW=0` 时例化 **不连** 这两口。`TW>0` 时模块内 `{m_tga, m_adr}` 进 beat，叶口再拆。
7. **Decode 槽位名**：生成 `localparam SLOT_<SLAVE>`（slave 名大写，从 0 起）；`slot_sel` 下标与 one-hot 赋值 **必须**用该名（`slot_sel[SLOT_SD1]`、`slot_sel = NS'd1 << SLOT_SD1`），**禁止**裸十进制下标。

### 2.1 Tag 域：分配 / 来源 / 透传

> 状态：**已落地**（`ShadowDomain`、`tags`、`TagFromAddr` / `TagFromPin` / `TagFromReg`；`src/plugins/wishbone-bus/dsl.ts`，`test/wishbone-tag.test.ts`）。没有 `tags` 的总线仍走 §2 规则 6 的 `tagWidth`。

现状的问题：`Shadow(name, copies, tagBits)` 写在 `RegfileDef` 里。多个表共用同一 shadow（HBM：16 channel × `aword`/`dword*`）时要抄 N 份，且每份各自声明 `"1:0"`——跨表位置是否同义 **无人校验**（今天只校验 `Slave.tag === 叶子 tga_width`）。

拆成三层，各管一件事：

| 层 | 归属 | 管什么 |
|---|---|---|
| **`ShadowDomain(name, copies, width)`** | 独立 `.ts` 共享导出（与 `RegfileDef` / `BusDef` 同级，互相 import） | 域的**唯一定义**：名字、拷贝数、位宽 |
| **`Bus(..., { tags })`** | fabric | 该总线 TGA 的**拼接顺序**与每个域的**来源** |
| **Cell `.shadow(domain)`** | regfile 叶子 | 哪些 cell 被复制；**per-copy `reset`**（如各 pstate 的频点）仍留在各表 |

域定义只有一处，`copies` / 位宽不再在每张表里重复；叶子只声明「我被这个域复制」。

**来源写法**：`tags` 数组里 —— **裸写域名 = 透传（从 uplink 继承）**，**套 `TagFrom*` = 在本层产生**。

| 写法 | 语义 |
|---|---|
| `pstate` | 透传：本层不产生；值来自 `Master("uplink")`（或普通 master 口）的 TGA |
| `TagFromAddr(pstate, "31:30")` | 从地址最高位产生；剩下的低位是地址，不重新拼接 |
| `TagFromPin(pstate)` | 本层出一个输入口（如全局 pstate 控制器）产生 |
| `TagFromReg(pstate, cell.field)` | 由本 fabric 内挂接 regfile 的某个 regbit 产生（省掉「出叶子→绕总线→回来」） |

两层 decoder 的差异是**推导出来的**，不必手写（HBM：channel 层产生、channel 内层透传）：

```ts
// level 1: channel decoder —— 从地址产生
export const hbm = Bus("hbm", "HBM channel decoder", {
  tags: [TagFromAddr(pstate, "31:30")],
  slaves: [SlaveBus(hbm_ch, 0x0000_0000, { id: "ch0", size: Size(0x1000) }) /* ...ch15 */],
})

// level 2: channel 内部 —— 透传
export const hbm_ch = Bus("hbm_ch", "aword + 2x dword", {
  tags: [pstate],
  masters: [Master("uplink", "from channel decoder")],
  slaves: [SlaveRegfile(aword, 0x000), SlaveRegfile(dword0, 0x100), SlaveRegfile(dword1, 0x200)],
})
```

规则：

1. **单一来源**：同一域在一条 uplink 路径上 **必须**只被产生一次；子总线对已由父级产生的域再写 `TagFrom*` → **报错**。
2. **`TagFromAddr` 必须占地址最高位**：一个 decoder **只产生一个** tag。这些位是本层译码跨度之上的最高连续位，剩下的低位原样是 slave 地址。**禁止**从地址中间取 tag，也 **禁止**把 tag 两侧的地址重新拼接。比较与转发都先抹掉这些位，于是**一条**窗口声明覆盖全部 `2^w` 个别名地址，**禁止**为每个 tag 值各写一个 slave。
3. **一个 decoder 一个 tag**：第二个正交维度放到下一级 decoder，再从那一级的最高位取。一条总线上写了多个 `TagFromAddr` 时，按地址位从高到低排序后仍生成，但 **不保证稳定**（构造期会警告）。位必须连续且顶到最高位；中间留洞 → 报错。
4. **`TagFromAddr` 撑开地址空间**：HBM 的 `pstate` 取 32 位地址的最高位 `[31:30]`，别名步长 `0x4000_0000`、共 4 份。`ADR[29:0]` 原样是地址。软件视角 = 「切 pstate 后按原地址访问」。
5. **位不许落进窗口**：tag 位与**任何** slave 窗口（含 `SlaveBus` 的 channel 窗）重叠 → `Bus()` 构造期 **报错**，不得留到仿真。
6. **`SlaveBus` 的 tag 由子总线推导**：父级 **不应当**手写 `tag:`（今天 `SlaveBus` 把 `opts.tag` 原样交给 `SlaveRegion`，16 次例化就有 16 次填错机会）。声明不一致 → 报错。
7. 透传层 **不解释**位语义（与规则 6 一致）；`wb_cfg_pipe` 的 `{m_tga, m_adr}` 打包路径不变。
8. `TagFromAddr` 与 `TagFromPin` / `TagFromReg` **禁止**同时作用于同一域（与规则 1 同源）。
`ShadowDomain(...).remap({ [tga]: oneHotMask })` 是该域的 TGA→one-hot 规则。regfile 只写 `.shadow(domain)`，默认使用这份映射；未列出的 TGA 保持恒等映射。表级不得再写另一套 remap。`bank`、`pstate`、`pll_pstate` 这类正交维度属于不同层级：父 decoder 消费自己的域后，子 decoder 只看见剩余的那个域。两个域同时出现在同一张寄存器上是不合理设计。

正交维度用地址层级拆开，不在叶子里做笛卡尔 shadow：

| 场景 | 正确拆法 | 禁止 |
|---|---|---|
| 时序 A 只随 bank0/bank1 变化 | bank decoder 下挂一份 A；A 不声明 shadow | 给 A 同时声明 bank 与 pstate |
| 时序 B 只随 pstate0–3 变化 | pstate decoder 下挂一份 B | 把 bank 也带进 B |
| 时序 C 同时随 bank 与 pstate 变化 | 先按 rank/bank 拆成独立 region，每个 region 内再按 pstate 复制 | 一个 cell 同时挂 `bank` 与 `pstate` 两套 shadow |

例如 LPDDR：父 decoder 用 `TagFromAddr(bank, ...)` 译出 rank/bank region；每个 region 是一个子 decoder，只声明 `tags: [pstate]`。C 的寄存器位于子 decoder，因此只看见 pstate。父层的 bank 已经变成“访问哪一个 region”，子层不能再看见 bank TGA。

多个具名 TGA 端口仍可用，但只表示**同一层级中互不交叉的独立域**。它们映射到不同的 `*_tga_<domain>`，不组成一个寄存器的二维 shadow。`pll_pstate` 理论上只出现在它自己的子 decoder；channel 的 `pstate` decoder 看不到它，PHY 的 `pll_pstate` decoder 也看不到 channel pstate。

## 3. 长路径 pipe（写 posted / 读阻塞）

Pipe **内建**在 decoder / interconnect 的 **slave 口**和 **master 口**上：`plugin wishbone run` 写出通用模 [`wb_cfg_pipe`](./rtl/wb_cfg_pipe_template.sv) → `plugins_dir/wishbone/wb_cfg_pipe.sv`，每口 PIPE>0 例化一次。connect **不必**例化 `wb_cfg_pipe`。

`plugin wishbone run` 写完一条总线后，在终端打一棵彩色地址树：绝对地址、窗口名、regfile 叶子、`broadcast` / `broadcast-by`、shadow 域名，以及 `tags`（`addr[hi:lo]`、`pin`、regbit，或透传的 `*`）。子总线只在第一次出现时展开。同一轮里每个 regfile 产物（SV、C、uvm）写出时立刻单独打印一行。

### 3.1 谁配置

| 侧 | 配置 |
|---|---|
| **SlaveRegion** | `SlaveRegion(name, desc, base, Size(bytes), { pipe: N, tag?, broadcast?, broadcastBy? })` 字符串窗口按 **字节跨度**；底层 mask = span 向上取 2 的幂；`(base & mask) === base`；**参与**区间重叠检查。`broadcast` / `broadcastBy` 见 §4.1 |
| **Slave** | `Slave(name, desc, base, mask, { pipe: N, tag? })` **Raw** 端口（原始 match mask）；**不**做对齐/重叠检查；**禁止** `broadcast` / `broadcastBy`；`N=0`（缺省）= 组合直通；`N>0` = 本口插入 N 级打拍（1..16） |
| **SlaveRegfile** | `SlaveRegfile(RegfileDef, base, { id?, pipe?, tag?, size?, desc? })` = `SlaveRegion` **语法糖**（叶子 + `Size(layout span)`，可 `size=` 覆盖且必须盖住 span） |
| **SlaveBus** | `SlaveBus(BusDef, base, { id?, pipe?, tag?, size?, desc?, uplink? })` = `SlaveRegion` **语法糖**（子总线窗 + `Size(child span)`）。子模 **必须** 有 `Master("uplink")`（或 `uplink=`）；一份 child RTL，N 次例化。父级已经下发 `adr & ~mask`，子地址是窗相对的 |
| **Master** | `Master(name, desc, { pipe: N })`；`N=0`（缺省）= 组合直通；`N>0`（1..16）= 在 **仲裁之前**（decoder 则在译码之前）插入 `wb_cfg_pipe`。仲裁请求与 grant 保持看 pipe 的 `s_cyc`，posted 写撤掉端口 `CYC` 后总线仍归该 master，直到队列排空。与父级 `SlaveBus` 的 slave pipe 是两级，互不替代 |

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
- 叶口 `CYC` = **pipe 占用**，不是 master 当前 CYC（posted 后 master 可撤 CYC）。master 口同理：仲裁 **必须**看 pipe `s_cyc` 而不是端口 `CYC`。  
- master pipe 的 `TW` = bus `tag_width`（fabric 入口尚未按 slave 截断）；`TW=0` 时例化省略 `m_tga` / `s_tga`。 
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

- Decoder：地址窗 + 可选 §4.1 写广播；下行仍是 WB（`STB` 扇出，`ACK`/`DAT` 回并）。  
- Arbiter：多 WB master；口 `rb_grant_en`：**0** = 固定优先级（最低 master 下标胜）；**1** = round-robin（上次 grant 之后的下一个请求者，绕回最低下标）。事务中 `CYC` 锁定 grant。demo/soc：`smoke` `FABRIC.rb_grant_en`（复位 0）驱动 **每个 channel** `rb_grant_en`；`basic_smoke` 写该 CSR，SD→SHA DMA 在 `--sd`。  
- Bridge：仅边界协议转换（如 `apb2wb`）；**禁止**让 APB 成为 decoder/regfile 原生口。CDC / APB / JTAG master 见 [`wishbone-master.md`](./wishbone-master.md)：先转 WB，再在 arbiter 前做 `wb_cdc`，全部在 `<bus>_system` 内。  
- 即便将来提供 `topology = crossbar`，slave 侧 **仍必须**有地址窗/选通；matrix **不能**取消译码职责。

### 4.1 Region 写广播（LP6 `BroadcastAddr`）

一个 `SlaveRegion` 可以声明广播名。它只是地址窗口，命中后产生一位 `broadcast_<name>`，**不**生成 `{name}_i_wb_*` / `{name}_o_wb_*` 数据口。其它 region 用 `broadcastBy` 订阅这个名字。

```ts
SlaveRegion("ch_bcast", "broadcast all channels", 0x1_0000, Size(0x1000), {
  broadcast: "ch_all",
})
SlaveBus(hbm_ch, i * 0x1000, {
  id: `ch${i}`,
  size: Size(0x1000),
  broadcastBy: "ch_all",
})
```

规则：

1. **只限 region，且二选一。** `broadcast` 与 `broadcastBy` 只允许 `SlaveRegion`，以及它的语法糖 `SlaveBus` / `SlaveRegfile`。同一个窗口不能既产生广播又订阅广播；同时写两个字段 → 构造期报错。raw `Slave` 写了任一字段 → `Bus()` 构造期报错。
2. **广播窗不是数据 slave。** 它参与地址重叠检查，但不例化 pipe，也不占用 `slot_sel`。命中条件是 `WE &&` 地址落在该窗。
3. **订阅者选择。** 订阅窗口的选通 = 地址落在自己的窗口，或 `WE && broadcast_<name>`。广播事务把广播窗内的相对地址原样送给每一个订阅者；窗口大小应当与订阅者一致。
4. **名字必须存在。** `broadcastBy` 引用的名字必须由本层某个 `broadcast` 声明。未声明 → 构造期报错。一个名字可以有多个订阅者；一个 region 可以订阅多个名字。
5. **只广播写。** 读广播地址不扇出，按未映射处理并立即 ACK，读数据为 0。禁止把多路 `DAT` 或在一起。
6. **ACK 合流，且 pipe 等长。** 写广播的 ACK = 所有被选中的订阅者 ACK 相与。同一广播名的订阅者必须是等长副本：`pipe` 相同，窗口大小应当相同。`pipe` 不同 → `Bus()` 构造期报错。深度不一致时，浅副本的 ACK 先返回并撤掉，深副本的 pipe ACK 还没到，与门对不齐。有 pipe 时等的是 pipe 入口 ACK，不是组合译码。
7. **与 tag 的顺序。** `TagFromAddr` 先剥离，再做广播译码。因此一次广播只进入当前 tag 别名，不跨 pstate。

HBM：父层 16 个 channel 订阅 `ch_all`（`pipe` 都是 0），`center common` 不订阅。每个 channel 内 `dword0/dword1` 以相同 `pipe` 订阅 `dword_all`，`aword` 不订阅。

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
- 生成编排 **必须**同一 plugin id `wishbone` 一次打出 arb+decoder+regfile（类型仍分立）；每个生成模经 **analysis → RtlIndex 普通叶子**；connect 侧一律 `aw-inst` 例化（**禁止**插件树私有口表向上递推）。  
- **字符串窗口**：优先 `SlaveRegion(name, desc, base, Size(bytes), { pipe?, tag? })`。`Size` 是作者面跨度（字节）；底层 mask = `deriveWindowMask`（向上取 2 的幂）；`(base & mask) === base`。`Bus()` **必须**拒绝 Region 窗口两两重叠（含 `SlaveRegfile`）。原始 `Slave(name, desc, base, mask, …)` 是 **Raw** 口：**禁止**对它做对齐/重叠检查（demo `uart`）。**禁止**给 `Slave` / `SlaveRegion` 重载 `RegfileDef`。  
- **`SlaveRegfile` = `SlaveRegion` 语法糖**：`SlaveRegfile(regfile, base, { id?, pipe?, tag?, size?, desc? })`。默认 `Size(layout span)` 再 2^N 对齐；`size=` 可放大窗口，**禁止**小于 span。`id` 缺省 = `RegfileDef.name`；同一 SoT 多挂总线用不同 `id`。`tag` 缺省 = 叶子 `tga_width`，**必须**与叶子一致。  
- **`SlaveBus` = `SlaveRegion` 语法糖**：`SlaveBus(child, base, { id?, pipe?, tag?, size?, desc?, uplink? })`。用于 **级联多级 decoder**（也允许子级是 interconnect）。`id` 缺省 = `BusDef.name`；同一 child 多挂用不同 `id`（demo：`sd_sha` ×2 → `ch0`/`ch1`）。默认 `Size(busByteSpan(child))`；`size=` 可放大，**禁止**小于 child span。子总线 **必须**声明 `Master("uplink")`（或 `uplink=`）：interconnect 上该 master 口在 Type-A wrapper 里 **remap** 成 `i_wb_*` / `o_wb_*`（父级 Slave 窗 identity）；decoder 子级 remap `m_*`。父级译码已下发窗内 offset（`adr & ~mask`），子地址是相对的。channel 内 DMA 的 SRC **必须**写相对地址。**禁止**假设子 DMA 能打到父级 SRAM/flash（没有自动 downlink）。generate **必须**对 child RTL 只打一份，HTML 例化 N 次。  
- 若 bus 上有挂接的 regfile **或** `Master("uplink")`：generate **必须**再打一份 Type-A **wrapper** `<bus>_system`。connect HTML **禁止**再 `aw-inst mod="*_regfile"` 这些叶子；只例化 wrapper。未挂接的 slave 仍在 HTML。  
- 软件地址图由同一插件打包：`[plugins.wishbone] c=` → `<bus>_map.h` + 字段 `.h` + `wishbone.h`；`uvm=` → `ral_block_<bus>.sv` + `ral_<SHEET>.sv` + `ral_wishbone.sv`，以及真正的 RALF `<bus>.ralf`。叶子 C/`uvm_reg` **只**出字段 layout。

  RTL 仍是一个窗口：`TagFromAddr` 把这些地址位从译码里剥掉，所以硬件只看见一份相对地址。软件图在**产生这个 tag 的那一层**按副本拆开，每个副本一条绝对地址。只透传该 tag 的子总线和叶子**不再拆**：它们的地址相对父级已经命名的那一份。`pin` / `reg` 来源不产生地址别名。广播窗口是一条真实地址，一次写打中所有订阅者；uvm_reg 里广播只作为注释，因为没有广播 frontdoor。

   例如 HBM：`hbm` 的 `pstate` 来自 `ADR[31:30]`，所以 `ch0` 拆成 `ch0_pstate0`…`ch0_pstate3`，步长 `1<<30`。`hbm_ch` 只透传 `pstate`，`aword` / `dword0` / `dword1` 在每个副本里各出现一次，偏移仍是 `0x000` / `0x100` / `0x200`。`dword_all` 同样跟着每个 pstate 副本出现。`ch_bcast` 不带 tag，只有一条。
- 地址图数据在 Table/端口模型里；**禁止**把 pin 级连线写进 `autowire.toml`。  
- 产物进 `plugins_dir/<plugin-id>/`；软件 map **禁止**进 `plugins_dir`（与 regfile C/UVM 同纪律）。与 connect/sim dump 目录分家（[`README.md`](./README.md) §3）。

## 7. 工作区

```toml
[wishbone.soc]
ts = "sot/wb_bus_soc.ts"
# exports = ["soc_wb"]   # 可选；省略 = 全部 BusDef

[plugins.wishbone]
c   = "fw/gen/wishbone"  # <name>_map.h（git-tracked showcase in demo/soc）
uvm = "dv/ral"           # ral_block_<name>.sv and <name>.ralf

# out → plugins_dir/wishbone/wb_cfg_pipe.sv
#                      + <name>_decoder.sv | <name>_interconnect.sv
#                      + <name>_system.sv   # SlaveRegfile 和/或 Master("uplink")
# NM<=1 → decoder；NM>1 → interconnect（priority arb + named slaves）
# demo/soc：顶层 soc_wb = interconnect（cpu + JTAG dbg，dbg 经 demo_tap USER）；两个 SlaveBus(sd_sha) channel
#           HTML u_ic = soc_wb_system；u_ch0/u_ch1 = sd_sha_ch
#           各 slave PIPE 不等长（顶层 cascade 2/4 + channel 内 2/3）
#           smoke FABRIC.rb_grant_en 驱动两个 channel rb_grant_en
```

## 8. 暂时不做

下面这些等后续需求再追加，这个阶段不改生成器：

1. Arbiter 更多默认策略（v1：`rb_grant_en` 固定 / 轮转已落地）。  
2. `topology = crossbar` 以及 M/N 上限。  
3. Bridge 目录以外的 master 形态，见 [`wishbone-master.md`](./wishbone-master.md) §8。  
4. 固件窗 + DMA：块周期连续写。  
5. 默认 slave `pipe`（现缺省 0；作者按口配置）。  
6. SlaveBus downlink（子 DMA 打回父级窗口）。v1 **不**自动生成。

**已裁定口名**：slave `{name}_i_wb_*` / `{name}_o_wb_*`；interconnect master `{master}_o_wb_*` / `{master}_i_wb_{dat,ack}`；单 master → decoder（flat `m_*`）。  
**已裁定软件图 / 挂接**：`SlaveRegfile(RegfileDef, …)` + Type-A wrapper + bus C overlay / `uvm_reg_block`（见 §6）。  
**已裁定级联**：`SlaveBus(BusDef, …)` = Region 语法糖；多级 decoder 级联；子级可以是 interconnect；一份 BusDef × N 平行 channel。
