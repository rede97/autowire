# 工作区配置 `autowire.toml`（实现约束）

> 状态：**已实现**（`init` / `analysis` / `web` / `check` / `/api/dump`；`cli` 未落地）。  
> **产出三分目录 + `[sim.<id>]`**：文档已定（§4.0 / §4.1.1）；实现仍兼容旧 `[dump] dir`——迁移未完成前以代码为准，改实现时同步 help。  
> 摘要切片：`bun index.ts help workspace`。改本文时同步改 help。  
> 关键字「必须 / 应当 / 可以」按 RFC 2119。  
> 关联：[`../connect/html.md`](../connect/html.md)、[`../connect/tb-mod-proposal.md`](../connect/tb-mod-proposal.md)、[`hdxml/cli.md`](../hdxml/cli.md)、[`hdxml/rtlindex-xml.md`](../hdxml/rtlindex-xml.md)。

## 1. 为什么要有一份顶层配置

`deps`、将来的 `web` / `cli`、RtlIndex 重建 **必须**共享同一套 RTL 宇宙：

- 源码入口（`.f` / 目录 / 散文件）
- 宏定义（`-D` 与 define `.svh`）
- include 路径等分析选项

RtlIndex 用 `definesFp` 把宏集合绑进索引有效性（见 `rtlindex-xml.md`）。宏或 filelist 不一致 ⇒ 端口表与连接页对不上。

因此工作区 **应当**有一份统一的顶层配置：**`autowire.toml`**（文件名固定；查找见 §3）。

## 2. 边界：工程配置 ≠ 连接 SoT

| 放进 `autowire.toml` | **禁止**放进 toml |
|---|---|
| 源码入口 `.f` / walk / sources | 连接关系、rewrite、例化模板 |
| 宏：`defines` 与 define `.svh`（对齐 hdxml `--define-headers`） | 生成 `.sv` 的逐端口细节 |
| `-I` incdirs、排除文件名等分析选项 | 平行模块 IR / 旧 stune `mods_info.toml` 缓存 |
| RtlIndex 索引目录（固定 `.autowire/hdxml`）、**产物三分目录**（`connect_dir` / `sim_dir` / `plugins_dir`）、**具名单元** `[connect.<id>]` / `[sim.<id>]` | HTML 方言 / 连线细节本身 |


- 连接 SoT **只有** HTML（`../connect/html.md`）。  
- 本文件是 **autowire 工程配置**：喂给 hdxml `analysis` 与连接页只读索引，**不是** hdxml 内部缓存格式的回归。

## 3. 查找与作用域

- 从 CWD（或显式 `--workspace`）向上查找 **`autowire.toml`**，找到的最近一份生效（草稿；实现时可再定是否禁止嵌套多份）。  
- 同一工作区内：`deps` / `web` / `cli` **必须**读同一份配置再谈 RtlIndex。  
- CLI 显式参数（若有）**可以**覆盖 toml 单项；覆盖后用于 analysis 的宏集合 **必须**与写入 / 校验的 `definesFp` 一致。

## 4. 配置项（schema 已冻结，init/analysis 按此实现）

对应 hdxml CLI 见 `docs/hdxml/cli.md`。

