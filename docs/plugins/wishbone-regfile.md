# Wishbone 寄存器文件（叶子）

> 状态：**实现中（功能裁定已齐；`help status`：wishbone-regfile implementing now；bus 仍 docs only）**。  
> 块内配置互联：[`wishbone-bus.md`](./wishbone-bus.md)。插件登记：[`README.md`](./README.md)。  
> 作者面草稿 / 示例：[`docs/examples/regfile/`](../../examples/regfile/)（`regfile.ts` SoT + `*_regfile.sv` 展示）。  
> 正式生成：`autowire plugin generate wishbone-regfile` → `[dump] plugins_dir/wishbone-regfile/`。  
> 主干对照：`master` 分支 `autowire/regtable/gen_verilog.py`、`regfile.py`、`common/verilog_model.py`。  
> 改本文时同步 bus 文开放项（地址/`SEL`）与 `help status` Parallel。

关键字「必须 / 应当 / 可以」按 RFC 2119。

## 1. 目标

把 **TypeScript `Regfile(...)` 命名导出（寄存器 SoT）** 落成 **Wishbone Classic slave 叶子**（regfile 模块）：

- 口协议 **必须**符合 [`wishbone-bus.md`](./wishbone-bus.md) §2 子集；**禁止**再发明 `wren/rden/rddata_vld` 内核。  
- 读写完成 **必须**用 `ACK`；**禁止**用读有效冒充写完成。  
- 数据模型：`Table` ≈ 一份导出的 `RegfileDef`；内含 Block / Cell / Field（Access 语义继承主干，见 §5）。  
- **SoT 只有** 配置的 `.ts` 模块中导出的 `RegfileDef`（见 §3.1）；**禁止** HTML 字段树、Python、Excel、regpy、其它 DSL 当寄存器权威。  
- Excel **只出文档**：工作簿 = `plugins.regfile.export`；工作表名 = `RegfileDef.sheet`（空/缺省 = `name`）。**禁止**当 SoT、**禁止**从 Excel 回写 TS。  
- 落盘后经 `analysis` 进 RtlIndex，connect HTML 用 **`<aw-inst mod="<name>_regfile">`** 例化（与普通叶子相同）。**禁止**再引入 HTML 寄存器桩标签。  
- 生成后经 `analysis` 进 RtlIndex；connect **只例化**，见 §4。

不在本文范围：arbiter/decoder 树拓扑、SoC fabric（见 bus 文）；connect 方言本身；整窗 RAM/`block_regfile`（后期，见 §7）。

## 2. 与主干 Python 的切割（叶子侧）

| | 主干 Python regtable | 本设计 |
|---|---|---|
| 叶子口 | `reg_wren/rden/bsel/addr/wdata` + `reg_rddata/rddata_vld` | Wishbone Classic slave（与 bus 文同子集） |
| 写/读完成 | 易蹭 `rddata_vld` | **仅** `ACK`（读时 `ACK`+`DAT_*` 同拍） |
| 数据模型 | `RegTable` / `RegCell` / `RegField`（Python 类） | **TS** `Regfile` / `Block` / `Cell` / `Field`（见 [`docs/examples/regfile/regfile.ts`](../../examples/regfile/regfile.ts)） |
| 文档 | 可导 Excel | Excel **只出文档**；簿 = `plugins.regfile.export`；表名 = `sheet`（空 = `name`） |
| SoT | Python + 可选 Excel | **仅** TS `RegfileDef` 导出；**禁止** HTML/其它 DSL 当权威 |
| 生成头 | username / 墙钟 / Python Info | 稳定头：plugin id + 表名（可复现） |

地址图树、decoder 递归生成属 **bus** 侧。

## 3. Regfile 叶子边界

