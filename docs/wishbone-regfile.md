# Wishbone 寄存器文件与配置总线（并列子系统）

> 状态：**草稿，先约束后实现**。不堵连接轨道；`help status` 仍标 Parallel。  
> 对照：主干 Python `autowire/cfgbus` + `autowire/regtable`（APB 外口 + 自研 `wren/rden/rddata_vld`）。  
> 摘要：`bun index.ts help` 的 Parallel 条；改本文时同步 `help status` / `docs/architecture.md` §5。

关键字「必须 / 应当 / 可以」按 RFC 2119。

## 1. 目标

把 **Register Table（数据）** 与 **配置互联（RTL）** 做成 Wishbone Classic 外设树：

- 端点协议 **必须**是 Wishbone Classic（精简子集），**禁止**再发明第二套 `wren/rden/rddata_vld` 内核。  
- 读写完成 **必须**用 `ACK`（可读 `ERR`）；**禁止**用读有效信号冒充写完成。  
- 长路径 **必须**用对称 register slice 打 pipe（§4），**禁止**为 pipe 改成 Pipelined B4（regfile 默认不做）。  
- APB **可以**作为芯片边界可选桥（`apb2wb`），**禁止**成为 regfile / decoder 的原生口。  
- 与 `demo/soc` 外设口 **应当**同形，便于同一套主机/交叉开关。

不在本文范围：connect 方言落地、dump 打印机、Excel 当 SoT（Excel **只出文档**）。

## 2. 与旧 Python 的切割

| | 主干 Python | 本设计 |
|---|---|---|
| 外口 | APB（`psel/penable/pready`） | Wishbone Classic |
| 内核 | `wren`/`rden` + `rddata_vld` | 与外口同协议（`STB/WE/ACK`） |
| 写完成 | 常靠读侧 vld | `ACK` |
| 长路径 | `PIPE_NUM` 切 cfg 信号束 | 请求/应答对称 WB slice |
| 数据模型 | `RegTable` / `RegCell` / `RegField` | 保留思路：`Table` + `Block` / `Cell` |
| 生成编排 | `CfgBusGenConfig` 递归 decoder | **插件**产出 WB 模块；connect **只例化** |

保留：字段属性（RW/RO/W1C…）、shadow、字节 `SEL`、地址图树。  
丢弃：cfgbus 内部信号名、APB 作为叶子协议。

## 3. Wishbone 子集（冻结）

端点 **必须**实现下列 Classic 信号（命名可 `i_wb_*` / `o_wb_*`，与 demo 对齐）：

| 信号 | 方向（slave） | 要求 |
|---|---|---|
| `CYC` | in | 事务周期；单拍外设 **可以**与 `STB` 同断言（文档视为等价） |
| `STB` | in | 本拍有效 |
| `WE` | in | 1=写，0=读 |
| `ADR` | in | 字节或字地址；实现 **必须**钉死一种并写进生成参数 |
| `DAT_O`（master→slave 写数据） | in | 数据宽默认 32 |
| `SEL` | in | 字节选通；宽度 = 数据宽/8 |
| `ACK` | out | 本拍完成；可晚于 `STB`（stall） |
| `DAT_I`（读数据） | out | 与 `ACK` 同拍有效（读） |
| `ERR` | out | 可选；默认恒 0 |
| `RTY` | — | **禁止**（本子集不实现） |

规则：

1. **单 outstanding**：master 在收到 `ACK` 前 **禁止**发下一拍。配置树默认如此。  
2. 写完成 = `STB & WE` 被 `ACK`；读完成 = `STB & ~WE` 被 `ACK` 且 `DAT_I` 有效。  
3. **禁止** Pipelined `STALL` 作为 v1 端点协议。  
4. 时钟/复位：与所在域 `clk` / `rst_n`（低有效）一致。

## 4. 长路径 pipe（register slice）

Pipe 是 **互联属性**，不是第二种总线。

```text
Master ──req──▶ [slice × N] ──▶ Decoder / Regfile
       ◀─rsp──  [slice × N] ◀── ACK / DAT_I
```

| 前向（req） | 返回（rsp） |
|---|---|
| `CYC`, `STB`, `WE`, `ADR`, `DAT_O`, `SEL` | `ACK`, `DAT_I`, 可选 `ERR` |

纪律：

