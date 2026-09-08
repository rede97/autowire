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

- **incdirs**：含 `.svh` 的目录 ∪ 名为 `include` 的目录（前者覆盖源相对式 include，后者覆盖只放 `.sv` 被 include 文件的目录），各级父目录一并加入（覆盖前缀式 include）。projects 组跨项目共享（pulp 系互相 include），目标自身在前。
- **按目标配置**（`perTarget` 表）：opentitan / ibex 配 `-D VERILATOR --expand-headers prim_assert.sv prim_flop_macros.sv`——lowrisc 源文件不经 include 直接使用 ASSERT/PRIM_FLOP 宏（EDA 经 .f 头部 svh 提供），`VERILATOR` 选假宏分支（空宏体，必可解析）；cv32e40p 排除 `cv32e40p_register_file_latch.sv`（ff/latch 变体二选一，取主线 ff）。

## 3. 错误基线分类（合法遗留）

| 类别 | 例 | 处置 |
|---|---|---|
| 外部子模块未拉取 | cva6 hpdcache、fpnew_top | 黑盒是正确行为；需要则扩 fetch sparse 路径 |
| 实现变体撞名 | cv32e40p register_file ff/latch（Bender 二选一） | `perTarget.excludeFilenames` 取主线变体 |
| 断言/工具宏（非 include 引入） | opentitan `ASSUME_FPV` | `--expand-headers` + `-D VERILATOR`（见 §2） |
| 语料故意非法 / 伪代码 | verilog-mode `tests_ok/`（Emacs 缩进夹具，非合法 SV）、slang 杂散 token、ibex `.tpl.sv` | 基线数据（triage 的 intentional 列） |
| **sv-parser 0.13.4 语法覆盖差距**（verible/slang 接受；0.13.5 同样不覆盖，升级无益） | 端口声明内属性 `(* *)`、单数字打包维度 `[0]`、非 ANSI 头+体内额外端口声明、covergroup、`foreach` 隐式循环变量、`@x[y]` 事件控制、generate `begin:label`、块内后置声明 | 基线数据（triage 的 gap 列，当前 slang 7 / verible 14 / verilog-mode 62）；parser 已 pin，不靠 hdxml pre-strip 逐个 hack |

## 4. 相关

- 格式契约：`docs/hdxml/rtlindex-xml.md`；CLI：`docs/hdxml/cli.md`（`--summary` / `--expand-headers` / `--exclude-dirs`）。
- 单元与 e2e：`cargo test`（src 内单测 + `tests/e2e.rs` CLI 黑盒）。
