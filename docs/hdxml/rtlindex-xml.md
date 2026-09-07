# RtlIndex XML 格式约束

> 状态：草案（待评审）。本文档是 hdxml（生产者）与 autowire（消费者）之间 RtlIndex 索引目录的**唯一格式契约**。
> 实现参考：`docs/hdxml/module-info.md` §5（数据模型语义）；本文档只约束**格式**，不重复语义推导。
> 关键字"必须/应当/可以"按 RFC 2119 解释。

## 1. 范围与版本

- 本文档约束 `hdxml analysis --xml DIR` 产出的整个目录，下称**索引目录**。
- 消费者必须只读索引目录；任何修改索引目录内容的行为只允许由 hdxml 执行。
- 格式变更规则：
  - **新增**元素或属性为向后兼容变更，消费者**必须**忽略不认识的元素与属性。
  - 删除、重命名、语义改变为不兼容变更，必须给 `rtlIndex/@format` 升版（当前草案期无此属性，评审时决定是否引入）。

## 2. 目录布局

```
<DIR>/
  index.xml                 # 清单与全局索引（唯一固定文件名）
  <源码相对路径>.sv.xml      # 每源文件一个，路径镜像源码相对路径
```

- 每文件 XML 名**必须**为：源码相对 CWD 的相对路径追加 `.xml`（`src/foo.sv` → `src/foo.sv.xml`）；源码在 CWD 之外时剥掉根与 `..` 分量。**禁止**额外引入哈希或随机后缀。
- 消费者**必须**通过 `index.xml` 发现文件 XML，**禁止**自行遍历目录推断。
- 失效清理：生产者每次写入前读取旧 `index.xml`，删除"旧产物集 − 本次产物集"中的文件并修剪空目录；`index.xml` **必须**最后写入。
- 索引目录中可能出现非产物文件（用户放置），生产者**禁止**删除未登记在旧 `index.xml` 中的文件。

## 3. 通用编码规则

- UTF-8、LF、`<?xml version="1.0" encoding="UTF-8"?>` 声明；两级空格缩进。
- 数据**必须**全部放在属性上；元素文本内容只允许空白（无混合内容）。
- 属性值转义最小集：`&` `<` `>` `"`。
- 排序规则（相同输入必须产出字节一致的结果，`rtlIndex/@generated` 除外）：
  - `<files>/<file>`：按 `source` 字典序；
  - 各文件内 `<module>`：按 `name` 字典序；
  - `<modules>/<module>`、`<packages>/<package>`：按 `name` 字典序；
  - `<module>` 子结构固定次序：`<imports>` → `<params>` → `<ports>` → `<instances>`；组内元素按源码声明序（`<import>` 例外见 §5.3）；
  - `<hierarchy>` 内兄弟 `<node>`：按 `module` 字典序。
- 所有 `span` 为**预处理后文本**的字节偏移 `start:end`（含宏/include 展开），映射回源文件需 sv-parser-pp origins；消费者不得把 span 当作源文件偏移。
- 时间戳一律为 unix 秒（整数）。

## 4. index.xml

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rtlIndex tool="hdxml 0.1.0" generated="1788627786" files="168" modules="200" packages="3" errorFiles="0"
          definesFp="6c76cc6a…">
  <defines>
    <define name="SYNTHESIS" value="1"/>
  </defines>
  <files>
    <file source="src/top.sv" index="src/top.sv.xml" status="ok" modules="2" mtime="1788325458"/>
  </files>
  <modules>
    <module name="top" index="src/top.sv.xml"/>
  </modules>
  <packages>
    <package name="axi_pkg" index="src/axi_pkg.sv.xml"/>
  </packages>
  <hierarchy>
    <top module="top">
      <node module="sub"/>
      <node module="tc_cell" blackbox="true"/>
    </top>
  </hierarchy>