```toml
# hdxml 不读本文件：autowire analysis 负责把配置映射为 hdxml CLI 参数。

[hdxml]
# hdxml 二进制路径（相对本文件解析）。不设置 = 默认查找：
# --hdxml CLI > toml [hdxml] bin > $HDXML_BIN > 仓库 hdxml/target/{release,debug} > PATH
# bin = "hdxml/target/release/hdxml"

[analysis]
# 保原文宏（端口表达式保留 `NAME 原文，`ifdef 判真，dump 时还原；经 --keep-raw 传入）
keep_raw = ["WIDTH", "ENV_MACRO"]

[analysis.rtl]
# 三种来源可并存，并集去重（与 hdxml 输入组一致）
filelists = ["rtl/chip.f"]
walk_dirs = []
sources = []
incdirs = ["rtl/include"]  # include 搜索路径（+incdir）
exclude_filenames = []

[analysis.defines]
# 带值 = 展开（经 hdxml -D 传入）；保原文宏不写在这里，列入上方 keep_raw
SYNTHESIS = "1"

[analysis.index]
# RtlIndex XML 目录；固定在工作区生成临时目录 .autowire 下（见下方说明）
dir = ".autowire/hdxml"

[dump]
# 产物目录三分（DE / DV / 插件）；相对工作区根。
# 现状实现仍认单一 dir=（兼容）；迁移后以三分目录为准（见 §4.0）。
connect_dir = "gen/connect"
sim_dir     = "gen/sim"
plugins_dir = "gen/plugins"
# dir = "gen"   # 已弃用：勿与三分目录混用

[style]
# 例化参数风格（connect-rules §7）：
#   param_inline = true（默认）——非表达式 override（字面量/param·localparam 引用/宏）直接写进
#     例化 #(.W(CNT_W))；含任何操作符的表达式（含 {} 拼接）不展开，仍折叠；
#   param_inline = false ——每个 override 折叠成 Mod__Inst__Param localparam（可追溯/占位）。
# 对齐开关（除 localparam_upper 外均为打印层，不影响 render；默认全 false）：
#   port_align       ——模块声明端口表：dir（input/output/inout）/ 类型 / 宽度分列对齐，信号名左对齐。
#   param_align      ——模块声明 parameter 的 `=` 列对齐。
#   inst_port_align  ——例化端口 `.name (net)` 的 `(` 与 `)` 列对齐；列宽按**整个文件**（同一模块内全部例化）
#                      的最长端口名 / 最长连接文本统一计算，不是每个例化各自对齐。
#   inst_param_align ——例化参数 `.NAME (value)` 的 `(` 与 `)` 列对齐，同样按整个文件统一计算。
#   两者同时开启时，端口与参数共用同一组列宽：`(` 列取全部端口名与参数名的最大长度，
#   `)` 列取全部连接文本与参数值的最大长度。
#   signal_align     ——内部信号声明：nettype / 宽度分列对齐，信号名左对齐。
# 折叠名大小写（render 层）：
#   localparam_upper = true ——生成的 Mod__Inst__Param 名整体大写（传统习惯；默认 false）。

# 具名连接单元（禁止旧式 [connect] html = [...] 扁平列表）
# id 仅用于 toml 依赖图；连线细节仍只在 HTML 内
[connect.sha256wb]
html = "sot/connect/sha256wb.html"

[connect.soc_top]
html = "sot/connect/soc_top.html"
deps = ["sha256wb"]

# DV 仿真顶（与 DE connect 分节、分目录；根必须为 aw-tb-mod）
[sim.soc_tb]
html = "sim/soc_tb.html"
deps = ["soc_top"]
```

### 4.0 产出目录三分（DE / DV / 插件）

| 键 | 默认 | 谁写入 | 内容 |
|---|---|---|---|
| `connect_dir` | `gen/connect` | `[connect.<id>]` dump（`aw-mod` 包装） | DE 封装 RTL |
| `sim_dir` | `gen/sim` | `[sim.<id>]` dump（`aw-tb-mod` TB 顶） | DV 仿真顶 |
| `plugins_dir` | `gen/plugins` | 类型 A 插件 `generate` | 其下 **`plugins_dir/<plugin-id>/`** 再细分 |

demo/soc 覆盖为 `rtl/gen/{connect,sim,plugins}`（生成 RTL 与手写叶子同树；引擎默认仍是 `gen/`）。

规则：

1. **禁止** DE 包装与 DV TB 顶写在同一 HTML，或把 TB html 挂进 DE 作者树充 DE（demo：作者 SoT 在 `sot/`，TB 仍在 `sim/`）。  
2. **禁止**再用单一 `dir` 混写三类产物（迁移期：仅设置了旧 `dir` 时，实现可临时把 connect dump 落到该目录并 **警告**；新工作区用三分目录）。  
3. 插件 **禁止**往 `connect_dir` / `sim_dir` 写生成物；只进 `plugins_dir/<id>/`。  
4. `.autowire/` 仍只放索引/快照/调试临时物，**不是**上述三类产物目录。  
5. 类型 A wishbone：toml `[wishbone.<source_id>] ts=` 指向 SoT **文件**（可含 `RegfileDef` 与/或 `BusDef` 导出，类型仍分立；可选 `exports=`）；非 RTL 导出路径见 `[plugins.wishbone]`：`export=` Excel 工作簿（字段 sheet + `MAP_<bus>` 地址图）、`c=` C 头目录（layout `.h` + `<bus>_map.h` + `wishbone.h` 总头）、`uvm=` uvm_reg 目录（`ral_<SHEET>.sv` + `ral_block_*` + `ral_wishbone.sv`；[`../plugins/wishbone-regfile.md`](../plugins/wishbone-regfile.md) §6；均非 SoT）。软件/文档身份 = 有效 `sheet`（缺省 = `name`）；同 sheet 的多例化共用一份 C/`uvm_reg`/Excel 字段产物。C / uvm_reg **禁止**写进 `plugins_dir`。demo/soc 的 C 头落在 `fw/gen/wishbone/`，**入库展示**（与 `demo/soc/rtl/gen/` 同类；generate 只覆盖写入，**禁止**整目录删除）。RTL 进 `plugins_dir/wishbone/`（叶子 + interconnect/decoder + wrapper）。挂接了 `RegfileDef` 时 generate 另写 Type-A wrapper `<name>_system.sv`。