1. 前向级数与返回级数 **必须**相同（参数 `PIPE_NUM`，默认 0）。  
2. `CYC` **必须**贯穿整笔，slice **禁止**拆事务。  
3. 单 outstanding ⇒ slice **不必**带事务标签。  
4. 树形译码：**可以**「先 slice 再译码」或「译码后每支路再 slice」；参数挂在该 hop。  
5. 生成物 **应当**与旧 `cfgbus_pipe` 同角色：纯寄存器切片，无协议转换。

## 5. 模块角色

```text
[可选 apb2wb]
      ↓ WB
  Arbiter（多 master，WB）
      ↓
  Decoder 树（地址窗 → 子 decoder / RegfilePort）
      ↓
  Regfile（Table 叶子，WB slave）
```

- **Regfile**：`Table`/`Block`/`Cell` → SV；口仅为 Wishbone slave + 字段旁路（shadow / 功能口）。  
- **Decoder**：地址窗 + 可选 broadcast；下行仍是 WB（`STB` 扇出，`ACK`/`DAT` 回并）。  
- **Arbiter**：多 WB master；公平或固定优先（实现时钉死一种默认）。  
- **RegFilePort**：地址图上的叶子引用，不是第二种口。

地址图数据仍在 Python/TS 的 Table 模型里；**禁止**把连线细节写进 `autowire.toml`。

## 6. 作为通用插件的一个实例

宿主插件机制见 [`plugins.md`](./plugins.md)。Wishbone regfile **必须**登记为 **类型 A（生成器）** 插件，而不是改写 connect 核心方言。

- **适合**：注册插件 id、自定义声明标签（如前缀 `awx-wb-…`）、toml 节、独立 `generate` → SV。  
- **适合**：其它功能模块（序列器、文档包、芯片专用骨架）用同一套注册表扩展。  
- **不适合**：在 connect 的 `<aw-submods>` 下挂生成器标签「直接生成」regfile——`aw-submods` 只容纳展开后的合法 `aw-mod`（类型 B）或手写包装模。

### 6.1 接法（必须）

```text
插件 generate：Table → *_regfile.sv / *_decoder.sv / *_arbiter.sv / slice
    →  autowire analysis（进 RtlIndex）
    →  connect：普通 <aw-inst mod="…"> + aw-connect 接 Wishbone 口
```

- connect **必须**把生成模块当 RtlIndex 叶子（或外包一层 `aw-mod`）。  
- **禁止**未展开的生成器标签进入 `[connect.<id>]` 的 dump 路径。  
- **禁止**在 `aw-template` / `aw-rewrite` 里吐 SV 源码。

### 6.2 声明标签（可以）

插件 **可以**提供 `awx-wb-regfile` 等声明标签，但：

1. 所在 HTML **禁止**当作连接页登记进 `[connect.<id>]`。  
2. 只驱动 `generate`；**不**进入 `/api/dump` 的 `aw-render`。  
3. 生成 SV 经 hdxml 后，connect 再引用。

### 6.3 边界

| 本插件 | 宿主 |
|---|---|
| Table→WB RTL；地址/字段 check；可选 Excel 文档 | 插件注册表；analysis / connect 流水线 |
| 可选 `apb2wb` | toml 只配路径，无 pin 级连线 |

落地：先 [`plugins.md`](./plugins.md) 登记约定 → Table + WB 子集 → 本插件 generate → connect 例化。  
**禁止**把本插件标签焊进核心 `aw.js` custom elements 表。

## 7. 工作区（草案）

```toml
# 并列；不是 [connect.*]
[regfile.phy]
tables = "regpy/"          # 或插件约定路径
out = "gen/regfile"        # 生成 SV；不放作者 SoT
pipe = 1                   # 默认 hop PIPE_NUM；0 = 组合/直通寄存策略由实现钉死

[regfile.phy.wishbone]
data_width = 32
# addr: "byte" | "word"    实现前裁定
```

- `[regfile.*]` **禁止**写 pin 级连线。  
- 生成目录 **应当**与 dump `gen/` 可并存但 **禁止**与 `.autowire/` 作者化。

## 8. 仍开放（实现前裁定）

1. 地址是字节还是字对齐（与 `SEL` 同时钉死）。  
2. Arbiter 默认策略（固定优先 vs round-robin）。  
3. 插件清单用 toml `[regfile.<id>]` vs 独立文件。  
4. Table 的载体：TS 类 vs JSON vs 插件声明 HTML（类型 A，见 plugins.md；**不得**进 connect `aw-submods` 当生成器）。  
5. 通用插件登记 API（见 [`plugins.md`](./plugins.md) §6）。

裁定后改本文 + `help status` Parallel 条，再动代码。
