//! hdxml — SystemVerilog RTL 分析器（autowire 的 sidecar 子项目）
//!
//! 唯一功能：analysis 子命令（层级/参数/端口提取 → XML 目录，见 docs/module-info.md）

pub mod args;
pub mod db;
pub mod filelist;
pub mod progress;
