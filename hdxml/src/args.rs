//! CLI 定义（docs/hdxml/cli.md）。唯一功能 = 层级分析（无子命令，参数平铺顶层）。

use clap::{Args, Parser};
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(
    version,
    about = "hdxml — SystemVerilog RTL 分析器（层级分析：模块/参数/端口提取，导出 XML）",
    arg_required_else_help = true
)]
pub struct Cli {
    #[command(flatten)]
    pub analysis: AnalysisArgs,

    /// 工作线程数（默认 CPU 核数）
    #[arg(short, long, global = true)]
    pub threads: Option<usize>,

    /// 工作线程栈大小（MiB）
    #[arg(long, default_value_t = 16, global = true)]
    pub stack_size: usize,

    /// 日志级别（-v=info, -vv=debug）
    #[arg(short, long, action = clap::ArgAction::Count, global = true)]
    pub verbose: u8,

    /// 日志文件路径（默认不写文件）
    #[arg(long, global = true)]
    pub log_file: Option<PathBuf>,
}

/// 输入来源组（docs/hdxml/cli.md §2）
#[derive(Args, Debug, Default)]
pub struct InputArgs {
    /// 源文件列表（.f，支持 #/​// 注释、-f 嵌套、$ENV 展开）
    #[arg(short, long, num_args = 1..)]
    pub filelist: Vec<PathBuf>,

    /// 散文件（.sv/.v）
    #[arg(short, long, num_args = 1..)]
    pub sources: Vec<PathBuf>,

    /// 递归遍历目录收集 *.sv/*.v
    #[arg(short, long, num_args = 1..)]
    pub walk_dirs: Vec<PathBuf>,

    /// 按文件名（不含目录）排除
    #[arg(long, num_args = 1..)]
    pub exclude_filenames: Vec<String>,

    /// 宏定义（NAME=VALUE；无值视为 NAME=1）
    #[arg(short = 'D', long, num_args = 1..)]
    pub defines: Vec<String>,

    /// 宏定义头文件（提取其中的 `define，默认转哨兵保原文；替代传统 EDA「.f 头部放 .svh」的全局宏机制——逐文件并行预处理不支持宏跨文件传递）
    #[arg(long, num_args = 1..)]
    pub define_headers: Vec<PathBuf>,

    /// 登记宏保原文（哨兵展开）：表达式保留 `NAME 原文，`ifdef NAME 仍判真（autowire.toml keep_raw 经此传入）
    #[arg(long, num_args = 1..)]
    pub keep_raw: Vec<String>,

    /// include 搜索路径（+incdir）
    #[arg(short = 'I', long, num_args = 1..)]
    pub incdirs: Vec<PathBuf>,
}

#[derive(Args, Debug)]
pub struct AnalysisArgs {
    #[command(flatten)]
    pub input: InputArgs,

    /// 打印依赖树
    #[arg(long)]
    pub tree: bool,

    /// 每线程子进度条（spinner 显示当前处理文件，svo 同款样式）
    #[arg(long)]
    pub sub_bars: bool,

    /// 导出 RtlIndex XML 到目录（每源文件一个 XML + index.xml）
    #[arg(long)]
    pub xml: Option<PathBuf>,

    /// 存在黑盒（undef）模块时退出码 1
    #[arg(long)]
    pub fail_on_undef: bool,
}
