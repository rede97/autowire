# 测试与语料（hdxml）

> 语料与第三方项目由 `tests/fetch.ts` 拉取，不入库（`.gitignore`）。脚本一律 Bun 执行。

## 1. 脚本

| 命令 | 用途 |
|---|---|
| `bun hdxml/tests/fetch.ts [名称...]` | 拉取语料（`tests/corpus/`）与 RTL 项目（`tests/projects/`），blobless + sparse 浅克隆；提交哈希追加到 `tests/MANIFEST.txt` 以便复现。无参数 = 全部（重写 MANIFEST）；带名称 = 只拉指定目标 |
| `bun hdxml/tests/scan.ts [--refresh] [额外 hdxml 参数...]` | 全量扫描测试：逐目标独立 hdxml 进程，进度条原生渲染，统计走 `--summary` 报告文件，末尾统一打印汇总表；仅当某目标 `index.xml` 缺失（崩溃）时 exit 1 |
| `bun hdxml/tests/smoke.ts [抽样数]` | 环境冒烟：工具链存在性 + 语料抽样交叉解析（verible / verilator / iverilog 成功率基线；按路径哈希稳定抽样） |

## 2. scan.ts 语义

- **目标**：`tests/projects/*` + `tests/corpus/*`，每个目标一次 hdxml 进程，产物在 `tests/out/scan/<group>-<name>/`（增量缓存，复跑秒级；`--refresh` 强制全量）。
- **incdirs**：含 `.svh` 的目录及其父目录（覆盖 `"regs.svh"` 源相对式与 `"common_cells/regs.svh"` 前缀式 include；sv-parser-pp 只做 CWD/incdirs 解析）。projects 组跨项目共享（pulp 系互相 include），目标自身在前。
- **验证侧排除**：projects 组 `--exclude-dirs dv verif tb testbench`（UVM/FPV 库不在分析范围，剩余错误即真 RTL 问题）。
- **按目标宏配置**（`perTarget` 表）：opentitan / ibex 配 `-D VERILATOR --expand-headers prim_assert.sv prim_flop_macros.sv`——lowrisc 源文件不经 include 直接使用 ASSERT/PRIM_FLOP 宏（EDA 经 .f 头部 svh 提供），`VERILATOR` 选假宏分支（空宏体，必可解析）。

## 3. 错误基线分类（合法遗留）

| 类别 | 例 | 处置 |
|---|---|---|
| 外部子模块未拉取 | cva6 hpdcache、fpnew_top | 黑盒是正确行为；需要则扩 fetch sparse 路径 |
| 生成物缺失 | veer-el2 `el2_param.vh`（config 生成） | 接受现状或先跑生成脚本 |
| 断言/工具宏（非 include 引入） | opentitan `ASSUME_FPV` | `--expand-headers` + `-D VERILATOR`（见 §2） |
| 实现变体撞名 | cv32e40p register_file ff/latch（Bender 二选一） | union-walk 必撞，重定义错误属预期 |
| 语料故意非法 / 模板文件 | slang 杂散 token、ibex `.tpl.sv` | 基线数据 |
| sv-parser 严格性 | 块内后置声明、elaboration `$fatal`、`checker#(` 无空格 | 合法 SV 子集差异，个案极少 |

## 4. 相关

- 格式契约：`docs/hdxml/rtlindex-xml.md`；CLI：`docs/hdxml/cli.md`（`--summary` / `--expand-headers` / `--exclude-dirs`）。
- 单元与 e2e：`cargo test`（src 内单测 + `tests/e2e.rs` CLI 黑盒）。
