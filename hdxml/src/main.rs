use anyhow::{Context, Result};
use clap::Parser;
use hdxml::args::{AnalysisArgs, Cli};
use hdxml::db::{self, xml::XmlExport};
use hdxml::filelist::FilesSet;
use hdxml::progress::ProgressCenter;

fn main() -> Result<()> {
    let cli = Cli::parse();
    let threads = cli
        .threads
        .unwrap_or_else(|| std::thread::available_parallelism().map_or(4, |n| n.get()));
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .stack_size(cli.stack_size * 1024 * 1024)
        .build()
        .context("线程池初始化失败")?;
    let pc = ProgressCenter::new();

    cmd_analysis(&cli.analysis, &pool, &pc)
}

fn cmd_analysis(a: &AnalysisArgs, pool: &rayon::ThreadPool, pc: &ProgressCenter) -> Result<()> {
    let defines = db::build_defines(&a.input.defines, &a.input.define_headers, &a.input.keep_raw, &a.input.incdirs)?;
    // 供 index.xml 记录：排序的 (名称, 值文本) 列表；宏变更 → 指纹变 → 整库作废
    let mut define_pairs: Vec<(String, Option<String>)> = defines
        .iter()
        .map(|(n, d)| {
            let v = d.as_ref().and_then(|d| d.text.as_ref().map(|t| t.text.clone()));
            // keep_raw 哨兵宏在 index.xml 记为 raw（raw="true"、无 value）；
            // 哨兵文本形如 `PREFIX`NAME 或带形参 `PREFIX`NAME(a,b)
            match v {
                Some(t)
                    if t
                        .strip_prefix(db::MACRO_RAW_PREFIX)
                        .is_some_and(|rest| rest == *n || rest.starts_with(&format!("{n}("))) =>
                {
                    (n.clone(), None)
                }
                other => (n.clone(), other),
            }
        })
        .collect();
    define_pairs.sort();
    let fs = FilesSet::collect(&a.input)?;
    for w in &fs.warnings {
        pc.println(&format!("warning: {w}"));
    }
    let files = fs.files;
    if files.is_empty() {
        anyhow::bail!("输入集合为空（-f/-s/-w 至少需要一项）");
    }
    pc.println(&format!("输入文件: {}", files.len()));

    let db = db::analyze_files(&files, &defines, &a.input.incdirs, pool, &pc, a.sub_bars)?;

    // 摘要
    pc.println(&format!(
        "模块: {}  顶层: {}  黑盒: {}  错误文件: {}",
        db.defs.len(),
        db.tops.len(),
        db.undef.len(),
        db.errors.len()
    ));
    for u in &db.undef {
        pc.println(&format!("  blackbox: {u}"));
    }
    for (path, errs) in &db.errors {
        for e in errs {
            let loc = match (e.line, e.column) {
                (Some(l), Some(c)) => format!(":{l}:{c}"),
                _ => String::new(),
            };
            pc.println(&format!("  error: {}{loc}: {}", path.display(), e.message));
        }
    }
    if a.tree {
        for t in db::dep_tree(&db) {
            pc.println(&format!("{t}"));
        }
    }

    // XML 导出（--xml）
    if let Some(dir) = &a.xml {
        let stats = XmlExport::new(&db, &files, &define_pairs).write(dir)?;
        pc.println(&format!(
            "XML 已写入: {}（文件 {}，模块 {}）",
            dir.display(),
            stats.files,
            stats.modules
        ));
    }

    if !db.errors.is_empty() {
        std::process::exit(1);
    }
    if a.fail_on_undef && !db.undef.is_empty() {
        std::process::exit(1);
    }
    Ok(())
}
