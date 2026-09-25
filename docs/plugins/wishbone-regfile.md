# Wishbone 寄存器文件（叶子）

> 状态：**实现中（功能裁定已齐；`help status`：Wishbone implementing now；plugin id `wishbone`）**。  
> 块内配置互联：[`wishbone-bus.md`](./wishbone-bus.md)。插件登记：[`README.md`](./README.md)。  
> 作者面草稿 / 示例：[`docs/examples/regfile/`](../../examples/regfile/)（`regfile.ts` SoT + `*_regfile.sv` 展示）。  
> 正式生成：`autowire plugin generate wishbone` → `[dump] plugins_dir/wishbone/`。  
> 主干对照：`master` 分支 `autowire/regtable/gen_verilog.py`、`regfile.py`、`common/verilog_model.py`。  
> 改本文时同步 bus 文开放项（地址/`SEL`）与 `help status` Parallel。

关键字「必须 / 应当 / 可以」按 RFC 2119。

## 1. 目标

把 **TypeScript `Regfile(...)` 命名导出（寄存器 SoT）** 落成 **Wishbone Classic slave 叶子**（regfile 模块）：

- 口协议 **必须**符合 [`wishbone-bus.md`](./wishbone-bus.md) §2 子集；**禁止**再发明 `wren/rden/rddata_vld` 内核。  
- 读写完成 **必须**用 `ACK`；**禁止**用读有效冒充写完成。  
- 数据模型：`Table` ≈ 一份导出的 `RegfileDef`；内含 Block / Cell / Field（Access 语义继承主干，见 §5）。  
- **SoT 只有** 配置的 `.ts` 模块中导出的 `RegfileDef`（见 §3.1）；**禁止** HTML 字段树、Python、Excel、regpy、其它 DSL 当寄存器权威。  
- Excel / C / UVM **只出导出**：路径见 §6；**禁止**当 SoT、**禁止**从这些产物回写 TS。  
- 落盘后经 `analysis` 进 RtlIndex。未挂到 bus 的叶子仍可 `<aw-inst mod="<name>_regfile">`。已 `SlaveRegfile(...)` 的叶子由 bus Type-A wrapper 例化，HTML **禁止**再声明。**禁止**再引入 HTML 寄存器桩标签。  
- 生成后经 `analysis` 进 RtlIndex；connect **只例化**，见 §4。

不在本文范围：arbiter/decoder 树拓扑、SoC fabric（见 bus 文）；connect 方言本身；整窗 RAM/`block_regfile`（后期，见 §7）。

## 2. 与主干 Python 的切割（叶子侧）

| | 主干 Python regtable | 本设计 |
|---|---|---|
| 叶子口 | `reg_wren/rden/bsel/addr/wdata` + `reg_rddata/rddata_vld` | Wishbone Classic slave（与 bus 文同子集） |
| 写/读完成 | 易蹭 `rddata_vld` | **仅** `ACK`（读时 `ACK`+`DAT_*` 同拍） |
| 数据模型 | `RegTable` / `RegCell` / `RegField`（Python 类） | **TS** `Regfile` / `Block` / `Cell` / `Field`（见 [`docs/examples/regfile/regfile.ts`](../../examples/regfile/regfile.ts)） |
| 文档 / 固件 / UVM | 可导 Excel、C 头、RAL | Excel / C / `uvm_reg` **只出导出**；路径 = `[plugins.wishbone]` |
| SoT | Python + 可选 Excel | **仅** TS `RegfileDef` 导出；**禁止** HTML/其它 DSL 当权威 |
| 生成头 | username / 墙钟 / Python Info | 稳定头：plugin id + 表名（可复现） |

地址图树、decoder 递归生成属 **bus** 侧。

## 3. Regfile 叶子边界

```text
TS RegfileDef export (SoT)
    →  generate → *_regfile.sv
    →  （若配置了 [plugins.wishbone]）Excel / C 头 / uvm_reg（§6；非 SoT）
    →  analysis → RtlIndex
WB slave  ←──  (协议见 wishbone-bus.md §2)
   │
 Field 旁路、shadow、功能口
```

- 生成模块 **必须**只暴露：Wishbone slave 束（含若启用的 tag）+ 字段旁路（及 clk/rst）；shadow **索引**来源见 §5.7。  
- **禁止**在叶子上再包一层 APB；芯片要 APB → bus 边界 bridge。  
- `SEL` **必须**参与字节写；字段布局 **禁止**重叠（插件 generate 自检）。  
- shadow：**可以**多份拷贝；索引 **仅** `wb_tga` 切片（§5.7；**无** takeover / local_sel）。  
- **固件 / 大块存储：禁止**建成成千上万个 `Cell` → memory 窗口（后期）；v1 CSR 模板不生成「整窗 RAM」模。

### 3.1 寄存器 SoT：TypeScript `RegfileDef` 导出（已裁定）

**唯一 SoT**：配置的 `.ts` 模块中 **命名导出**的 `RegfileDef` 值（由 `Regfile(...)` 构造）。  
**禁止**：HTML `awx-reg-*` 字段树、Python `RegTable`、JSON schema、regpy、Excel 导入、其它自定义 DSL 充当权威。

**命名对齐**

- 脚本 **export 绑定名** 与 `RegfileDef.name` **必须相同**（模块名 `<name>_regfile` / 默认 `sheet` / 报错都认这个名）。  
  例：`export const smoke = Regfile("smoke", …)` → 模块 `smoke_regfile` → bus wrapper 或 `<aw-inst mod="smoke_regfile">`。  
- toml **`[wishbone.<source_id>]`** 的 id 只标识 **SoT 文件槽**（可含多个 export），**不必**等于某个叶子名。  
- 重名 / 找不到导出 → generate 报错。

**toml**

- `[wishbone.<source_id>] ts = "sot/wb_reg_foo.ts"`（总线为 `sot/wb_bus_foo.ts`）指向含 **一个或多个** `Regfile(...)` / `Bus(...)` 导出的模块（类型仍分立）。  
- 省略 `exports` → generate **该文件内全部** `RegfileDef` 导出；可选 `exports = ["a", "b"]` 只生成列出的绑定。  
- **禁止** `html=` 充当 SoT。  
- **禁止**把 regfile 源登记为 `[connect.<id>]` / `[sim.<id>]`（生成走 plugin generate，不走 connect elaborate）。

**Connect 引用（非 SoT）**

- generate → `analysis` → RtlIndex 叶子后：未挂 bus 的叶子在 HTML **`<aw-inst mod="<name>_regfile">`**；已挂 `SlaveRegfile` 的叶子只出现在 bus wrapper 内。  
- **禁止** HTML 寄存器描述桩 / `awx-reg-*` 字段树。

**作者面 API**（草稿：[`docs/examples/regfile/regfile.ts`](../../examples/regfile/regfile.ts)；契约以该文件 + 本节为准）