</rtlIndex>
```

### 4.1 `<rtlIndex>`（根，恰好一个）

| 属性 | 类型 | 必须 | 含义 |
|---|---|---|---|
| `tool` | string | 是 | 生产者标识与版本，如 `hdxml 0.1.0` |
| `generated` | int | 是 | 本次生成时间戳；两次运行可不同，不影响等价性 |
| `files` | int | 是 | 输入源文件总数（= `<files>` 子元素数） |
| `modules` | int | 是 | 已定义模块总数（= `<modules>` 子元素数） |
| `packages` | int | 是 | 已定义 package 总数（= `<packages>` 子元素数） |
| `errorFiles` | int | 是 | 含分析错误的文件数 |
| `definesFp` | string | 是 | 宏定义指纹（`name=value` 排序逐行 blake3-128）；消费方宏集合指纹不一致 ⇒ **整个索引作废**（§6） |

### 4.2 `<defines>/<define>`（分析时使用的宏定义，按 `name` 字典序；为空则整组省略）

| 属性 | 类型 | 必须 | 含义 |
|---|---|---|---|
| `name` | string | 是 | 宏名 |
| `value` | string | 是 | 宏值文本（`-D NAME` 无值按 EDA 惯例记为 `1`；来自 `-D` 与 `--define-headers`） |

预处理结果由宏集合决定，因此宏是索引有效性的一部分：消费方**必须**以当前宏集合按同一规则计算指纹并与 `definesFp` 比对，不一致不得使用该索引。

### 4.3 `<files>/<file>`（每个输入源文件一条，含零模块与错误文件）

| 属性 | 类型 | 必须 | 含义 |
|---|---|---|---|
| `source` | string | 是 | 源文件路径（生产者收集时的路径形式） |
| `index` | string | 是 | 对应文件 XML 相对索引目录的路径（§2 命名规则） |
| `status` | `ok` \| `error` | 是 | `error` 表示该文件存在分析错误（细节见其 XML 的 `<error>`） |
| `modules` | int | 是 | 该文件贡献的模块数（可为 0） |
| `mtime` | int | 是 | 源文件 mtime；不可得时为 `0` |

### 4.4 `<modules>/<module>`（每个已定义模块一条）

| 属性 | 类型 | 必须 | 含义 |
|---|---|---|---|
| `name` | string | 是 | 模块名，全局唯一（重复定义见 §6） |
| `index` | string | 是 | 声明所在文件 XML 的相对路径 |

### 4.5 `<packages>/<package>`（每个已定义 package 一条）

| 属性 | 类型 | 必须 | 含义 |
|---|---|---|---|
| `name` | string | 是 | 包名，全局唯一 |
| `index` | string | 是 | 声明所在文件 XML 的相对路径 |

package 在文件 XML 中同样以 `<module kind="package">` 记录（§5.2）；本组仅为全局名→文件映射。

### 4.6 `<hierarchy>/<top>`（每个顶层模块一棵 DAG 展开树）

顶层 = 有定义且未被任何模块例化的模块。`<top>` 的 `module` 属性为顶层名；子 `<node>` 为直接例化的目标模块，递归展开。

| 元素 | 属性 | 类型 | 必须 | 含义 |
|---|---|---|---|---|
| `top` / `node` | `module` | string | 是 | 模块名 |
| `node` | `blackbox` | bool | 否 | `true`：被例化但无定义（外部/工艺单元）；不继续展开 |
| `node` | `cycle` | bool | 否 | `true`：沿当前路径回到已访问模块；不继续展开 |

约束：`blackbox`/`cycle` 缺省等价 `false`；两者为 `true` 的节点**必须**为叶子。`<hierarchy>` 只表达模块级依赖关系；例化名、参数覆盖等实例级信息在各文件 XML 的 `<instance>` 中。

## 5. 文件 XML（`<stem 路径>.sv.xml`）

```xml
<?xml version="1.0" encoding="UTF-8"?>
<fileIndex source="src/cc_cdc_2phase.sv" mtime="1788325458">
  <module name="cc_cdc_2phase" kind="module" span="17692:19347"
          contentHash="ca4d…" interfaceSig="c67e…">
    <imports>
      <import package="axi_pkg" symbol="*" via="decl" span="17693:17710"/>
      <import package="axi_pkg" symbol="axi_t" via="scope" span="17856:17869"/>
    </imports>
    <params>
      <param name="SyncStages" kind="parameter" dataType="int unsigned" default="2" span="17774:17789"/>
    </params>
    <ports>
      <input name="src_data_i" dataType="axi_pkg::axi_t" packed="[W-1:0]" span="17849:17873"/>
      <interface name="s_axi" interface="axi_if" modport="slave" span="…"/>
    </ports>
    <instances>
      <instance name="i_src" target="cc_cdc_2phase_src" span="18536:18826">
        <param name="SyncStages" value="SYNC_STAGES"/>
      </instance>
    </instances>
  <error message="解析失败: Parse error: …" offset="48" line="2" column="3"/>
