# 模块信息架构设计（ModuleInfo v2）

> hdxml（原 stune）现为 autowire 的 RTL 分析 sidecar：只做只读分析，产物为 RtlIndex XML 目录（每源文件一个 XML + index.xml），供 autowire 只读消费。
> 连线/寄存器/总线等业务层已随 stune 其他功能一并剔除；TOML 方案（schema v2 / mods_info.toml 缓存）已移除。

## 1. 设计目标

- G-1 **单次解析**：每个文件 parse_sv 一次，语法树在分析与连线间共享（现有 `enable_syntax_cache` 路径升级为默认）。
- G-2 **表达式保真**：参数化端口的位宽/类型表达式（`[W-1:0]`、`[AXI_ID_W+:...]`）以**原文文本 + 符号依赖集**保存，不做展开求值（除字面量替换）。
- G-3 **可增量**：每个模块接口有稳定签名（signature），支撑 autowire 的"端口未变动则跳过"。
- G-4 **层次正确**：依赖 DAG 无条件全量收集（edges + per-instance），替代 svo 的 `dump_dep_tree` 条件收集；分析层零功能标志位。
- G-5 **XML 可导出**：每源文件一个 XML（模块参数/端口/实例 + 错误），index.xml 汇总文件清单、模块映射与顶层 DAG 层级；固定排序规则保证序列化字节级确定（`src/db/xml.rs` 头注释）。

## 2. 数据模型

```rust
/// 表达式：原文保真 + 依赖符号
struct ExprText {
    text: String,            // 源文本，如 "W-1" / "AXI_ID_W+2"
    deps: HashSet<String>,   // 引用的参数/宏符号 {"W"} {"AXI_ID_W"}
}

enum ParamKind { Parameter, Localparam, Type }   // parameter/localparam/type 参数

struct ParamInfo {
    name: String,
    kind: ParamKind,
    data_type: Option<String>,     // int / logic / 自定义类型名
    packed_dims: Vec<ExprText>,
    default: Option<ExprText>,     // 缺省值表达式
    span: (Locate, Locate),        // 源文件内范围（重写用）
}

enum PortDir { Input, Output, Inout, Interface, Ref }

struct PortInfo {
    name: String,
    dir: PortDir,
    data_type: Option<String>,      // logic/wire/自定义类型
    interface_type: Option<String>, // interface 端口: "axi_if"
    modport: Option<String>,        // "slave"
    packed_dims: Vec<ExprText>,     // [W-1:0] —— 参数化端口核心
    unpacked_dims: Vec<ExprText>,
    default: Option<ExprText>,
    span: (Locate, Locate),
}

struct InstanceInfo {
    inst_name: String,
    target_mod: String,            // 目标模块名（undef 时标记外部）
    param_conns: Vec<(Option<String>, ExprText)>,   // None=位置连接
    port_conns: Vec<(Option<String>, ExprText)>,    // None=位置连接；.* / .name 特判
    auto_blocks: Vec<AutoBlock>,   // 该实例内的 /*AUTOINST*/ 等待处理区
    span: (Locate, Locate),
}

struct ModuleDecl {
    name: String,
    file: PathBuf,
    params: Vec<ParamInfo>,        // 声明序
    ports: Vec<PortInfo>,          // 声明序（autowire 展开顺序依据）
    instances: Vec<InstanceInfo>,  // 直接子模块实例
    auto_regions: Vec<AutoRegion>, // 模块级 AUTO 区（AUTOWIRE/AUTOREG/AUTOARG）
    content_hash: Hash,            // 模块文本规范化后的内容哈希
    interface_sig: InterfaceSig,   // 见 §4
}
```

### sv-parser 节点映射