| 项 | 裁定 / 草案 |
|---|---|
| 工厂 | `Regfile` / `Block` / `Cell` / `Field` / `Shadow` |
| Access | **RC** / RO / RW / RWW / RWE / W1P / W1C；**无 W1S**（置位用 RW） |
| Field | fluent：`.offset()`（cell 内 bit 起点）/ `.reset()`；`width` + 可选 bit `offset`；**禁止** `bits=` / `high:low`；**禁止** Field 级 `.shadow()` |
| `.reset` | **`number`**（全 copy / 无 shadow 共用）或 **`Record<copyIndex, number>`**（按物理 shadow copy）；dict **未列 copy 默认 0**；RC **必须**用标量 `number` |
| Cell / Block 地址 | 用可选 **`offset`**（相对 regfile / 父级）；**禁止**地址语义的 `addr` 字段名 |
| 级联默认 | `CellDefault` / `BlockDefault` / `RegfileDefault`：`.align(...)` / `.byteAlign(...)` / `.offset(...)` / `.shadow(...)` / `.addrWidth(...)` / `.sheet(...)` / `.readWriteBlock(...)` / `.shadows(...)`（不可变） |
| Shadow 配置 | **只在 Cell**（`CellDefault.shadow(...)`）；**Block**.`shadow(...)` 仅为下属 Cell 缺省。**禁止**同一 cell 内混不同 shadow；**拼车（同 cell 打包 field）必须同 shadow** |
| 宽 field | Block 下自动拆 cell；模块口 **旁路/输出自动拼齐**为完整 `width` 向量；拆出的各 cell **继承**该 Block 的 shadow 缺省 |
| `read_write_block` | Regfile opts：`.readWriteBlock(true\|false)`；**缺省 `false`**（非阻塞）；`true` 时命中 **RWE** 的 WB 事务可被外部窗（如 FIFO）挡住 ACK |
| Shadow | `Shadow(name, copies, tagBits).remaps({ from: bitmask }).innerShadowMux(bool)`；**`tagBits` 强制**；**`innerShadowMux` 缺省 `true`**；**无** `ShadowBroadcast` |
| `remaps` | `to` = 物理 copy **bitmask**（bit k → copy k）；单 copy：`1<<k`；广播全 N 份：`(1<<N)-1`（例 4 copy → `0b1111` / from=3 → `3: 0b1111`） |
| `inner_shadow_mux` | **`true`（缺省）**：叶子内对适用 Access 做 shadow mux；**`false`**：旁路按 copy 数组导出（如 RWW）。**对 RO 无意义**（RO in 恒 per-copy；读用译码 bitmask，多 bit 则或）；RWE 数据口形不随开关变 |
| `bytes_align` | **必须**为 4 的倍数（`*.align()` / `byteAlign()` 内校验） |
| `desc` | Field / Cell / Block / Regfile **必须**提供（可维护性）；**一行摘要**，进 RTL / C / uvm_reg / Excel Description |
| `note` | 可选。`Field(...).note(\`...\`)`：Excel 该字段 Description **同一单元格**，`desc` 之后换行接正文。`RegfileDefault.note(\`...\`)`：表头 Description 的批注（不能插数据行，否则位宽公式错位）。模板字符串会去掉共同缩进。**只进 Excel**，禁止进 RTL / C / uvm_reg |
| 数据通路 | Wishbone **`DAT_*` 固定 32 bit**；**`SEL` 固定 4**；**`ADR` = 字节地址**；一 cell = 一字 = 4 字节；**禁止** `data_width` |
| `addr_width` | Regfile opts **必须** `addrWidth(...)`（无缺省） |
| Excel / C / uvm_reg 表名 | `RegfileDef.sheet`；缺省 / 空 = `name`；多硬件例化可共享 |

示意（完整可调示例见 [`docs/examples/regfile/regfile.ts`](../../examples/regfile/regfile.ts) 末尾 `sub_module_a` / `sub_module_b`）：

```ts
export const sub_module_a = Regfile(
  "sub_module_a",
  "Sub-module A — omit offset, auto layout",
  RegfileDefault.align(4)
    .addrWidth(8)
    .shadows(
      Shadow("lane", 4, "1:0").remaps({ 3: 0b1111 }),
    ),
  [
    Block("ctrl", "Control", BlockDefault.byteAlign(16), [
      Cell("CFG0", "Main config", CellDefault.align(BitsAlign.Align8), [
        Field("enable", Access.RW, 1, "Soft enable").reset(0),
        Field("mode", Access.RW, 3, "Operating mode").reset(0),
      ]),
      Field("key", Access.RW, 96, "Wide key — auto-split"),
    ]),
    Cell("SOLO", "Standalone cell", CellDefault, [
      Field("flag", Access.RW, 1, "Flag").reset(0),
    ]),
  ],
);
```

#### 地址与对齐（编译器式自动排布）

**默认路径：省略 Cell/Block `offset`，只靠 `bytes_align` 自动拼接**——心智对齐编译器对成员/`struct` 的 layout（cursor + alignment padding），不是手算每个绝对地址。

1. **游标（cursor）**：按定义序遍历 block/cell（及 block 自动拆出的 cell）；每放下一对象前，将 cursor **上取整到所属 `bytes_align`**，再分配，再 `cursor += size`（**字节**；一 cell = 4 字节，见 §5.6）。  
2. **`bytes_align`**：regfile / block 取值 **须为 4 的倍数**；block 内自动 cell 用 **block `bytes_align`**；regfile 下独立 cell / 未钉址 block 用 **regfile `bytes_align`**；缺省宜 `4`。  
3. **`offset` 可省略**（推荐省略）。写出时 = 钉死相对基址（类 linker 强制地址）；**必须**已对齐到所属 `bytes_align`，且与自动段 **禁止**重叠，否则 generate 报错。  
4. 显式 `offset` 之后，后续省略 `offset` 的兄弟从 **`offset + size` 再按 bytes_align 推进**（仍编译器式）。  
5. **禁止**把 Field 的 bit `offset` 当成地址；地址只用 Cell/Block `offset` 或自动。  
6. **禁止** `bytes_align` 为非 4 倍数。

#### Cell / Field 位布局（草案）

1. **一 cell = 32 bit**（= 固定 data-width）；不可配置其它宽度。  
2. **`bits_align`**（cell，缺省 **8** / `BitsAlign.Align8`）：本 cell 内 field 的 **填充对齐粒度**。自动排布时，下一 field 起点对齐到 `bits_align` 边界；占用按 `ceil(width / bits_align) * bits_align` 推进（填充）。  
3. Field **禁止** `bits` / `3:1`；用 **`width`**（bit 宽）+ 可选 **`offset`**（起始 bit，宜为 `bits_align` 的倍数；显式但不对齐 → 报错）。  
4. 省略 field `offset`：按定义序在 cell 内自动填充对齐；与显式 `offset` 冲突/重叠 → generate 报错。  
5. **挂在固定 cell 下**的 field：占用（含填充）**禁止**超出该 cell 的 `[0,31]`（超长请改挂 block 或拆手写）。  
6. **Cell 放置**：挂在 **Block 内**，或作为 **Regfile body 直接成员**独立出现；**禁止**挂在 shadow 库下。独立 cell 的自动顺排受 **regfile `bytes_align`** 约束。

