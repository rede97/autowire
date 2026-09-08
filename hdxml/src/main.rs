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
        .context("thread pool init failed")?;
    let pc = ProgressCenter::new();

    cmd_analysis(&cli.analysis, &pool, &pc)
}

fn cmd_analysis(a: &AnalysisArgs, pool: &rayon::ThreadPool, pc: &ProgressCenter) -> Result<()> {
    let defines = db::build_defines(&a.input.defines, &a.input.define_headers, &a.input.expand_headers, &a.input.keep_raw, &a.input.incdirs)?;
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
        anyhow::bail!("input set is empty (need at least one of -f/-s/-w)");
    }
    pc.println(&format!("input files: {}", files.len()));

    let drive = db::Drive {
        files: &files,
        defines: &defines,
        incdirs: &a.input.incdirs,
        pool,
        pc,
        sub_bars: a.sub_bars,
    };
    // 有输出目录即增量：未变更文件复用缓存（--refresh 强制全量）；无输出目录纯终端分析
    let mut inc: Option<(usize, usize)> = None; // (reused, parsed)，供 --summary
    let (db, stamps) = if let Some(dir) = &a.output_dir {
        let (db, stamps, reused) = db::analyze_incremental(&drive, &define_pairs, dir, a.refresh)?;
        inc = Some((reused, files.len() - reused));
        pc.println(&format!(
            "incremental: reused {reused} files, parsed {} files{}",
            files.len() - reused,
            if a.refresh { " (--refresh)" } else { "" },
        ));
        (db, stamps)
    } else {
        db::analyze_files(&drive)?
    };

    // 摘要
    pc.println(&format!(
        "modules: {}  tops: {}  blackbox: {}  error files: {}",
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

    // XML 导出（-o/--output-dir）
    if let Some(dir) = &a.output_dir {
        let stats = XmlExport::new(&db, &files, &define_pairs, &stamps, &a.input.incdirs).write(dir)?;
        pc.println(&format!(
            "XML written: {} (files {}, modules {})",
            dir.display(),
            stats.files,
            stats.modules
        ));
    }

    // 机器可读摘要（--summary；key: value 行，供脚本/CI 采集）
    if let Some(path) = &a.summary {
        let mut out = format!(
            "files: {}\nmodules: {}\ntops: {}\nblackbox: {}\nerror_files: {}\n",
            files.len(),
            db.defs.len(),
            db.tops.len(),
            db.undef.len(),
            db.errors.len()
        );
        if let Some((reused, parsed)) = inc {
            out.push_str(&format!("reused: {reused}\nparsed: {parsed}\n"));
        }
        std::fs::write(path, out)
            .with_context(|| format!("failed to write summary {}", path.display()))?;
    }

    if !db.errors.is_empty() {
        std::process::exit(1);
    }
    if a.fail_on_undef && !db.undef.is_empty() {
        std::process::exit(1);
    }
    Ok(())
}
