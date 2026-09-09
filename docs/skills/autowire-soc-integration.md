# autowire SoC 集成与 MCP 调试回路（实战手册）

> 状态：**草稿，评审中**（开发阶段材料，持续优化）。
> 性质：实战手册，**非**格式约束；约束以本目录契约文档 + `bun index.ts help agent` 为准。
> 依据：`demo/soc` 实际落地过程（picorv32 + 2× sdspi + DMA→AXIS→sha256，Wishbone B4 + AXI4-Stream）。
> 2026-09-09 随 `/api/save` 调试落盘一同整理。

## 1. 全流程速查


作者面三原则（2026-09-09 起为引擎语义，见 docs/connect/html.md §3.5.5 / §4.1）：
1. **`aw-ports` 一般不写**：无驱动网自动导出 input、被驱动但本层无负载网自动导出 output；只写需要显式控制的端口。
2. **同名连接省略不写**：未被规则覆盖的端口自动连同名网（同名网合流）；显式规则/`type="open"` 永远优先。底层 IP 统一换名时 HTML 零同步成本。
3. **同名 output 多驱动是错误**：全网 output 驱动 >1 → 短路报错；多例化同名 output（如 sdspi `o_debug`）必须显式 open 或改名。
```text
IP 源码就位（submodule / vendored 目录）
  → 手写集成叶子（rtl/*.v，英文注释）
  → rtl/soc.f（filelist，路径相对工作区根；.svh 禁止入内）
  → autowire.toml（[analysis.rtl] filelists + [connect.<id>] DAG + [dump] dir）
  → bun <repo>/index.ts analysis          # hdxml → RtlIndex（先看 0 blackbox / 0 error）
  → connect/*.html（aw-content 作者面）
  → bun <repo>/index.ts check             # 作者面合法性 + deps（先于 render）
  → bun <repo>/index.ts web <top_unit>    # 起 127.0.0.1 页面
  → 浏览器打开 ?dump=1                    # check → render（deps 单元自动先行）→ 写 gen/*.sv
  → iverilog/verilator 冒烟               # gen/ + rtl/ + ip/ + tb
```

`.autowire/` 全部是可删生成物：`hdxml/`（RtlIndex）、`connect/<id>.xml`（抽象模块快照，唯一形式，无 html 快照）、`dump/<id>.html`（调试落盘）。

## 2. connect HTML 实战模式

- **多例化**：`aw-template name="x" inst_name="${id}_${idx}"`，同 `id` 不同 `idx`；`idx` 直接当**总线槽位号**用（`u_dma idx=1/2` = master 槽 1/2）。
- **扁平向量总线**：interconnect 主从端口全部摊平成 `m_*[NM*32-1:0]` / `s_*[NS*32-1:0]` 大向量，连接侧用 `part` 算术切片：`part="32*${idx}+31:32*${idx}"`、单位 bit 用 `part="${idx}"`。net 各连接点的 `width` 写法必须**逐字一致**（文本级一致性检查）。
- **BASE/MASK 译码表**走 `aw-param` 拼接字面量；含操作符/拼接的 override 自动折叠成 `Mod__Inst__Param` localparam，纯字面量 inline。
- **常量绑死**必须显式 `type="const"`（`to="1'b0"` 裸写报错）；**显式悬空** `type="open"`（只 output/inout）。
- **跨单元封装**：被引方独立 `[connect.<id>]` 单元（如 sha256wb），引用方 toml `deps=[...]`；dump 链会自动按拓扑先 elaborate 依赖。reset 极性不一致（`rst_ni` vs `wb_rst_i`/`i_sd_reset`）用一个小桥接模块，别想在连接方言里内嵌逻辑。
- **打印结果**：固件经 WB 写 testout 寄存器 → 顶层 `test_valid/test_data` 引脚，tb 直接观测。

## 3. 验证纪律（demo/soc/sim/ 模式）