```text
TS RegfileDef export (SoT)
    →  generate → *_regfile.sv  (+ Excel 文档 sheet)
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
  例：`export const smoke = Regfile("smoke", …)` → 模块 `smoke_regfile` → `<aw-inst mod="smoke_regfile">`。  
- toml **`[regfile.<source_id>]`** 的 id 只标识 **SoT 文件槽**（可含多个 export），**不必**等于某个叶子名。  
- 重名 / 找不到导出 → generate 报错。

**toml**

- `[regfile.<source_id>] ts = "regs/foo.ts"` 指向含 **一个或多个** `Regfile(...)` 导出的模块。  
- 省略 `exports` → generate **该文件内全部** `RegfileDef` 导出；可选 `exports = ["a", "b"]` 只生成列出的绑定。  
- **禁止** `html=` 充当 SoT。  
- **禁止**把 regfile 源登记为 `[connect.<id>]` / `[sim.<id>]`（生成走 plugin generate，不走 connect elaborate）。

**Connect 引用（非 SoT）**

- generate → `analysis` → RtlIndex 叶子后，在 connect HTML 里 **`<aw-inst mod="<name>_regfile">`**（可经薄包装适配 `i_clk`/`i_wb_adr` 口名）。  
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
| `desc` | Field / Cell / Block / Regfile **必须**提供（可维护性） |
| 数据通路 | Wishbone **`DAT_*` 固定 32 bit**；**`SEL` 固定 4**；**`ADR` = 字节地址**；一 cell = 一字 = 4 字节；**禁止** `data_width` |
| `addr_width` | Regfile opts **必须** `addrWidth(...)`（无缺省） |
| Excel 表名 | `RegfileDef.sheet`；缺省 / 空 = `name` |

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
3. 分片**内部**命名（已定）：cell ≈ `<field>_<i>`；field 片 ≈ `<name>_<i>`（`i` 自 0）；**旁路/功能口对外自动拼齐**为原 `width` 向量（作者不看分片口）。  
4. 拆出的连续 cell **共享**同一 shadow（来自 **Block** `.shadow(...)` 缺省；无则皆无）——宽 field **禁止**按分片挂不同 shadow。  
5. 与显式 `offset` 钉死的 cell **混排**：按定义序；**禁止**占用冲突。  
6. 作者 **应当**对超长逻辑场用 block 直挂 field，**不必**手写多 cell，也 **不必**手算地址或手拼旁路向量。

其它规则：

1. **一份** `RegfileDef` 导出 ↔ **一个**生成叶子模 + **一个** Excel 工作表（有效名 = `sheet`，空则 = `name`）。  
2. 同一 `.ts` 模块 / 工作区登记内可多个导出；导出名与**有效** `sheet` **必须**唯一，重名 → generate 报错。  
3. 有效 `sheet` **应当**用稳定标识符（推荐 `[A-Za-z_][A-Za-z0-9_]*`）；实现可拒绝空格/路径分隔符。  
4. 工作簿路径：`autowire.toml` 的 **`plugins.regfile.export`**（例 `"ip_regfiles.xlsx"`）；**永远**文档产物；改寄存器 **只改** TS。未配置 export → 可不写 Excel。  
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
    →  （若配置了 plugins.regfile.export）Excel 工作簿：
         每表一 sheet；名 = sheet（空则 = name）
    →  analysis（hdxml hash 增量）→ RtlIndex
    →  connect：<aw-inst mod="…_regfile"> + aw-connect 接 WB 口
       （口表只认 ctx.leaf；禁止插件 providePorts 旁路）
```

- **禁止**经 connect 路径直接吐 regfile SV——只走 generate → leaf → `<aw-inst>`。  
- 声明 **禁止**登记为 `[connect.<id>]` / `[sim.<id>]`；toml 用 `[regfile.<source_id>] ts=` 指向 SoT **文件**（可含多个 export）。  
- 字段重叠 / 有效 `sheet` 撞名 / 桩带子女等自检在 **generate** 失败即不落盘。  
- SV 只进 `plugins_dir/<plugin-id>/`；Excel 只写 `plugins.regfile.export` 所指工作簿，**禁止**当 SoT。

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
| Cell 注释带 hex 地址 | `// Addr: 0x… RegCell: …` | **保留** |
| 端口列对齐 | `Port.declare` 对齐 | **始终**按工作区 `[style] port_align` / `signal_align` 同规则排（dir / type / packed 分列；声明块集中在端口后） |

**Access → 旁路口（语义 + §5.4 拼写）**

