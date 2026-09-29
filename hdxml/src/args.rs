//! CLI definition (docs/hdxml/cli.md). Single function = hierarchy analysis (no subcommands; args flat at top level).

use clap::{Args, Parser};
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(
    version,
    about = "hdxml — SystemVerilog RTL analyzer (hierarchy analysis: module/parameter/port extraction, XML export)",
    arg_required_else_help = true
)]
pub struct Cli {
    #[command(flatten)]
    pub analysis: AnalysisArgs,

    /// Worker thread count (default: CPU cores)
    #[arg(short, long, global = true)]
    pub threads: Option<usize>,

    /// Worker thread stack size (MiB)
    #[arg(long, default_value_t = 16, global = true)]
    pub stack_size: usize,

    /// Log level (-v=info, -vv=debug)
    #[arg(short, long, action = clap::ArgAction::Count, global = true)]
    pub verbose: u8,

    /// Log file path (default: no log file)
    #[arg(long, global = true)]
    pub log_file: Option<PathBuf>,
}

/// Input source group (docs/hdxml/cli.md §2)
#[derive(Args, Debug, Default)]
pub struct InputArgs {
    /// Source file lists (.f; supports # and // comments, nested -f, $ENV expansion)
    #[arg(short, long, num_args = 1..)]
    pub filelist: Vec<PathBuf>,

    /// Loose source files (.sv/.v)
    #[arg(short, long, num_args = 1..)]
    pub sources: Vec<PathBuf>,

    /// Recursively walk directories collecting *.sv/*.v
    #[arg(short, long, num_args = 1..)]
    pub walk_dirs: Vec<PathBuf>,

    /// Exclude by file name (directory part not considered)
    #[arg(long, num_args = 1..)]
    pub exclude_filenames: Vec<String>,

    /// Exclude files under any directory with this name (any path component, e.g. dv/tb)
    #[arg(long, num_args = 1..)]
    pub exclude_dirs: Vec<String>,

    /// Macro defines (NAME=VALUE; bare NAME means NAME=1)
    #[arg(short = 'D', long, num_args = 1..)]
    pub defines: Vec<String>,

    /// Macro define headers (extract `define from them, kept raw as sentinels by default; replaces the traditional EDA ".f-head .svh" global-macro trick — per-file parallel preprocessing cannot carry macros across files)
    #[arg(long, num_args = 1..)]
    pub define_headers: Vec<PathBuf>,

    /// Macro define headers with real expansion (unlike --define-headers' raw sentinels;
    /// for assertion/utility macro libraries whose expansions must parse, e.g. lowrisc prim_assert)
    #[arg(long, num_args = 1..)]
    pub expand_headers: Vec<PathBuf>,

    /// Register macros as raw (sentinel expansion): expressions keep `NAME verbatim and `ifdef NAME still evaluates true (autowire.toml keep_raw goes through here)
    #[arg(long, num_args = 1..)]
    pub keep_raw: Vec<String>,

    /// Include search paths (+incdir)
    #[arg(short = 'I', long, num_args = 1..)]
    pub incdirs: Vec<PathBuf>,
}

/// 导出格式：xml = 仅 XML（现状）；json = XML 之外再写 JSON 镜像（index.json + 每文件 *.json）。
/// XML 始终写出——它是增量缓存的载体。
#[derive(clap::ValueEnum, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum OutFormat {
    #[default]
    Xml,
    Json,
}

#[derive(Args, Debug)]
pub struct AnalysisArgs {
    #[command(flatten)]
    pub input: InputArgs,

    /// Print the dependency tree
    #[arg(long)]
    pub tree: bool,

    /// Per-thread sub progress bars (spinner shows the file being processed, svo-style)
    #[arg(long)]
    pub sub_bars: bool,

    /// Output directory for the RtlIndex export (one XML per source file + index.xml).
    /// With -o, analysis is incremental by default: unchanged files are reused from
    /// the previous export (mtime+size fast path, content-hash arbiter;
    /// `include closure tracked; tool/defines/incdirs change re-parses everything)
    #[arg(short, long)]
    pub output_dir: Option<PathBuf>,

    /// Force full re-parse, ignoring the cache in the output directory (rewrites it)
    #[arg(long)]
    pub refresh: bool,

    /// Write a machine-readable run summary (key: value lines) to FILE
    #[arg(long)]
    pub summary: Option<PathBuf>,

    /// Export format: xml (default) or json (JSON mirror alongside the XML cache)
    #[arg(long, value_enum, default_value_t = OutFormat::Xml)]
    pub format: OutFormat,
    /// Exit code 1 when blackbox (undef) modules exist
    #[arg(long)]
    pub fail_on_undef: bool,
}
