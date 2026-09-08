# Wishbone 寄存器文件（叶子）

> 状态：**草稿，先约束后实现**。不堵连接轨道；`help status` 仍标 Parallel。  
> 块内配置互联（bridge / arbiter / decoder / pipe、IP vs SoC 边界）：[`wishbone-bus.md`](./wishbone-bus.md)。  
> 插件登记：[`README.md`](./README.md)。改本文时同步 `help status` / [`../architecture.md`](../architecture.md) §5。

关键字「必须 / 应当 / 可以」按 RFC 2119。

## 1. 目标

把 **Register Table（数据）** 落成 **Wishbone Classic slave 叶子**（regfile 模块）：

- 口协议 **必须**符合 [`wishbone-bus.md`](./wishbone-bus.md) §2 子集；**禁止**再发明 `wren/rden/rddata_vld` 内核。  
- 读写完成 **必须**用 `ACK`；**禁止**用读有效冒充写完成。  
- 数据模型保留主干思路：`Table` + `Block` / `Cell`（字段 RW/RO/W1C…、shadow、字节 `SEL`）。  
- Excel **只出文档**，**禁止**当 SoT。  
- 生成后经 `analysis` 进 RtlIndex；connect **只例化**，见 §4。

不在本文范围：arbiter/decoder 树拓扑、SoC fabric（见 bus 文）；connect 方言本身。

## 2. 与旧 Python 的切割（叶子侧）

| | 主干 Python regtable | 本设计 |
|---|---|---|
| 叶子口 | 常接自研 cfg / 经 APB 树 | Wishbone Classic slave（与 bus 文同子集） |
| 写完成 | 易蹭 `rddata_vld` | `ACK` |
| 数据模型 | `RegTable` / `RegCell` / `RegField` | `Table` / `Block` / `Cell` |
| 文档 | 可导 Excel | Excel 只出文档 |

地址图树、decoder 递归生成属 **bus** 侧，见 [`wishbone-bus.md`](./wishbone-bus.md)。

## 3. Regfile 叶子

```text
WB slave  ←──  (协议见 wishbone-bus.md)
   │
 Table / Block / Cell  →  字段旁路、shadow、功能口
```

- 生成模块 **必须**只暴露：Wishbone slave 束 + 字段/shadow 旁路（及必要 clk/rst）。  
- **禁止**在叶子上再包一层 APB；若芯片要 APB，用 bus 文中的边界 bridge。  
- `SEL` **必须**参与字节写；字段布局 **禁止**重叠（插件 check）。  
- shadow：**可以**多份拷贝 + 索引；语义实现前钉死默认。  
- **固件 / 大块存储：禁止**建成成千上万个 `Cell`。应是 **memory 窗口**（SRAM/ROM slave），只在 Table 里登记窗基址/长度/属性；实现与 CSR 译码分开。DMA 加载见 [`wishbone-bus.md`](./wishbone-bus.md) §5.1（后期）。

## 4. 作为生成器插件（类型 A）

宿主机制见 [`README.md`](./README.md)。本叶子 **必须**登记为 **类型 A**；可与 bus 生成器同插件或分立，但 **禁止**改写 connect 核心方言。

```text
generate：Table → *_regfile.sv
    →  analysis → RtlIndex
    →  connect：<aw-inst mod="…_regfile"> + aw-connect 接 WB 口
```

- **禁止**在 `aw-submods` 下用自定义标签直接吐 regfile 源码。  
- 声明标签（如 `awx-wb-regfile`）**可以**有，但所在页 **禁止**登记为 `[connect.<id>]`；只驱动 generate。

## 5. 工作区（草案）

```toml
[regfile.phy]
tables = "regpy/"
out = "gen/regfile"

[regfile.phy.wishbone]
data_width = 32
# addr: "byte" | "word"   — 与 bus 文同一裁定
```

- **禁止**在 toml 写 pin 级连线。  
- 生成目录 **禁止**作者化进 `.autowire/`。

## 6. 仍开放

1. 地址字节 vs 字（与 bus / `SEL` 同时钉死）。  
2. Table 载体：TS / JSON / 插件声明 HTML（类型 A）。  
3. shadow 默认语义。  
4. 与 bus 生成是否同一 `plugin id`。  
5. 固件窗是否生成简单 WB RAM slave 模板（后期；默认手写 SRAM + 地址窗）。

裁定后改本文 + bus 文 + `help status` Parallel，再动代码。