| Access | 含义 | 旁路 / 读通路 |
|---|---|---|
| **RC** | **ReadConst**：总线读回**编译期常数**；**无**功能 in；写忽略或 generate 可拒 | 读 mux 接 `.reset(n)`；**禁止**旁路 in |
| RO | 功能只读 | `ro_<field>` in（shadow → per-copy 数组）；读 = 译码 bitmask **或**；**`inner_shadow_mux` 无意义** |
| RW | 内部 regbit | `rg_<field>` out（`inner_shadow_mux=false` → 按 copy 数组） |
| RWW | 软硬件可写 | `rg_<field>` out + `rg_<field>_strb` / `rg_<field>_hwdata` in |
| RWE | 外部寄存器窗 | `ext_<field>` in + `ext_<field>_{wdata,wren,rden,rst}` out；shadow → **`o_<shadow>_sel`**；表级 `read_write_block` → **`ext_<field>_ready`** 可拖 ACK |
| W1P | 写 1 → 单拍脉冲 | `p_rg_<field>` out |
| W1C | 写 1 → 清 sticky | `c_rg_<field>` out |
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
module <table_name>_regfile (
  // clock / reset
  // wishbone classic slave  — 唯一总线口（命名 §5.4 / bus §2）
  // field / shadow sideband — Access 映射
);
  // 1. internal: hit, wr_fire, rd_fire, addr decode, sel
  // 2. per-cell wr_sel_<hex> / rd_sel_<hex>   （可沿用主干内部名）
  // 3. regbit always blocks（结构沿用 regbit_block_template，激励改 WE/SEL）
  // 4. read mux → 读数据；ACK 时序（§8 待裁定）
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
| WB 端口 | **`i_wb_*` / `o_wb_*`**（对齐 demo/soc；与 bus 同裁） |
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
| **RWE** | `ext_` | `ext_<field>` in + `ext_<field>_{wdata,wren,rden,rst}` out；**无**总线 vld |
| **W1P** | `p_rg_` | `p_rg_<field>` out（单拍脉冲） |
| **W1C** | `c_rg_` | `c_rg_<field>` out |
| RWE + shadow 译码 sel | — | **`o_<shadow>_sel`**（该 shadow 一份；非 Access 前缀） |
| `read_write_block` + RWE ready | — | **`ext_<field>_ready`**（仅表级 `read_write_block=true` 且该 field 为 RWE） |

- WB 束示例：`i_wb_cyc` / `i_wb_stb` / `i_wb_we` / `i_wb_adr` / `i_wb_dat` / `i_wb_sel` / `i_wb_tga`（若有）→ `o_wb_ack` / `o_wb_dat`。  
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
| **`SEL`** | 仍选字节；部分写靠 `ADR`（可指字内字节）+ `SEL` |
| **译码** | 对齐到 word 边界再比 Cell 基址（例：用 `ADR[W-1:2]` 或 `ADR & ~2'b11`） |
| **Cell/Block `offset` / `bytes_align` / 自动拼 cursor** | **一律按字节**（`bytes_align` 为 4 的倍数） |
| ~~word~~ | **不做** |

未与 bus 口名同步实现前，生成器仍按 help：**docs only — not implementing now**；语义与命名以本文为准。

### 5.7 Shadow 索引：仅 `wb_tga`（已裁定）

Shadow 选 bank **只**来自 Wishbone **TGA** 切片（与本次事务同拍）：

```text
effective_<s>_sel = wb_tga[tag-bits]   // tagBits 强制；无 local_sel / 无 takeover
```

- **禁止** `takeover` / `local_*_sel` 旁路口（旧双源作废；等价 takeover **恒 0**）。  
- **`tagBits` 强制**：每个 Shadow **必须**占一段 `wb_tga`；**禁止**省略。  
- 叶子 `wb_tga` 口宽 = 本表所有切片的 **最高位 + 1**。  
- 总线侧：[`wishbone-bus.md`](./wishbone-bus.md) 对启用了 tag 的路径 **必须**透传 TGA；互联 **不解释**位语义。  
- v1 **只开 `wb_tga`**，不开 `tgc`/`tgd` 作 shadow 索引。  
- 硬件若要「跨当前 pstate 改下一 bank」：走 **`inner_shadow_mux=false`** 的旁路数组 / RWE 自理，**不**另开本地 sel 接管。

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