- 固件 SoT 是**生成器脚本**（`gen_firmware.py`，迷你汇编器 + python 解释器模型先跑通语义），不是 hex 文本。
- 每条指令**先机器译码核对**再进 hex。
- 已知答案测试（KAT）：直接复用 IP 自带 bench 的期望向量（zynq_sha256 bench 的 digest 按字节序翻转后即寄存器读值）。
- **阴性控制必须做**：改 1 字节消息 → 必须 FAIL。demo 曾因此抓到「fail 分支跳错位置、失败反而写 pass 标记」的固件 bug。
- 分支目标布局：`bne fail` 目标必须是 fail 块**首条**指令；若 compare 与 fail 之间隔着 pass 跳转占位，目标 = 占位 + 1。

## 4. MCP 调试回路（已落地的官方路径）

```text
Playwright MCP（浏览器 A 面）
  → 读 live DOM：querySelector("aw-content").outerHTML（整树可取；原文件另有 GET /api/author?id=）
  → 改 live DOM：setAttribute / 插删节点（Render 前任意改，引擎吃的就是活 DOM）
  → 点 [Check]/[Render] 或 GET ?check=1/?render=1 验证
  → 点 [Save]（或 POST /api/save {id, html}）→ .autowire/save/<id>.html
  → 本地 diff connect/<id>.html .autowire/save/<id>.html，人工决定是否合回
```

红线：**浏览器永不写工作区**；唯一 RTL 写路径是 `POST /api/dump`；`/api/save` 只写 `.autowire/save/` 临时目录，作者面 SoT 只在 `connect/*.html`。页面 [Reset] 一键回作者面。

端点速查：`GET /api/author?id=`（作者原文）、`GET /api/connect?id=`（xml 快照）、`POST /api/check`、`POST /api/dump`、`POST /api/save`。

## 5. 踩坑清单（全是真实踩过的）

1. `aw-rewrite`/`aw-connect` 常量不声明 `type="const"` → check 报错。
2. 同 id 多例化没写 `inst_name="${id}_${idx}"` → render 报 expanded name 不唯一。
3. 寄存器拼接 `{22'h0, done, busy, 6'h0, sr}` 少 1 bit → done 错位，固件轮询死锁。**拼接宽度逐段数清**。
4. 译码窗口 mask 小于寄存器跨度（32B 窗口装 36B 寄存器）→ 最后一个寄存器读成 0。
5. 存储映射槽位步长（0x1000）与固件偏移（+0x200）不匹配 → 外设全部 unmapped。互联有 unmapped 立即 ack 兜底，表现为读 0 而非挂死。
6. 多个 `always @*` 共享同一个 `integer` 循环变量 → iverilog 下互相重触发、仿真时间爬行。**每块独立 loop var**。
7. 组合 ack 链路里把 `ack` 反馈进 `we`（`we = sel & ack & we_i` 且 `ack` 依赖 `wait(we)`）→ 零延迟振荡隐患；写使能别过 ack。
8. 固定地址 DMA 读内存缓冲 → 同一 word 重复 32 次。FIFO 固定地址 / 内存扫址两种模式要分开（`src_inc`）。
9. filelist 路径相对**工作区根**而非 `.f` 所在目录。
10. 子模块缺失模块（如 sdspi 的 llsdspi）→ analysis 报 blackbox，补齐进 soc.f 即可。

## 6. 下一步开发的已知边界

- `autowire cli` 未落地（等 Web 用例/golden 稳定）。
- 工作区 MCP（docs/mcp/workspace.md）：草稿，节点级 html_edit 未实现；传输未定（stdio MCP vs CLI）。
- 插件机制（docs/plugins/）：草稿。
- demo/soc 未做：真实 SD 卡模型（sdspi 目前只例化+编译验证，功能路径用 SRAM 当数据源跑通 DMA→sha256）；固件拉 UART 打印（testout 已覆盖等价观测）。
