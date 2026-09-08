# 测试与语料（hdxml）

> 语料与第三方项目由 `tests/fetch.ts` 拉取，不入库（`.gitignore`）。脚本一律 Bun 执行。

## 1. 脚本

| 命令 | 用途 |
|---|---|
| `bun hdxml/tests/fetch.ts [名称...]` | 拉取语料（`tests/corpus/`）与 RTL 项目（`tests/projects/`），blobless + sparse 浅克隆；提交哈希追加到 `tests/MANIFEST.txt` 以便复现。无参数 = 全部（重写 MANIFEST）；带名称 = 只拉指定目标 |
| `bun hdxml/tests/scan.ts [--refresh] [额外 hdxml 参数...]` | 全量扫描测试：逐目标独立 hdxml 进程，进度条原生渲染，统计走 `--summary` 报告文件，末尾统一打印汇总表；仅当某目标 `index.xml` 缺失（崩溃）时 exit 1 |
| `bun hdxml/tests/smoke.ts [抽样数]` | 环境冒烟：工具链存在性 + 语料抽样交叉解析（verible / verilator / iverilog 成功率基线；按路径哈希稳定抽样） |
| `bun hdxml/tests/triage.ts [corpus 目标...]` | corpus 错误分类：对 scan 产物的错误文件逐个过 verible oracle——oracle 接受而 hdxml 拒绝 = **真·解析器差距**（sv-parser 语法覆盖）；oracle 也拒绝 = 故意非法/伪代码。附 preprocess / redefined 分类计数 |

## 2. scan.ts 语义

- **按目标配置**（`perTarget` 表）：opentitan / ibex 配 `-D VERILATOR --expand-headers prim_assert.sv prim_flop_macros.sv`；cv32e40p 排除 `cv32e40p_register_file_latch.sv`（ff/latch 变体取主线 ff）；cva6 经 `extraWalkDirs` 并入兄弟克隆 `cv-hpdcache` 的 rtl/src；cv-hpdcache 与 cva6 排除 SRAM 工艺变体目录（`blackbox`/`syn`）；veer-el2 配 `gen` 生成步骤（`perl configs/veer.config` + `tools/picmap`，需 `libbit-vector-perl` `libjson-perl`）、`--expand-headers el2_assert.sv`、`-D TEC_RV_ICG=el2_beh_icg`（行为级门控钟单元名）、排除 `riscv-dv`

- **排除目标**：`corpus/verilog-mode` 不进扫描基线（Emacs 缩进模式仓库，夹具含大量伪代码，错误是纯噪音；仍参与 smoke 的 oracle 抽样）

## 3. 错误基线分类（合法遗留）

| 类别 | 例 | 处置 |
|---|---|---|
| 外部子模块未拉取 | cva6 hpdcache、fpnew_top | 黑盒是正确行为；需要则扩 fetch sparse 路径 |
| 生成物缺失 | veer-el2 `el2_param.vh` / `pic_map_auto.h`（config 生成） | `perTarget.gen` 自动生成（perl 依赖见 §2） |
| 断言/工具宏（非 include 引入） | opentitan `ASSUME_FPV` | `--expand-headers` + `-D VERILATOR`（见 §2） |
| 语料故意非法 / 伪代码 | verilog-mode `tests_ok/`（Emacs 缩进夹具，非合法 SV）、slang 杂散 token、ibex `.tpl.sv` | 基线数据（triage 的 intentional 列） |
| **sv-parser 0.13.4 语法覆盖差距**（verible/slang 接受；0.13.5 同样不覆盖，升级无益） | 端口声明内属性 `(* *)`、单数字打包维度 `[0]`、非 ANSI 头+体内额外端口声明、covergroup、`foreach` 隐式循环变量、`@x[y]` 事件控制、generate `begin:label`、块内后置声明、**模块头部 package import**（veer el2_pmp / ahb↔axi4，3 例）、elaboration `$fatal`（ibex，1 例） | 基线数据（triage 的 gap 列，当前 slang 7 / verible 14）；parser 已 pin，不靠 hdxml pre-strip 逐个 hack |

## 4. 相关

- 格式契约：`docs/hdxml/rtlindex-xml.md`；CLI：`docs/hdxml/cli.md`（`--summary` / `--expand-headers` / `--exclude-dirs`）。
- 单元与 e2e：`cargo test`（src 内单测 + `tests/e2e.rs` CLI 黑盒）。