#### Block 超长 field 自动拆分（草案）

目的：在 **Block** 下直接写宽 field，由 generate **自动拆成多个 32-bit cell + 分片 field**，**省去手动拼字段/拼 cell**。

```ts
Block("wide", "Wide fields", BlockDefault.byteAlign(4), [
  Field("key", Access.RW, 96, "Auto-split across cells").reset(0),
  Cell("CTRL", "Control", CellDefault, [
    Field("go", Access.W1P, 1, "Go pulse"),
  ]),
])
```

规则：

1. **仅 Block** 提供该能力；独立 cell / cell 内 field **不**自动跨 cell 拆分。  
2. Block 直接子级的 Field，若放不进当前自动 cell 剩余空间或 **`width > 32`**：按定义序切开，生成连续 cell（**`offset` 可全省略**，按 block `bytes_align` 自动拼），每片 ≤32、按 `bits_align` 对齐。  
3. 分片**内部**命名（已定）：cell ≈ `<field>_<i>`；field 片 ≈ `<name>_<i>`（`i` 自 0 = **LSB**）；**旁路/功能口对外自动拼齐**为原 `width` 向量（作者不看分片口）。每片 cell/field 的 **desc 与注释**必须写明该片在完整字段空间的位置：`name[hi:lo] of [W-1:0]`（例 96-bit `key` → `key[31:0] of [95:0]` / `key[63:32] of [95:0]` / `key[95:64] of [95:0]`）。  
4. 拆出的连续 cell **共享**同一 shadow（来自 **Block** `.shadow(...)` 缺省；无则皆无）——宽 field **禁止**按分片挂不同 shadow。  
5. 与显式 `offset` 钉死的 cell **混排**：按定义序；**禁止**占用冲突。  
6. 作者 **应当**对超长逻辑场用 block 直挂 field，**不必**手写多 cell，也 **不必**手算地址或手拼旁路向量。

其它规则：

1. **一份** `RegfileDef.name` 导出 ↔ **一个**生成叶子模（硬件例化 / WB identity）。软件与文档身份 = 有效 **`sheet`**（空/缺省 = `name`）。  
2. 同一 `.ts` 模块 / 工作区登记内可多个导出；**`name` 必须唯一**（一份 `name` ↔ 一份 SV 叶子）。同一 IP 多挂总线：**一份** SoT + bus `SlaveRegfile(regfile, base, { id })` 多次，或挂到可复用的 child `BusDef` 再 `SlaveBus` ×N（demo：`sha256` 挂在 `sd_sha` 上，两个 channel 例化同一 wrapper）。有效 `sheet` **可以**被不同 `name` 共享（C/UVM/Excel 只写一份）；共享时 **字段 layout 必须相同**，不同 → generate 报错。  
3. 有效 `sheet` **必须**是稳定标识符（`[A-Za-z_][A-Za-z0-9_]*`）。  
4. 工作簿路径：`autowire.toml` 的 **`plugins.wishbone.export`**（例 `"fw/gen/wishbone/wishbone.xlsx"`）；**永远**文档产物；改寄存器 **只改** TS。未配置 export → 可不写 Excel。  
5. HTML 桩 **结构**上可与 `aw-mod` 同槽；**语义**上由 wishbone-regfile **generate**，不进 connect elaborate，不写 `.autowire/connect/`。  
6. Shadow：**必须**经 `RegfileDefault…shadows(...)`（或等价 opts）挂在表级；无 shadow 则省略。  
7. Shadow 挂在 **Cell**（或 Block 缺省落到 Cell）；有效 bank = `wb_tga` 切片再经该 shadow 的 **`remaps`**（bitmask）。**禁止** Field 级 shadow；**禁止**同 cell 混 shadow。  
8. **Shadow 缺省**：`BlockDefault.shadow(...)` → 未自带 shadow 的子 Cell；宽 field 自动拆出的 cell 同样吃 Block 缺省。  
9. **Per-copy reset**：`.reset({ 0: a, 1: b, … })`；标量 = 各 copy 同值；**未列 copy 默认 0**（相对 **Cell** 的 shadow）。  
10. Cell **可**在 block 内或独立于 regfile body；field **禁止** `bits`，用 `width` + 可选 bit `offset`；cell `bits_align` 缺省 8。  
11. Block **可以**直接挂超长 Field，generate **自动拆** cell/field，口上 **自动拼齐**。  
12. **Cell/Block `offset` 可省略**：默认按 `bytes_align` 自动拼地址；显式 `offset` 仅用于钉位。

## 4. 作为生成器插件（类型 A）

宿主见 [`README.md`](./README.md)。本叶子 **必须**为类型 A。

```text
generate：TS RegfileDef export
    →  plugins_dir/<plugin-id>/*_regfile.sv
    →  （若配置了 [plugins.wishbone]）Excel / C 头 / uvm_reg（§6）
    →  analysis（hdxml hash 增量）→ RtlIndex
    →  connect：未挂 bus 则 <aw-inst mod="…_regfile">；已挂则只例化 bus wrapper
       （口表只认 ctx.leaf；禁止插件 providePorts 旁路）
```

- **禁止**经 connect 路径直接吐 regfile SV——只走 generate → leaf → RtlIndex（HTML 或 bus wrapper 再例化）。  
- 声明 **禁止**登记为 `[connect.<id>]` / `[sim.<id>]`；toml 用 `[wishbone.<source_id>] ts=` 指向 SoT **文件**（可含多个 export）。  
- 字段重叠 / 共享 `sheet` 但 layout 不同 / 桩带子女等自检在 **generate** 失败即不落盘。  
- SV 只进 `plugins_dir/<plugin-id>/`；Excel / C / uvm_reg 只写 `[plugins.wishbone]` 所指路径，**禁止**当 SoT。

## 5. 生成 RTL 模板与样式（对照主干；口名/时序已裁定）

### 5.1 主干模板里值得继承的

来源：`master:autowire/regtable/gen_verilog.py`（`regfile_template` / `regbit_block_template`）。