#### 与旧「A/B 互斥」的关系

旧双源（`wb_tga` + local/`takeover`）**作废**。现契约：索引 **仅** `wb_tga`（`tagBits` 强制）；**禁止** takeover / local_sel 口。

译码-sel-to-RWE / ready 口名见 §5.4（已裁定）。

功能与口名裁定齐后，实现仍以 `help status` 为准（当前：**not implementing now**）。

## 6. 工作区（草案）

```toml
# 全局：regfile 插件把各 RegfileDef 写进同一工作簿（文档产物；非 SoT）
[plugins.regfile]
export = "ip_regfiles.xlsx"

# source_id = SoT 文件槽（可含多个 Regfile 导出）；不是单个叶子名
[regfile.examples]
ts = "docs/examples/regfile/regfile.ts"
# exports = ["sub_module_a"]   # 可选；省略 = 文件内全部 RegfileDef

# out → [dump] plugins_dir/wishbone-regfile/<name>_regfile.sv
```

- **禁止**在 toml 写 pin 级连线。  
- **禁止** `html=` 作为寄存器 SoT；**禁止** `tables = "regpy/"` 一类非 TS SoT。  
- **禁止**按叶子各写一份 `excel=`；工作簿路径只认 **`plugins.regfile.export`**。  
- **禁止**配置 `data_width`（数据通路固定 32）。  
- Excel 工作表名来自 **`RegfileDef.sheet`**（缺省 = `name`），不是 HTML 属性。

## 7. 不做（v1）

- 整窗 `block_regfile` / 千 Cell 固件镜像（memory window + 可选后期 RAM slave）。  
- 叶子内 APB、FIFO bridge。  
- Pipelined Wishbone `STALL`。  
- 插件私有口表绕过 RtlIndex。  
- 以 HTML 字段树 / Excel / Python / JSON / regpy 为寄存器 SoT，或从 Excel 生成 TS。  
- 嵌套 `awx-reg-*` 子标签（block/cell/field/shadow）；HTML 桩有子女 → 错误。

## 8. 待你裁定（清单）

已裁定：

- ~~Table 载体 / SoT~~ → **TypeScript `RegfileDef` 命名导出**（`Regfile(...)`）；connect 只 `<aw-inst mod="*_regfile">`。  
- ~~Excel~~ → 工作表名 = `RegfileDef.sheet`（空/缺省 = `name`）；工作簿 = `plugins.regfile.export`（仅文档）。  
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
- ~~宽 field 内部分片名~~ → cell/field 片 `<name>_<i>`；对外拼齐。  
- ~~plugin id~~ → **分立**：`wishbone-bus` 与 `wishbone-regfile`（共享协议子集文档，生成器分开）。  
- ~~固件窗~~ → v1 **只预留**描述/不做整窗 RAM 生成（§7）。  
- ~~导出名 vs `name`~~ → **必须相同**。  
- ~~`ADR` 语义~~ → **byte**（字节地址；`offset`/`bytes_align`/cursor 均按字节；与 bus 同裁）。  
- ~~ACK~~ → **同拍**；regfile **不**为时序打拍；长线交给 bus **pipe**；**禁止** +1 ACK / 叶子 `rddata_vld`。  
- ~~§5.4 命名~~ → WB **`i_wb_*`/`o_wb_*`**；clk/rst **`i_clk`/`i_rst_n`**；旁路 **Access 前缀**（`ro_`/`rg_`/`ext_`/`p_rg_`/`c_rg_`）；默认 **`logic`**；模块 **`<table>_regfile`**。  
- ~~RWE 口形~~ → `ext_<field>` + `ext_<field>_{wdata,wren,rden,rst}`；shadow **`o_<shadow>_sel`**；`read_write_block` → **`ext_<field>_ready`**（缺省表级 false=非阻塞）。

**§8 功能裁定已齐。** `help status`：wishbone-regfile **implementing now**；bus **docs only**。作者面 API 以 [`docs/examples/regfile/regfile.ts`](../../examples/regfile/regfile.ts) + `src/plugins/wishbone-regfile/dsl.ts` 为准。

CLI：`autowire plugin generate wishbone-regfile`（需 `[regfile.<source_id>] ts=`；一文件可多叶子）。