### 4.1 `[connect.<id>]`（DE 连接单元 DAG）

| 字段 | 必须 | 含义 |
|---|---|---|
| `html` | 是 | DE 连接 HTML（相对工作区根）；**应当**与 wishbone `ts=` 同树（demo：`sot/connect/` + `sot/wb_reg_*.ts` / `sot/wb_bus_*.ts`）；**禁止**以 `aw-tb-mod` 为根 |
| `deps` | 否 | 其它连接单元 **id** 列表（不是路径、不是 `aw-mod@name`）；缺省 = `[]` |

规则：

1. **显式依赖才允许跨单元引用**：单元 A 的 HTML 若引用单元 B 中定义的包装模 / 符号，则 A 的 `deps` **必须**列出 `B`（建议先只认**直接** deps，要传递闭包须把边写全）。未声明 → **非法引用，报错**。  
2. **多余 deps → 警告**：单元 A 的 `deps` 列出了 B，但 elaborate 后 A 的 HTML **未实际引用** B 中任何符号 → **警告**（不失败；提示删掉死边，以免假依赖阻塞并行）。检查发生在 **elaborate**（需对照引用图），不是 toml 加载时。  
3. **`deps` 图必须无环**：加载 toml 时做拓扑检查；成环 → **报错**。未知 id / 重复 id / 自依赖 → **报错**。  
4. **并行 elaborate**：DAG 就绪后，**无依赖边的单元可以并行**处理；仅列表、无 deps 时只能保守串行——这是具名 `deps` 相对扁平 `html = []` 的结构优势。  
5. toml **仍然禁止**连线细节；`deps` 只表达**包级**依赖。单文件内层级见 [`../connect/html.md`](../connect/html.md)（`aw-submods`）。  
6. dump 写入 **`connect_dir`**；`.autowire/connect/` 快照按单元 id 落盘（`<id>.xml`；生成物，可删重建）。  
7. **禁止** `deps` 指向 `[sim.<id>]`（DE 不例化 TB 顶）。

### 4.1.1 `[sim.<id>]`（DV 仿真顶单元）

| 字段 | 必须 | 含义 |
|---|---|---|
| `html` | 是 | DV TB HTML；**应当**落在 `sim/`（或 DV 约定树）；根 **必须**为 `aw-tb-mod` |
| `deps` | 否 | 可依赖 `[connect.<id>]`（及若将来允许多 TB 互引则其它 sim id）；缺省 `[]` |

规则：

1. 与 §4.1 相同的缺边 / 多余 / 环纪律；**合入同一 DAG** 做拓扑（sim 为汇点）。  
2. dump 写入 **`sim_dir`**；**不**写抽象接口到 `.autowire/connect/`（不可被例化）。  
3. **禁止**与 DE 包装共文件；**禁止**登记在 `[connect.*]` 下充数。  
4. 细则见 [`../connect/tb-mod-proposal.md`](../connect/tb-mod-proposal.md)。

说明：