| 资产 | 说明 | 建议 |
|---|---|---|
| 章节结构 | ① 声明 ② 写译码 `wr_sel_*`/`rd_sel_*` ③ 每 Cell `always` 写块 ④ 读 mux | **保留**（内部名可沿用） |
| Access → 旁路口 | 见下表 | **保留语义**；口名风格见 §5.4 |
| 字节写 | `reg_bsel` 与字段重合 → 现改为 WB `SEL` | **保留算法** |
| W1P/W1C 与 bsel mask | `w1p_wdata_with_byte_mask` 等 | **保留**（**无 W1S**；置位用 RW） |
| RWW / RWE 旁路形状 | `_strb`/`_hwdata`；`_wren`/`_rden`/`_wdata`/`_rst` | **保留**（RWE 的 wren/rden 是**字段旁路**，不是总线内核） |
| shadow 索引 | 主干旁路 `*_sel` | **仅** `wb_tga` 切片（§5.7；无 takeover/local） |
| Cell 注释带 hex 地址 | `// Addr: 0x… RegCell: …` + 字段位域 / Access / desc | **保留并加强** |
| 端口列对齐 | `Port.declare` 对齐 | **始终**按工作区 `[style] port_align` / `signal_align` 同规则排（dir / type / packed 分列；声明块集中在端口后） |
| 模块头 / 端口 / 分区注释 | 表 `desc`、地址图、WB/旁路口说明、①–⑤ 分区标题 | **保留**（生成器写入） |

**Access → 旁路口（语义 + §5.4 拼写）**

| Access | 含义 | 旁路 / 读通路 |
|---|---|---|
| **RC** | **ReadConst**：总线读回**编译期常数**；**无**功能 in；写忽略或 generate 可拒 | 读 mux 接 `.reset(n)`；**禁止**旁路 in |
| RO | 功能只读 | `ro_<field>` in（shadow → per-copy 数组）；读 = 译码 bitmask **或**；**`inner_shadow_mux` 无意义** |
| RW | 内部 regbit | `rg_<field>` out（`inner_shadow_mux=false` → 按 copy 数组） |
| RWW | 软硬件可写 | `rg_<field>` out + `rg_<field>_strb` / `rg_<field>_hwdata` in；同周期 SW 写 **优先于** HW `_strb`（HW 写被吞） |
| RWE | 外部寄存器窗 | `ext_<field>` in + `ext_<field>_{wdata,wstrb,wren,rden,rst}` out；shadow → **`o_<shadow>_sel`**；表级 `read_write_block` → **`ext_<field>_ready`** 可拖 ACK |
| W1P | 写 1 → 单拍脉冲 | `p_rg_<field>` out |
| W1C | 写 1 → 清 sticky | `c_rg_<field>` out + **`c_rg_<field>_set`** in（硬件置位；同周期 set **优先于** W1C 清） |
| ~~W1S~~ | **不做**；置位用 **RW** | — |

**RC 细则（草案）**

1. `Access.RC`；全称 ReadConst。  
2. **常数**写在 field 的 **`.reset(n)`**（**仅标量**；**禁止** per-copy dict）；对 RC 表示**读回常量**，不是可翻转复位态。**必须**显式给出，缺省 → generate 报错。  
3. **禁止**为 RC 生成功能旁路 in；读数据通路在叶子内绑死常量。  
4. 总线写命中该 field：**应当**忽略（ACK 仍按表规则）；**禁止**改常量。  
5. 与 **RO** 区分：RO = 运行时功能输入；RC = 固化标识/版本类常量。

**`read_write_block`（表级；已裁定口形）**

控制 **命中 RWE 字段** 时，Wishbone 事务是否可被外部窗（典型：FIFO）**挡住 ACK**：

| 值 | 行为 |
|---|---|
| **`false`（缺省）** | **非阻塞**：同拍 ACK；RWE 旁路照常；**不**生成 `ext_<field>_ready`；**不**因 FIFO 拉长事务 |
| **`true`** | **可阻塞**：仅 **RWE** 命中可看 **`ext_<field>_ready`**；ready=0 时推迟同拍 ACK；**非 RWE** **禁止**拖 ACK |

- TS：`RegfileDefault.… .readWriteBlock(true)`；IR `read_write_block`（缺省 `false`）。  
- **禁止**用 `read_write_block` 去挡 RO/RW/RC/W1*。  
- 典型：外挂 FIFO 且希望总线自然 stall → 开 `true`；普通窗保持缺省 `false`。

**与 fabric「写 posted / 读阻塞」联用时（主干 cfg 加速模型）**

- 写 ACK 常在 **arb/入口** 给出（表示进队/获 grant），**不是**窗外 FIFO 已接收。  
- **`read_write_block` 必须默认保持 `false`，打开前要谨慎**：若写 ACK 已提前给出，再用 `ext_*_ready=0` 拖叶子 ACK，**无法**再挡住 master，易造成协议死锁或「以为 stall 住了其实写已 accepted」。  
- 需要反压时：优先窗外自备缓冲 / 满标志 + 软件 fence；或该地址 **退出 posted 写通道**；**不要**指望 `read_write_block=true` 在 posted fabric 上锁总线。  
- 写后依赖 RWE 副作用：先 **读做屏障** 或显式排空写 pipe。

### 5.2 必须替换的外壳（相对主干）

| 主干 | 本设计 |
|---|---|
| `reg_clk` / `reg_rst_n` | clk/rst（命名见 §5.4 待裁定） |
| `reg_wren` / `reg_rden` / `reg_bsel` / `reg_addr` / `reg_wdata` | WB：`CYC` `STB` `WE` `SEL` `ADR` 写数据 + 内部 hit 产生 `wr_fire`/`rd_fire` |
| `reg_rddata` / `reg_rddata_vld` | 读数据进 WB `DAT_*`；完成 **只有 ACK**；**删除** vld 状态机与「vld 清 rddata」 |
| 文件头 username / time / Python Info | `Generated by autowire plugin <id> (table <name>). Do not edit.` |
| 口类型 `wire`+`reg` ANSI 混用 | 待裁定：默认 `logic` 或跟 style（§8） |
| `RG_NAME_PREFIX` 环境变量改名 | **禁止**；改名只走 toml/插件配置 |
| 嵌 APB/FIFO | **禁止**（bridge 在 bus 插件） |
| `block_regfile` 整窗模板 | **v1 不做**（与 CSR 模板分离；§7） |

### 5.3 目标模块大纲（示意）

```text
// Generated by autowire plugin <id> (table <TableName>). Do not edit.
//------------------------------------------------------------------------------
//  Module / Desc / Addr width / Cells / Address map
//------------------------------------------------------------------------------
module <table_name>_regfile (
  // clock / reset
  // wishbone classic slave  — 唯一总线口（命名 §5.4 / bus §2）
  // field / shadow sidebands — Access + SoT desc
);
  // 1. internal declarations
  // 2. address decode / hit / wr_sel_* / rd_sel_*（cell+field map 注释）
  // 3. shadow TGA decode（若有）
  // 4. field storage / sideband glue
  // 5. read mux → o_wb_dat / ACK
endmodule
```

内部由 WB 派生（概念，非最终信号名）：

```text
wr_fire = CYC & STB &  WE & hit
rd_fire = CYC & STB & ~WE & hit
→ wr_sel_* / rd_sel_* = (addr decode) & wr_fire / rd_fire
```

### 5.4 命名与样式（已裁定）