</fileIndex>
```

### 5.1 `<fileIndex>`（根，恰好一个）

| 属性 | 类型 | 必须 | 含义 |
|---|---|---|---|
| `source` | string | 是 | 源文件路径，与 index.xml 中一致 |
| `mtime` | int | 是 | 源文件 mtime；不可得时为 `0` |

### 5.2 `<module>`（按 `name` 字典序；零个或多个）

| 属性 | 类型 | 必须 | 含义 |
|---|---|---|---|
| `name` | string | 是 | 模块名 |
| `kind` | `module` \| `interface` \| `package` | 是 | 声明种类 |
| `contentHash` | string | 是 | 模块文本内容哈希（blake3-128）；回答"这个文件要不要重分析" |
| `interfaceSig` | string | module/interface 是 | 接口签名（参数+端口规范化哈希，顺序敏感、格式不敏感）；回答"父模块要不要重连线"；`kind="package"` 时省略（无端口，签名无意义） |
子结构固定次序 `<imports>` → `<params>` → `<ports>` → `<instances>`（§3）；空组**必须**整体省略（无参数则不出现 `<params>`）。`kind="package"` 只有 `<params>`（包内 parameter/localparam 声明），无 `<ports>`/`<instances>`。

### 5.3 `<module>/<imports>/<import>`（package 依赖：显式 import + 作用域引用）

模块/接口对 package 的依赖统一收进本组；`kind="package"` 的声明无此组。定位"某 interface 引用属于哪个 package"即查定义该 interface 的 `<module>` 的 `<imports>`。

| 属性 | 类型 | 必须 | 含义 |
|---|---|---|---|
| `package` | string | 是 | 包名 |
| `symbol` | string | 是 | 导入/引用的符号；通配导入为 `*` |
| `via` | `decl` \| `scope` | 是 | `decl`：显式 `import pkg::sym;` 声明（含 `$unit` 编译单元级）；`scope`：类型/表达式中的 `pkg::sym` 作用域引用（隐式依赖） |
| `span` | `int:int` | 是 | 声明或引用范围 |

排序：`via="decl"` 按源码声明序在前；`via="scope"` 按 `(package, symbol)` 字典序去重殿后。两种 **必须**同时收集——只收 `decl` 会漏掉未 import 而直接 `pkg::` 限定的引用。

### 5.4 `<module>/<params>/<param>`（声明序）
| 属性 | 类型 | 必须 | 含义 |
|---|---|---|---|
| `name` | string | 是 | 参数名 |
| `kind` | `parameter` \| `localparam` \| `type` | 是 | 参数种类 |
| `dataType` | string | 否 | 声明类型原文 |
| `default` | string | 否 | 缺省值表达式原文（不求值） |
| `deps` | string | 否 | `default` 引用的符号，逗号分隔、字典序 |
| `span` | `int:int` | 是 | 声明范围 |

### 5.5 `<module>/<ports>/<input|output|inout|ref|interface>`（声明序；顺序即位置连接语义）
方向**必须**用标签名表达，不设 `dir` 属性：`<input>` / `<output>` / `<inout>` / `<ref>` / `<interface>`。方向未知（非 ANSI 头部端口体内未补全声明）时使用 `<port>` 兜底。

| 属性 | 类型 | 必须 | 含义 |
|---|---|---|---|
| `name` | string | 是 | 端口名 |
| `dataType` | string | 否 | 类型原文（`logic`、自定义类型等） |
| `interface` | string | 否 | interface 端口的接口类型名 |
| `modport` | string | 否 | modport 名 |
| `packed` | string | 否 | 打包维度，多维拼接为 `[d0][d1]`，维度文本不含括号 |
| `unpacked` | string | 否 | 非打包维度，格式同上 |
| `default` | string | 否 | 缺省值表达式原文 |
| `span` | `int:int` | 是 | 声明范围 |

> `<ref>` 仅为事实记录：模块级 `ref` 端口面向验证代码，主流综合工具不支持；可综合 RTL 中不应出现。分析层无条件收集（零功能特判），消费方连线层遇到 `<ref>` 端口**应当**告警并跳过，不得为其生成连接。

### 5.6 `<module>/<instances>/<instance>`（声明序）
| 属性 | 类型 | 必须 | 含义 |
|---|---|---|---|
| `name` | string | 是 | 例化名 |
| `target` | string | 是 | 目标模块名（可能为黑盒，见 index.xml `<hierarchy>`） |
| `span` | `int:int` | 是 | 例化范围 |

子元素 `<param>` 为参数覆盖（**不记录端口连接**——连接关系由消费方需要时按 `span` 回源重取）：

| 属性 | 类型 | 必须 | 含义 |
|---|---|---|---|
| `name` | string | 否 | 命名覆盖的参数名；位置连接缺省 |
| `value` | string | 是 | 覆盖表达式原文（已剥离 `.name(...)` 包裹与注释，不求值），如 `1`、`W` |

### 5.7 `<fileIndex>/<error>`（文件级分析错误，零个或多个；与 `<module>` 可共存）
| 属性 | 类型 | 必须 | 含义 |
|---|---|---|---|
| `message` | string | 是 | 错误描述（含生产者原始错误文本） |
| `offset` | int | 否 | 预处理后文本字节偏移（可定位时） |
| `line` / `column` | int | 否 | 1-based 行列（预处理后基准，可定位时成对出现） |

解析失败的文件通常无 `<module>`；模块重复定义等错误可与 `<module>` 共存。

## 6. 一致性与错误语义

- `index.xml` 的 `files`/`modules`/`packages`/`errorFiles` 必须与对应子元素实际数量一致。
- `<modules>` 与全部文件 XML 的 `<module>` 必须一一对应（同名同文件）。
- 模块重复定义：后者覆盖前者进入 `defs`，并在该文件追加一条 `<error>`；生产者进程退出码为 1（XML 仍完整落盘）。
- `<packages>` 与全部文件 XML 中 `kind="package"` 的 `<module>` 必须一一对应（同名同文件）。
- 任何文件存在 `<error>` ⇒ 生产者退出码 1；消费者应当把该文件的数据视为不完整。

## 7. 待定项（评审决定）

1. 是否引入 `rtlIndex/@format` 版本号（§1）。
2. `source` 路径是否约束为"相对项目根"（当前为生产者收集时的路径形式，消费侧展示长路径）。
3. `<error>` 是否需要 `stage`（`preprocess`/`parse`/`duplicate`）枚举属性。