- **hdxml 不读 toml**：`autowire analysis` 把 `[analysis.*]` 映射为 hdxml CLI 参数（映射表见 `help analysis`）；hdxml 侧只认 CLI 旗标。
- **增量模式**：`autowire analysis` 默认增量——未变更文件复用 `.autowire/hdxml/` 缓存（`` `include `` 闭包追踪；`--refresh` 强制全量并重写缓存）；语义见 `hdxml/cli.md` 与 `hdxml/rtlindex-xml.md` §5.8。
- **`[hdxml] bin`** 只给 autowire 定位二进制用，**不**映射为 hdxml 参数；设置了但文件不存在 ⇒ analysis 直接报错（不静默回退）。未设置时按默认链查找，最终落到 PATH。  
- **宏集合** = `[analysis.defines]`（展开）+ `keep_raw`（保原文哨兵）；二者 **必须**进入 hdxml，并反映到 `index.xml` 的 `<defines>` / `definesFp`。覆盖顺序 `[analysis.defines]` → `keep_raw`；`[analysis.defines]` 同时作为 `define_headers` 预处理的种子（header 内 `` `ifdef `` 可见），同名 header 宏随后再被其压顶。空串保原文约定已**废弃**（空串值直接报错）。哨兵机制与还原规则见 `hdxml/module-info.md` §3 / B-6。
- **宏作用域**：CLI/toml 宏作为 pre_defines 对**每个文件**一致生效（编译单元级种子）；各文件内 `` `define `` 不外泄（按文件独立预处理）。跨文件一致的宏**必须**走本表，禁止依赖文件间宏传递。

- **`.autowire/`** 是工作区**生成临时目录**（索引等缓存），可整体删除重建；**禁止**放入手写内容或任何 SoT。  
  - `.autowire/hdxml/` — RtlIndex  
  - `.autowire/connect/` — 各连接单元 elaborate 后的快照，**只有** `<id>.xml`（抽象模块信息：params / ports / imports；hdxml 风格规范：属性承载、方向标签名、模块字典序、无时间戳/哈希；跨单元 deps 加载与 dump 都读它）。**完整 `aw-render` 不再落盘**（无 `<id>.html`）；dump 印 SV 只认 POST 体活 DOM。**禁止** dump 直接 load 作者 HTML
  - 产物目录：`connect_dir` / `sim_dir` / `plugins_dir`（§4.0），与临时目录分开。
  - `.autowire/save/` — 调试落盘：`POST /api/save` 把活 DOM（调试后的 `aw-content` + `aw-render`）写成 `<id>.html`；**临时产物**，不充当作者 SoT，是否合回作者 HTML 由本地决定（见 [`mcp/README.md`](../mcp/README.md) §5）

### 4.2 HTML / web 如何加载这两类 XML（必须）

连接页与 check / render **禁止**在浏览器里直接读盘；**必须**经 `autowire web` 同源 API，由服务端从工作区生成目录取数。

| 目录 | 内容 | 谁读 | 用途 | 缺失 / 过期 |
|---|---|---|---|---|
| **`.autowire/hdxml/`** | RtlIndex（`index.xml` + 每源文件 XML） | web → `GET /api/rtlindex`、`GET /api/module?name=` | 叶子端口/参数/层次；**只读**；**禁止**当连接 SoT | 无索引或 `definesFp` 与当前 toml 宏集合不一致 → check/render 需要叶子表时 **报错**（先 `autowire analysis`） |
| **`.autowire/connect/`** | 各 `[connect.<id>]` 的 **elaborated 抽象模块信息快照**（按 **单元 id** 落盘 `<id>.xml`；生成物） | 多单元 elaborate / check 时加载 **deps 单元**快照；web → `GET /api/connect?id=`（只读 xml 快照） | 跨单元符号；**禁止**把作者 HTML 当 dump 输入 | 单元 A 的 `deps` 含 B，但 B 快照不存在 → elaborate/check 跨单元引用时 **报错**（先按 DAG render/写入 B） |

补充纪律：

1. **作者 HTML** 路径只来自 toml `[connect.<id>]` / `[sim.<id>]` 的 `html=`（或 `web` 打开的页）；**禁止**从 `.autowire/connect/` 当作者 SoT 打开编辑。  
2. **叶子事实**只认 `.autowire/hdxml/`；**禁止**页面重解析 `.sv` / 旁路 RtlIndex。  
3. **跨 `[connect.<id>]` 依赖**：先按 deps DAG 保证被依赖单元已有 connect 快照（或本会话内已 elaborate 并写入），再处理依赖方；与 toml `deps` / 并行 elaborate 一致。  
4. **dump** 读 POST 体活 DOM 印 SV，并刷新 `.autowire/connect/<id>.xml` 快照；**禁止**再 load 作者 `html=` 当 netlist。
5. 两目录均可删重建；删后须重新 `analysis` + 按需 render 出 connect 快照。

- **`.svh` 不进 filelist**（hdxml 跳过并警告）：宏头文件只有两条合法路径——源内 `` `include ``（预处理）或 `define_headers`（独立加载，等价 EDA「.f 头部 svh」的全局宏）。降级方案：EDA 侧用 `eda_load.f`（头部 svh + 共享 `rtl.f`），分析器只用纯源码 `rtl.f`，两侧行为一致。  
## 5. 与 elaboration 的衔接（总流水线）

宏 ≠ 模块 `aw-param`。顺序 **必须**为：

```text
autowire.toml（.f + svh/宏 + [connect.<id>] DAG）
    →  hdxml → RtlIndex（叶子端口/参数声明，只读）
    →  check（作者面 aw-content 合法性 + deps；不写盘）
    →  按 deps 拓扑（可并行）elaborate 各连接 HTML
    →  dump（读 POST 体 aw-render）→ .sv → DV；同时刷新 .autowire/connect/<id>.xml 快照
```

细节见 [`../connect/html.md`](../connect/html.md)。

## 6. 开放项（实现前裁定）

1. 多包/多 chip 是否允许多份 toml，还是单工作区单文件 + profile 表？  
2. 跨单元引用是否允许 `deps` 传递闭包，还是必须显式写全直接边？（草稿默认：**仅直接 deps**）

裁定后改本文 + `help workspace`，再动代码。