| 语法树节点 | 落点 |
|---|---|
| `ParameterDeclaration` / `LocalParameterDeclaration` | `ParamInfo`（`unwrap_node!(…, ParameterIdentifier, TypeIdentifier)`） |
| `AnsiPortDeclaration` | `PortInfo`（方向/类型/维度从 `nodes` 抽取） |
| `PortDeclaration`（非 ANSI 体内 `input …;`） | `PortInfo`（与头部列表按名配对） |
| `ModuleInstantiation` + `HierarchicalInstance` | `InstanceInfo`（参数覆盖 `ParameterValueAssignment`，连接 `NamedPortConnection`/`OrderedPortConnection`/`*`/`ImplicitNamedPortConnection`） |
| `ModuleDeclaration` | `ModuleDecl` 边界与 span |

## 3. 全局结构

```rust
struct DesignDb {
    defs: BTreeMap<String, ModuleDecl>,        // 模块名 → 声明（重复定义 → 记入 errors）
    undef: BTreeSet<String>,                   // 外部/黑盒模块（被实例化但无定义）
    tops: Vec<String>,                         // 有定义但未被实例化（DAG 根）
    errors: BTreeMap<PathBuf, Vec<FileError>>, // 文件级分析错误（含行列定位，不中止整体分析）
}
```

- **DAG 求解**（svo 同语义）：`undef = 被引用 − 有定义`；`tops = 有定义 − 被引用`。层级树自 tops 展开，子节点 = 直接引用模块去重有序；环标注 `cycle="true"` 截断，黑盒标注 `blackbox="true"`。
- **多模块文件**：ModuleDecl 各自独立，`file` 指向同一文件；导出时每文件聚合为一个 XML（一对多）。

> **实现勘定（第一阶段落地）**：span 基准为**预处理后文本**（宏/include 展开后）。sv-parser 的 `parse_sv`/`parse_sv_str` 内部会重跑预处理，两阶段流程必须用 `parse_sv_pp(PreprocessedText, …)` 直取——二次预处理会使宏文本再展开、locate 整体漂移（common_cells 实测越界 panic）。源映射回原始文件可用 `PreprocessedText.origins`（`BTreeMap<Range, Origin>` → 原文件路径+范围），autowire 阶段重写定位走该映射。

## 4. 接口签名（InterfaceSig）

增量跳过的判定基础：

```
canonical(module) = concat(
    for p in params: p.kind | p.name | normalize(p.data_type, dims, default)
    for q in ports:  q.dir  | q.name | normalize(q.data_type, interface, modport, dims, default)
)
interface_sig = blake3(canonical)
```

- `normalize`：剥离空白/注释、宏引用保持 `` `NAME `` 原样（不展开）。
- **顺序敏感**：端口/参数顺序参与签名（位置连接的合法性依赖顺序）。
- 与 `content_hash` 区分：content_hash 覆盖模块全部文本（含内部逻辑）；interface_sig 只覆盖参数+端口。autowire 跳过判定用后者。

## 5. RtlIndex XML Schema

导出目录布局（`hdxml analysis --xml DIR`）：每源文件一个 XML，路径**镜像源码相对 CWD 的路径**并追加 `.xml`（`src/foo.sv` → `src/foo.sv.xml`；CWD 之外剥掉根/父级分量），按构造唯一、无哈希；顶层 `index.xml`。

失效清理（manifest 驱动 GC）：`index.xml` 即产物清单。每次运行读旧 manifest，删除"旧产物集 − 本次产物集"的 XML 并修剪空目录——源码被删除或移出输入集后，其 XML 下次运行必被清理，不污染索引；目录内非产物文件不受影响。`index.xml` 最后写入，中途崩溃旧 manifest 仍在，下次 GC 依然正确。

固定排序规则（字节级确定）：`<files>` 按源路径字典序；`<module>` 按模块名字典序；`<param>`/`<port>`/`<instance>`/`<conn>` 按源码声明序；`<hierarchy>` 子节点按目标模块名字典序。所有数据走属性；`span` 为预处理后文本字节偏移 `[start:end]`（§3 勘定）。

每文件 XML：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<fileIndex source="src/cc_cdc_2phase.sv" mtime="1788325458">
  <module name="cc_cdc_2phase" kind="module" span="17692:19347" timestamp="1788325458"
          contentHash="ca4d…" interfaceSig="c67e…">
    <param name="SyncStages" kind="parameter" dataType="int unsigned" default="2" span="…"/>
    <param name="data_t" kind="type" span="…"/>
    <port name="src_data_i" dir="input" dataType="data_t" packed="[W-1:0]" span="…"/>
    <port name="s_axi" dir="interface" interface="axi_if" modport="slave" span="…"/>
    <instance name="i_src" target="cc_cdc_2phase_src" span="…">
      <param name="SyncStages" text=".SyncStages ( SyncStages )"/>
      <conn name="clk_i" text=".clk_i ( src_clk_i )"/>
    </instance>
  </module>
  <!-- 解析失败的文件：无 module，错误带行列定位（定位机制移植自 ipchecker） -->
  <error message="解析失败: Parse error: …" offset="48" line="2" column="3"/>
</fileIndex>
```