| 项 | 裁定 |
|---|---|
| WB 端口 | **`{name}_i_wb_*` / `{name}_o_wb_*`**（`name` = `RegfileDef.name` = bus slave id → **identity 直连**；旁路异名前缀用**一条** `aw-rewrite`，见 [`../connect/html.md`](../connect/html.md) §3.5.5） |
| clk / rst | **`i_clk` / `i_rst_n`** |
| 字段 / shadow 旁路 | **Access 前缀名**（对齐主干 `RG_NAME_PREFIX`）；**禁止** `wb_` 前缀；**禁止**旧总线内核名（`reg_wren` 等）；**禁止**再套一层字段旁路 `i_`/`o_`（方向只靠 `input`/`output`） |
| 净荷类型 | 默认 **`logic`**（列对齐仍跟工作区 `[style]`） |
| 模块名 | **`<table_lower>_regfile`** |

**旁路拼写（Field.`name` → Access 前缀 stem；已带前缀则不重复）**

| Access | 前缀（主干） | 口名（方向） |
|---|---|---|
| **RC** | — | **无**功能旁路口 |
| **RO** | `ro_` | `ro_<field>` in；shadow → `ro_<field>[copies]` |
| **RW** | `rg_` | `rg_<field>` out（`inner_shadow_mux=false` → 按 copy 数组） |
| **RWW** | `rg_` | `rg_<field>` out + `rg_<field>_strb` / `rg_<field>_hwdata` in |
| **RWE** | `ext_` | `ext_<field>` in + `ext_<field>_{wdata,wstrb,wren,rden,rst}` out；**无**总线 vld |
| **W1P** | `p_rg_` | `p_rg_<field>` out（单拍脉冲） |
| **W1C** | `c_rg_` | `c_rg_<field>` out + `c_rg_<field>_set` in（shadow 非内选 → `_set` 按 copy 数组） |
| RWE + shadow 译码 sel | — | **`o_<shadow>_sel`**（该 shadow 一份；非 Access 前缀） |
| `read_write_block` + RWE ready | — | **`ext_<field>_ready`**（仅表级 `read_write_block=true` 且该 field 为 RWE） |

- WB 束示例：`{name}_i_wb_cyc` / `{name}_i_wb_stb` / `{name}_i_wb_we` / `{name}_i_wb_adr` / `{name}_i_wb_dat` / `{name}_i_wb_sel` / `{name}_i_wb_tga`（若有）→ `{name}_o_wb_ack` / `{name}_o_wb_dat`。  
- **禁止**再引入第二套完成口。

### 5.5 ACK 时序（已裁定：**同拍**）

| 项 | 裁定 |
|---|---|
| **ACK** | **同拍**：`CYC & STB` 且命中的**当拍**拉 `ACK`；读则 **同拍**给出 `DAT_*` |
| **完成语义** | **仅** `ACK`；**禁止**再导出 `rddata_vld` / 第二套完成口 |
| **打拍** | **regfile 叶子不负责**为时序打拍；长线 / Fmax 交给 [`wishbone-bus.md`](./wishbone-bus.md) **pipe** |
| ~~+1 拍 ACK~~ | **不做**（勿把主干 `rddata_vld` 节奏搬进叶子） |

`read_write_block=true` 且对应 RWE 的 **`ext_<field>_ready` 为 0** 时：**可以**在本应同拍 ACK 的拍上**推迟** `ACK`（仍无 vld 口）。**非 RWE** **禁止**因此拖 ACK。

### 5.6 地址与 `SEL`（已裁定：**byte**）

数据通路已冻结：`DAT_*`=32、`SEL`=4；**`ADR` = 字节地址**（与 [`wishbone-bus.md`](./wishbone-bus.md) §2 **同裁**）。

| 项 | 裁定 |
|---|---|
| **`ADR`** | **字节地址**；相邻 cell 典型 `ADR` 差 **4**（`0x00` / `0x04` / `0x08`…） |
| **`SEL`** | 仍选字节；部分写靠 `ADR`（可指字内字节）+ `SEL`；写路径语义见下表 |
| **译码** | 对齐到 word 边界再比 Cell 基址（例：用 `ADR[W-1:2]` 或 `ADR & ~2'b11`） |
| **Cell/Block `offset` / `bytes_align` / 自动拼 cursor** | **一律按字节**（`bytes_align` 为 4 的倍数） |
| ~~word~~ | **不做** |

**部分写（`SEL`）语义（已裁定，generate 必须落地）**：总线写只更新 `SEL` 选中的字节 lane；未选中 lane 覆盖到的 field bit **必须**保持原值。

| Access | 部分写行为 |
|---|---|
| RW / RWW（SW 写） | 按 lane 屏蔽的 read-modify-write（未选 lane 保持） |
| W1C | 写数据先按 `SEL` 屏蔽再清（未选 lane 的 1 **不**清）；硬件 `_set` 不受 `SEL` 限制，和同拍软件清除相比 **set 优先** |
| W1P | 脉冲数据按 `SEL` 屏蔽（未选 lane 不出脉冲位） |
| RWE | 叶子导出 **`ext_<field>_wstrb`**（`_wren` 限定；位宽 = 字段覆盖的字节 lane 数）；外部窗 **必须** 按 wstrb 做部分写 |
| RO / RC | 无写路径，不受影响 |
| shadow 各 copy | 同一屏蔽规则逐 copy 生效；HW `_strb`/`_hwdata` 写 **不** 受 `SEL` 约束（整字段写） |

口名与 bus 已对齐（§5.4）；实现以 `help status` 为准（当前：**implementing now**）。

### 5.7 Shadow 索引：仅 `wb_tga`（已裁定）

Shadow 选 bank **只**来自 Wishbone **TGA** 切片（与本次事务同拍）：

```text
effective_<s>_sel = wb_tga[tag-bits]   // tagBits 强制；无 local_sel / 无 takeover
```

- **禁止** `takeover` / `local_*_sel` 旁路口（旧双源作废；等价 takeover **恒 0**）。  
- **`tagBits` 强制**：每个 Shadow **必须**占一段 `wb_tga`；**禁止**省略。  
- 叶子 `wb_tga` 口宽 = 本表所有切片的 **最高位 + 1**。  
- 总线侧：[`wishbone-bus.md`](./wishbone-bus.md) 对启用了 tag 的路径 **必须**透传 TGA；互联 **不解释**位语义。  
- **C 头 / `uvm_reg`（软件导出）**：只体现 **字段 layout**；shadow **仅注释**（名 / copies）。**禁止**写 `tagBits`、`remaps`、物理 copy 展开、cell 地址或整表 overlay。窗基址、cell 编排、TGA 选 bank **由 bus 组装**（见 [`wishbone-bus.md`](./wishbone-bus.md)）。RTL 叶子仍按本节切 `wb_tga`。  
- v1 **只开 `wb_tga`**，不开 `tgc`/`tgd` 作 shadow 索引。  
- 硬件若要「跨当前 pstate 改下一 bank」：走 **`inner_shadow_mux=false`** 的旁路数组 / RWE 自理，**不**另开本地 sel 接管。

