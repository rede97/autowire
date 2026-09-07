# hdxml — SystemVerilog RTL 分析器

autowire 的 RTL 分析 sidecar 子项目（由 stune 迁移裁剪而来，历史见父仓库 `stune-history` 分支）。唯一功能：`analysis` 子命令——扫描 `.v`/`.sv`，提取模块层级/参数/端口/例化，导出 RtlIndex XML 目录（每源文件一个 XML + index.xml），供 autowire 只读消费。连线、渲染、MCP、cfgreg/cfgbus 与 TOML 缓存方案已全部剔除。

## 文档（统一在仓库 `docs/`）

| 文档 | 内容 |
|---|---|
| [`docs/hdxml/rtlindex-xml.md`](../docs/hdxml/rtlindex-xml.md) | **RtlIndex XML 格式约束（契约草案，与 autowire 的唯一格式约定）** |
| [`docs/hdxml/module-info.md`](../docs/hdxml/module-info.md) | DesignDb / 模块信息模型 |
| [`docs/hdxml/cli.md`](../docs/hdxml/cli.md) | CLI 选项与行为 |
| [`docs/workspace-toml.md`](../docs/workspace-toml.md) | autowire 工作区 toml（喂 hdxml 的 .f / 宏；未实现） |
| [`docs/README.md`](../docs/README.md) | 全仓库文档索引（含连接 HTML 方言） |

## 开发命令

```bash
cargo build          # dev 构建
cargo test           # 单元测试
cargo run -- -w <rtl_dir> --tree   # 目录扫描 + 依赖树（无子命令）
```

## 约定

- Rust edition 2024；`anyhow::Result` 于边界；doc 注释用中文。
- **Pin `sv-parser = 0.13.4`**——API 版本敏感。
- 并发：rayon 池 + DashMap/DashSet/Mutex；DesignDb 屏障后不可变（Arc 共享，只读无锁）。禁止对语法树 `unsafe impl Send/Sync`。
- 终端输出只走 ProgressCenter；功能代码不得直接 `println!`/indicatif。
- **span 基准 = 预处理后文本**；两阶段流程必须 `parse_sv_pp` + `PreprocessedText.origins` 做源映射（`docs/hdxml/module-info.md` §3 勘定）。
- 分析纯净性：DesignDb 无条件全量收集，零功能标志位。
- Linux only；release profile：`opt-level="z"`、`lto`、`codegen-units=1`、`strip`。

## 测试语料

`tests/fetch.sh` 拉取语料与第三方项目（slang/verible corpus、ibex/cva6/OpenTitan），`tests/smoke.sh` 做工具链与 oracle 冒烟。语料不入库（见 `.gitignore`）。