- `timestamp` = 源文件 mtime（unix 秒），与 `contentHash` 共同支撑消费方的修改追踪；`span` 即模块地址。
- `packed`/`unpacked` 多维时拼接为 `[d0][d1]`；表达式原文保真，deps 以 `deps="A,B"` 随 `default` 给出。

index.xml：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rtlIndex tool="hdxml 0.1.0" generated="1788627786" files="168" modules="200" errorFiles="0">
  <files>
    <file source="src/bad.sv" index="bad_214f09bf.xml" status="error" modules="0" mtime="…"/>
    <file source="src/top.sv" index="top_a1b2c3d4.xml" status="ok" modules="2" mtime="…"/>
  </files>
  <modules>
    <module name="cc_cdc_2phase" index="cc_cdc_2phase_bf61cb0d.xml"/>
  </modules>
  <hierarchy>
    <top module="cc_cdc_2phase">
      <node module="cc_cdc_2phase_dst"/>
      <node module="cc_cdc_2phase_src"/>
      <node module="tc_clk_cell" blackbox="true"/>
    </top>
  </hierarchy>
</rtlIndex>
```

- `<files>` 覆盖全部输入文件（含零模块与错误文件），`status="ok|error"`。
- `<hierarchy>` 为模块级 DAG 展开（svo `dump_dep_tree` 同语义）：环 `cycle="true"`、黑盒 `blackbox="true"`，标注后不继续展开。

## 6. 填充算法（analyze v2）

对每模块两遍扫描语法树：

1. **声明遍**：收集 params/ports（含 span）。非 ANSI 头部端口名先占位，体内 `PortDeclaration` 补全方向/类型；头部有名、体内无声明 → 按 1800 默认为 input wire，记录告警。
2. **实例遍**：收集 instances 与 AUTO 注释区（注释在语法树中是 `WhiteSpace::Comment`，需按位置与实例区间关联）。

undef 模块：有实例无定义 → 记入 `undef`，其 `InstanceInfo.target_mod` 标记外部；其 AUTOINST 不可展开（无接口信息），保留原样并告警。

## 7. 已知边界

- B-1 **参数不求值**：`[W-1:0]` 中的 `W` 在父模块被 override 时，AUTOWIRE 需要宽度 → 做**字面量/同名参数文本替换**（`ExprText.deps` 替换为实例参数值文本），替换后仍含未知符号则原样输出并告警。不做常量表达式求值器（v2 范围外）。
- B-2 generate 块内实例、数组化实例（`u[3:0]`）：收集；展开与物化不在分析器范围内。
- B-3 宏内声明的端口（`` `PORT_DECL(x) ``）：宏展开后可见，但 span 落在宏展开文本而非源文本 → 该模块标记 `readonly`（不可重写），仅参与签名。
- B-4 interface/modport 端口的"宽度"语义不属于本模块签名的一部分，签名只含 interface 类型名 + modport 名。