**域上移（提案，待裁定）**：`Shadow(name, copies, tagBits)` 写在本表内 ⇒ 多表共用同一域（HBM：16 channel × `aword`/`dword*`）要抄 N 份，跨表位置同义性无人校验。提案把域拆成独立共享导出 `ShadowDomain(name, copies, width)`，本表只写 `.shadow(domain)` + per-copy `reset`；`tagBits` 与「值从哪来」移交总线 `tags`（裸=透传 / `TagFromAddr` / `TagFromPin` / `TagFromReg`）。完整规则见 [`wishbone-bus.md`](./wishbone-bus.md) §2.1。落地前本节仍为现行契约。

#### 多 shadow + `wb_tga` 切片

```text
wb_tga[W-1:0]  =  { … | shadow_B[tag-bits] | shadow_A[tag-bits] | … }
                    ↑ 各 Shadow(...) 在 Regfile opts.shadows 内声明；切片禁止重叠
```

TS 草案：

```ts
RegfileDefault.addrWidth(8).shadows(
  Shadow("lane", 4, "1:0").remaps({
      0: 0b0001, // → copy 0
      1: 0b0100, // → copy 2
      2: 0b0010, // → copy 1
      3: 0b1111, // broadcast all 4 copies
    }),
  Shadow("page", 8, "4:2"),
)
```

规则：

1. tag v1 **只允许** `wb_tga`；**`tagBits` 为 Shadow 强制参数**（`Shadow(name, copies, tagBits)`）。  
2. 同一表内所有 `tagBits` **禁止**重叠。索引编码 **只接受 bin**：位宽 = `ceil(log2(copies))`（`copies=1` → 0 bit 切片/空串约定由 generate 校验）；声明的 `tagBits` 宽度 **必须**与此一致。**禁止** `mode`；**禁止** onehot。  
3. 叶子 `wb_tga` 口宽 = 本表所有 TGA 切片的 **最高位 + 1**。  
4. （总线 TGA 透传见上节。）  
5. Cell 的 `.shadow("lane")`（或 Block 缺省继承）只引用名；该 cell **全部** field 共用；有效 bank = `wb_tga` 再经 **`remaps` bitmask**。**禁止** Field 级 shadow / 同 cell 混 shadow。  
6. **禁止**再给 field 单独开第二套 bank sel；Access 旁路与 `wb_tga` 索引是不同通道。  
7. **缺省继承**：Block → Cell（仅此两级）；表级 `shadows(...)` 仍只做**库声明**。  
8. **Per-copy reset**：dict key = **物理 copy**；**未列默认 0**；标量 = 各 copy 同值。  
9. **`inner_shadow_mux`（同级 bool；缺省 `true`）**：见下「旁路导出 vs 内部 shadow mux」。  
10. **宽 field**：拆片 cell 同 shadow；模块边界旁路/输出 **自动拼齐**为完整宽度。

#### `inner_shadow_mux`：内选 vs 全导出（已倾向）

典型动机：`timing_param[phy_pstate]`——`phy_pstate` 是**当前**运行选择。training 常要在仍处当前 pstate 时改写下一份参数。

| `inner_shadow_mux` | 行为（适用 Access） |
|---|---|
| **`true`（缺省）** | `wb_tga` 译码后的有效 sel 在叶子内选 bank；旁路只对应当前选中 copy。 |
| **`false`** | 各物理 copy 旁路**按数组导出**（一 lane / copy）；总线读/写仍用 `wb_tga` 译码选通当前可见 bank。 |

**适用 / 不适用**

| Access | 与 shadow / `inner_shadow_mux` |
|---|---|
| **RW / W1P / W1C** | 适用：`true` 内选一套旁路；`false` 按 copy 数组导出 |
| **RWW** | 适用：**`true`** → `_strb`/`_hwdata` 打**当前**选中 copy；**`false`** → `_strb`/`_hwdata` **导出成数组**，下标对应各物理 shadow copy |
| **RO** | **支持 shadow**；功能 in **恒 per-copy 数组**；读数据 = 译码 bitmask 选中各 copy **按位或**（单 bit 即选那一份）；**`inner_shadow_mux` 无意义** |
| **RWE** | **支持 shadow**；`inner_shadow_mux` **不**改数据旁路口形；译码后 sel **原样**给外部窗 |
| **RC** | 无关（无功能旁路）；若挂 shadow，复位常数仍为标量（各 copy 同常量） |

```ts
Shadow("pstate", 4, "1:0")
Shadow("pstate", 4, "1:0").innerShadowMux(false)
Shadow("lane", 4, "1:0").remaps({ 3: 0b1111 }) // from 3 → broadcast

Cell("CFG0", "Main config", CellDefault.align(BitsAlign.Align8).shadow("lane"), [
  Field("enable", Access.RW, 1, "Soft enable").reset(0),
  Field("mode", Access.RW, 3, "Operating mode").reset(0), // same cell → same shadow
])
```

- **禁止**把 `inner_shadow_mux=false` 理解成「取消 shadow」。  
- **RWE + shadow**：索引照常译码并透传 sel；**禁止**因本开关复制 RWE `_wdata`/`_wren`/… 套数。

#### 可选：`remaps`（单一映射机制）

挂在 **单个** `Shadow(...)` 上；**尽量只此一种**映射 API（**不**另设 decode / **无** `ShadowBroadcast`）。**省略整组** `remaps` → 有效索引直接当物理 copy（identity，等价 `1 << from`）。**写出了** `remaps` 但 **from 未列出** → **空操作**（不打任何 copy），Wishbone **仍正常 ACK**（`ACK=1` 按时序），**禁止**因此卡死总线。

| `from`（键） | `to`（值） | 含义 |
|---|---|---|
| bin 索引（number） | **bitmask**（number） | bit k 置位 ⇒ 命中物理 copy k；多 bit = 多播 / 广播 |

流水线（概念）：

```text
effective_sel = wb_tga[tag-bits]
    →  lookup remaps[from] → bitmask of physical copies
         · 整组 remaps 省略 → identity：`1 << from`
         · 有 remaps 且 from 未列出 → **空操作**（无 copy）；**ACK 仍正常**（已裁定）
    →  RW*/W1*/RWW：按 inner_shadow_mux 做字段旁路选通或按 copy 数组导出
    →  RO：功能 in 为 per-copy 数组；读 = bitmask 选中 copy **按位或**（空操作时读数据为 0）；无视 inner_shadow_mux
    →  RWE：译码后 sel **原样**旁路给外部窗（外部自理 bank）；空操作时旁路不点火，ACK 仍正常
```

- 可多条 remap；同一 `from` **禁止**重复。  
- bitmask **禁止**超出 `copies` 位宽；**禁止** `to=0`（显式条目不能写 0；未命中用「不列出」表达空操作）。  
- **写**遇多 bit mask：打到所有置位 copy（广播写）。  
- **读**遇多 bit mask：选中 copy 的读数据 **按位或**到一起。  
- **未命中**：**禁止**拖 ACK / 报总线 error 来堵死；与 `read_write_block` 无关——这是译码空槽，不是 RWE 背压。
- **scalar sel 裁定**：`o_<shadow>_sel` 与内选（`inner_shadow_mux=true`）旁路在多 bit mask 时取 **最低置位 copy**（first-set priority，generate 必须稳定实现）；读路径仍按上一条 **按位或**。广播写后各 copy 相等时二者一致；需要广播语义的消费者用 per-copy 数组旁路（`inner_shadow_mux=false`），**禁止**把 scalar sel 当广播掩码用。

#### 与旧「A/B 互斥」的关系

旧双源（`wb_tga` + local/`takeover`）**作废**。现契约：索引 **仅** `wb_tga`（`tagBits` 强制）；**禁止** takeover / local_sel 口。

译码-sel-to-RWE / ready 口名见 §5.4（已裁定）。

功能与口名裁定齐后，实现仍以 `help status` 为准（当前：**implementing now**）。

## 6. 工作区（草案）

```toml
# 全局：同一 SoT 的非 RTL 导出（文档 / 固件 / UVM）；均非 SoT
[plugins.wishbone]
export = "fw/gen/wishbone/wishbone.xlsx"  # field sheets + MAP_<bus>
c      = "fw/gen/wishbone"                # <sheet>.h + <bus>_map.h + wishbone.h
uvm    = "dv/ral"                         # ral_<SHEET>.sv + ral_block_* + ral_wishbone.sv

# source_id = SoT 文件槽（可含 RegfileDef 与/或 BusDef）；不是单个叶子名
[wishbone.examples]
ts = "docs/examples/regfile/regfile.ts"
# exports = ["sub_module_a"]   # 可选；省略 = 文件内全部 RegfileDef 与 BusDef

# RTL out → [dump] plugins_dir/wishbone/<name>_regfile.sv
```

- **禁止**在 toml 写 pin 级连线。  
- **禁止** `html=` 作为寄存器 SoT；**禁止** `tables = "regpy/"` 一类非 TS SoT。  
- **禁止**按叶子各写一份 `excel=` / `c=` / `uvm=`；路径只认 **`[plugins.wishbone]`**。  
- **禁止**配置 `data_width`（数据通路固定 32）。  
- 省略某键 → 跳过该导出。键必须是非空字符串。  
- Excel 工作表名来自 **有效 `sheet`**（缺省 = `name`），不是 HTML 属性。同 sheet 的多例化共用一份软件/文档产物。  
- C / uvm_reg / Excel **禁止**进 `plugins_dir`（那是 SV 叶子）；也 **禁止**当 connect/sim dump。
- demo/soc：一份 `sha256` SoT → `sha256_regfile.sv` + `sha256.h` + `ral_SHA256.sv`；channel bus `SlaveRegfile(sha256, 0x40)` 挂一次，两个 `SlaveBus` channel 例化同一 `sd_sha_system`；HTML **不再** `aw-inst mod="sha256_regfile"`。窗基址与 cell offset 打进同一套 `[plugins.wishbone] c=`（`soc_wb_map.h` overlay `ch0_sha256` / `ch1_sha256` + `wishbone.h`）；`fw/common/soc_map.h` 只做别名。C 头 **入库展示**（`fw/gen/wishbone/*.h`，与 `demo/soc/rtl/gen/` 同类；**禁止**当临时产物删掉）。uvm_reg 落在 `dv/ral/`（**不是** `.ralf`）；`ral_block_soc_wb.sv` 与 `ral_wishbone.sv` 同套打包。

### 6.1 C 头、uvm_reg 与 Excel（已裁定；C / uvm_reg / Excel emit 已落地）

与 Excel 同类：**只是 SoT 的导出**。**禁止**从 `.h` / `uvm_reg` / Excel 回写 TS。

软件操作分两层（叶子 layout ≠ 系统地址图）：

```text
wishbone generate（同一插件；RegfileDef / BusDef 类型分立）
    每 cell：字段位域 layout
    shadow：只当注释（名 / copies）
        ↓
    SlaveRegfile(RegfileDef, base) 窗 + 叶子 cell 相对 offset → 绝对 MMIO
    打包：一份 Excel / 一套 C / 一套 uvm_reg
```

| 产物 | toml | 落盘 | 本插件写出 | **不**在本插件 |
|---|---|---|---|---|
| Excel | `export=` **文件** | 每表一 sheet | 对照主干 `gen_excel_doc.py`：**cell 黄行 + field 行（MSB 在上）+ reserved 灰行**；公式算位宽 / `'h` / `DEC2HEX` / 加权复位和。列：Sub-Addr（叶子 byte offset，无 `0x`）/ Start Bit / End Bit / Bit Width / Default Value / R/W Property / Name / Description / Reset Dec / Hex / Sum / SHADOW（仅 cell 行填 `shadow` 名）。**删**主干空列 A、`Selection ADDRWIDTH`（恒空；窗宽/TGA 归 bus）。复位只写 copy 0。字段 `note` 写在同一 Description 单元格：第一行仍是 `desc`，换行后是正文。表级 `note` 挂在表头 Description 批注（插数据行会错开位宽公式）。**禁止**墙钟/用户名；**禁止**把 `note` 写进 RTL / C / uvm_reg | 窗基址、TGA/`tagBits`、`remaps`、物理 copy 展开 |
| C | `c=` **目录** | `<sheet>.h`（空 = `name`；同 sheet 只写一份） | 对照主干 `gen_chead.py` 的 **cell 形**：每 cell `struct …_BITS` 位域 + `union { volatile uint32_t all; … bit; }`。LSB=0 与 Field bit `offset` 一致。shadow 只写注释。头稳定（plugin id + 表名），**禁止**墙钟/用户名 | `OFFSET_*` / 带 padding 的整表 overlay / 窗基址 / TGA |
| UVM | `uvm=` **目录** | `ral_<SHEET>.sv` | 对照主干 `gen_ralf.py` 的 **cell 级结果**：`class ral_reg_<table>_<cell> extends uvm_reg` + `uvm_reg_field`（width / lsb / access / reset）。**禁止** `.ralf` 文本。shadow 只写注释 | `ral_block_*` 的 `default_map.add_reg(offset)`、窗基址、TGA；block 组装归 bus |

复位值：标量 `.reset`；dict 只取 **copy 0**（与「可见的一份」一致）。Access → `uvm_reg_field` 的 `access` 字符串沿主干 `field.access.ral_name`（实现时对照 Python Access）；C 位域不编码 Access。

## 7. 不做（v1）

- 整窗 `block_regfile` / 千 Cell 固件镜像（memory window + 可选后期 RAM slave）。  
- 叶子内 APB、FIFO bridge。  
- Pipelined Wishbone `STALL`。  
- 插件私有口表绕过 RtlIndex。  
- 以 HTML 字段树 / Excel / C 头 / `uvm_reg` / Python / JSON / regpy 为寄存器 SoT，或从这些产物生成 TS。  
- 嵌套 `awx-reg-*` 子标签（block/cell/field/shadow）；HTML 桩有子女 → 错误。  
- 从 regfile 的 C/`uvm_reg` 导出里写地址图或 fabric shadow tag（`OFFSET_*`、整表 overlay、`add_reg(offset)`、`tagBits` / TGA / copy 展开）——软件地址与选 bank **由 bus 组装**。

## 8. 待你裁定（清单）

已裁定：

- ~~Table 载体 / SoT~~ → **TypeScript `RegfileDef` 命名导出**（`Regfile(...)`）；未挂 bus 时 connect `<aw-inst mod="*_regfile">`，已挂则只出现在 bus wrapper。  
- ~~Excel~~ → 工作表名 = `RegfileDef.sheet`（空/缺省 = `name`）；工作簿 = `plugins.wishbone.export`（仅文档）。  
- ~~数据/地址位宽~~ → **`DAT_*` 固定 32**（`SEL`=4）；**`addr_width` 必填**（TS opts，无缺省）。  
- ~~地址标记 / 对齐~~ → Cell/Block **`offset` 可省略**；按 `bytes_align`（4 的倍数）**编译器式自动拼接**；写出 `offset` 才钉址。  
- ~~Cell / Field~~ → cell **固定 32**；**可**在 block 内或 **独立**挂在 regfile body；`bits_align` 缺省 **8**；field **禁止** `bits`，用 **`width` + 可选 bit `offset`**；**`desc` 必填**。  
- ~~Block 超长 field~~ → block 下可直挂宽 field，**自动拆**成多 cell；口上旁路/输出 **自动拼齐**；拆片 cell **同** Block shadow 缺省。  
- ~~Shadow~~ → 表级库 + **仅 Cell 配置**（Block 为 Cell 缺省）；**禁止** Field 级 / 同 cell 混 shadow；**拼车必须同 shadow**；`remaps` bitmask；`inner_shadow_mux`（RO 不吃）；RWE 译码 sel 原样旁路。  
- ~~Access **RC**~~ → **ReadConst**：读回 `.reset(n)` 标量常数；无功能旁路 in；与 RO 区分。  
- ~~Field `.reset`~~ → `number | Record<copyIndex, number>`；dict **缺口默认 0**；RC 仅标量。  
- ~~Access **无 W1S**~~ → 只保留 **W1P** / **W1C**；置位用 **RW**。  
- ~~`read_write_block`~~ → 表级；缺省 **false**（非阻塞）；**true** 时仅 **RWE** 命中可挡 WB `ACK`（如 FIFO）。  
- ~~`tagBits` 强制~~ → `Shadow(name, copies, tagBits)`；必占 `wb_tga` 切片；**禁止**省略。  
- ~~Shadow 索引~~ → **仅 `wb_tga`**；**禁止** `takeover` / `local_sel`（takeover 语义恒 0）。  
- ~~`remaps` 未命中~~ → **空操作**（不打 copy）+ Wishbone **正常 ACK**（防卡死）；整组省略 `remaps` 仍为 identity。  
- ~~广播读~~ → bitmask 多 bit 时读数据 **按位或**。  
- ~~RO + shadow 口形~~ → 功能 in **恒 per-copy 数组**；读用 bitmask（或）。  
- ~~宽 field 内部分片名~~ → cell/field 片 `<name>_<i>`（`i`=0 = LSB）；desc/注释带完整空间 `name[hi:lo] of [W-1:0]`；对外拼齐。  
- ~~plugin id~~ → **一套**：`wishbone`（`RegfileDef` / `BusDef` 类型分立；toml `[wishbone.*]` + `[plugins.wishbone]`；一次 generate 打包 Excel / C / uvm_reg）。旧 id `wishbone-regfile` / `wishbone-bus` 为别名。  
- ~~固件窗~~ → v1 **只预留**描述/不做整窗 RAM 生成（§7）。  
- ~~导出名 vs `name`~~ → **必须相同**。  
- ~~`ADR` 语义~~ → **byte**（字节地址；`offset`/`bytes_align`/cursor 均按字节；与 bus 同裁）。  
- ~~ACK~~ → **同拍**；regfile **不**为时序打拍；长线交给 bus **pipe**；**禁止** +1 ACK / 叶子 `rddata_vld`。  
- ~~§5.4 命名~~ → WB **`{name}_i_wb_*`/`{name}_o_wb_*`**；clk/rst **`i_clk`/`i_rst_n`**；旁路 **Access 前缀**（`ro_`/`rg_`/`ext_`/`p_rg_`/`c_rg_`）；默认 **`logic`**；模块 **`<table>_regfile`**。  
- ~~RWE 口形~~ → `ext_<field>` + `ext_<field>_{wdata,wstrb,wren,rden,rst}`；shadow **`o_<shadow>_sel`**；`read_write_block` → **`ext_<field>_ready`**（缺省表级 false=非阻塞）。
- ~~`SEL` 部分写语义~~ → 按 lane 屏蔽 RMW（RW/RWW）；W1C/W1P 屏蔽写数据；RWE 导出 **`ext_<field>_wstrb`**（§5.6 表）；HW `_strb` 写不吃 `SEL`。
- ~~W1C 置位通路~~ → **`c_rg_<field>_set`** 硬件置位 in；同周期 **set 优先**于 W1C 清；仍 **无 W1S**。
- ~~RWW 同周期优先级~~ → **SW 写优先**于 HW `_strb`（HW 写被吞）。
- ~~scalar shadow sel~~ → 多 bit mask 时 `o_<shadow>_sel` / 内选旁路取 **最低置位 copy**；读仍按位或。
- ~~C / uvm_reg 软件分层~~ → 叶子只出 **字段 layout**（struct 位域 / `uvm_reg`）；软件文件名 = 有效 **`sheet`**（空 = `name`）。多硬件例化（不同 `name`）**必须**共用同一份 C/`uvm_reg`，只要 `sheet` 相同且 layout 一致；`name` 只服务 SV 叶子 / WB identity。shadow **仅注释**；窗基址、cell 编排、TGA 选 bank **由 bus 后组装**。Excel 仍可文档化叶子 offset。与 Excel 一样禁止回写 TS。

**§8 功能裁定已齐。** `help status`：Wishbone **implementing now**。作者面 API 以 [`docs/examples/regfile/regfile.ts`](../../examples/regfile/regfile.ts) + `src/plugins/wishbone-regfile/dsl.ts` / `src/plugins/wishbone-bus/dsl.ts` 为准。

CLI：`autowire plugin generate wishbone`（需 `[wishbone.<source_id>] ts=`；一文件可多叶子 / 总线）。
