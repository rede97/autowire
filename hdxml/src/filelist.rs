//! 输入收集：.f 列表 / 目录遍历 / 散文件（语义见 docs/hdxml/cli.md §2 共享输入组）。
//! 与 svo 的差异：全部错误走 anyhow::Result，不再 panic。

use anyhow::{Context, Result, anyhow};
use std::collections::HashSet;
use std::env;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// .f 文件解析器：逐行产出路径；支持 `#`/`//` 注释、`-f` 嵌套、`$ENV` 整段展开。
pub struct FileList {
    content: String,
    idx: usize,
}

/// .f 中的一行解析结果
pub enum FileEntry {
    /// 普通源文件路径
    Source(PathBuf),
    /// 嵌套的另一个 .f 列表
    Nested(PathBuf),
}

impl FileList {
    pub fn from_file<P: AsRef<Path>>(p: P) -> Result<Self> {
        let content = std::fs::read_to_string(p.as_ref())
            .with_context(|| format!("读取 filelist 失败: {}", p.as_ref().display()))?;
        Ok(Self { content, idx: 0 })
    }

    fn next_line(&mut self) -> Option<&str> {
        if self.idx >= self.content.len() {
            return None;
        }
        let rest = &self.content[self.idx..];
        match rest.find('\n') {
            Some(i) => {
                self.idx += i + 1;
                Some(&rest[..i])
            }
            None => {
                self.idx = self.content.len();
                Some(rest)
            }
        }
    }

    /// 展开一行中的 `$VAR` 整段环境变量（按 `/` 分段）；绝对路径的前导 `/` 必须保留
    fn expand_line(line: &str) -> Result<PathBuf> {
        let mut out = PathBuf::with_capacity(128);
        for (i, seg) in line.split('/').enumerate() {
            if i == 0 && seg.is_empty() {
                out.push("/");
                continue;
            }
            match seg.strip_prefix('$') {
                Some(var) => {
                    let val = env::var(var)
                        .map_err(|_| anyhow!("filelist 中环境变量 `${var}` 未定义"))?;
                    out.push(val);
                }
                None => out.push(seg),
            }
        }
        Ok(out)
    }
}

impl Iterator for FileList {
    type Item = Result<FileEntry>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            let line = self.next_line()?.trim();
            if line.is_empty() || line.starts_with('#') || line.starts_with("//") {
                continue;
            }
            let (line, nested) = match line.strip_prefix("-f") {
                Some(rest) => (rest.trim(), true),
                None => (line, is_list_file(line)),
            };
            return Some(match Self::expand_line(line) {
                Ok(p) => Ok(if nested {
                    FileEntry::Nested(p)
                } else {
                    FileEntry::Source(p)
                }),
                Err(e) => Err(e),
            });
        }
    }
}

/// 列表文件扩展名：`.f` / `.lst` / `.flst` / `.list`（无 `-f` 前缀时按后缀推断嵌套）
fn is_list_file(line: &str) -> bool {
    matches!(
        Path::new(line).extension().and_then(|e| e.to_str()),
        Some("f" | "lst" | "flst" | "list")
    )
}

/// 三来源并集去重后的文件集合
#[derive(Debug, Default)]
pub struct FilesSet {
    pub files: Vec<PathBuf>,
    /// 收集期警告（如 .svh 条目被跳过），由调用方打印
    pub warnings: Vec<String>,
}

impl FilesSet {
    pub fn collect(input: &crate::args::InputArgs) -> Result<Self> {
        let mut files: HashSet<PathBuf> = HashSet::new();
        let mut warnings: Vec<String> = Vec::new();
        for f in &input.filelist {
            Self::walk_filelist(&mut files, &mut warnings, f)?;
        }
        for d in &input.walk_dirs {
            Self::walk_directory(&mut files, d)?;
        }
        for s in &input.sources {
            let c = s
                .canonicalize()
                .with_context(|| format!("源文件不存在: {}", s.display()))?;
            files.insert(c);
        }
        let exclude: HashSet<&str> = input.exclude_filenames.iter().map(String::as_str).collect();
        files.retain(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_none_or(|n| !exclude.contains(n))
        });
        let mut files: Vec<PathBuf> = files.into_iter().collect();
        files.sort(); // 稳定顺序：进度与日志可复现
        Ok(Self { files, warnings })
    }

    fn walk_filelist(files: &mut HashSet<PathBuf>, warnings: &mut Vec<String>, p: &Path) -> Result<()> {
        let fl = FileList::from_file(p)?;
        for entry in fl {
            match entry? {
                FileEntry::Nested(n) => Self::walk_filelist(files, warnings, &n)?,
                FileEntry::Source(s) => {
                    // 规则：列表中的 .svh 不识别——跳过并警告。
                    // svh 只走两条路：源内 `include（预处理）或 --define-headers 独立加载，
                    // 保证 hdxml 与 EDA 行为一致（降级方案：EDA 用 eda_load.f 头部加载 svh，
                    // 与分析器共享纯源码 rtl.f）。
                    if s.extension().and_then(|e| e.to_str()) == Some("svh") {
                        warnings.push(format!(
                            "filelist {}: 跳过 .svh 条目 {}（宏头文件请用 --define-headers 或源内 `include）",
                            p.display(),
                            s.display()
                        ));
                        continue;
                    }
                    let c = s
                        .canonicalize()
                        .with_context(|| format!("filelist 中的文件不存在: {}", s.display()))?;
                    files.insert(c);
                }
            }
        }
        Ok(())
    }

    fn walk_directory(files: &mut HashSet<PathBuf>, dir: &Path) -> Result<()> {
        for entry in WalkDir::new(dir).follow_links(false) {
            let entry = entry.with_context(|| format!("遍历目录失败: {}", dir.display()))?;
            let p = entry.path();
            if !p.is_file() {
                continue;
            }
            if let Some("sv" | "v") = p.extension().and_then(|e| e.to_str()) {
                files.insert(p.canonicalize()?);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_extensions_infer_nested() {
        for ext in ["f", "lst", "flst", "list"] {
            let entries = parse_lines(&format!("sub/defs.{ext}\n"));
            assert!(
                matches!(&entries[0], Ok(FileEntry::Nested(_))),
                ".{ext} 必须按后缀推断为嵌套列表"
            );
        }
    }

    #[test]
    fn svh_entries_skipped_with_warning() {
        let dir = std::env::temp_dir().join(format!("hdxml_test_svh_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("top.sv"), "module t; endmodule\n").unwrap();

    #[test]
    fn absolute_path_keeps_leading_slash() {
        let entries = parse_lines("/tmp/ws/rtl/top.sv\n");
        assert!(
            matches!(&entries[0], Ok(FileEntry::Source(p)) if p == Path::new("/tmp/ws/rtl/top.sv")),
            "绝对路径前导 / 不得丢失"
        );
    }

        std::fs::write(dir.join("defs.svh"), "`define W 8\n").unwrap();
        let list = dir.join("rtl.list");
        std::fs::write(
            &list,
            format!("{}/defs.svh\n{}/top.sv\n", dir.display(), dir.display()),
        )
        .unwrap();

        let input = crate::args::InputArgs {
            filelist: vec![list],
            ..Default::default()
        };
        let fs = FilesSet::collect(&input).unwrap();
        assert_eq!(fs.files.len(), 1, ".svh 必须被跳过");
        assert!(fs.files[0].ends_with("top.sv"));
        assert_eq!(fs.warnings.len(), 1, "必须产出一条警告");
        assert!(fs.warnings[0].contains("defs.svh"));
    }

    fn parse_lines(content: &str) -> Vec<Result<FileEntry>> {
        FileList {
            content: content.into(),
            idx: 0,
        }
        .collect()
    }

    #[test]
    fn 注释与空行被跳过() {
        let entries = parse_lines("# comment\n// c2\n\nfoo.sv\n");
        assert_eq!(entries.len(), 1);
        assert!(matches!(&entries[0], Ok(FileEntry::Source(p)) if p == Path::new("foo.sv")));
    }

    #[test]
    fn f嵌套与按后缀推断() {
        let entries = parse_lines("a.sv\n-f sub/list.f\nother.f\n");
        assert!(matches!(entries[0], Ok(FileEntry::Source(_))));
        assert!(matches!(entries[1], Ok(FileEntry::Nested(_))));
        // 无 -f 前缀但 .f 后缀也视为嵌套（svo 兼容行为）
        assert!(matches!(entries[2], Ok(FileEntry::Nested(_))));
    }

    #[test]
    fn 环境变量整段展开() {
        unsafe { env::set_var("STUNE_TEST_WS", "/tmp/ws") };
        let entries = parse_lines("$STUNE_TEST_WS/rtl/top.sv\n");
        assert!(
            matches!(&entries[0], Ok(FileEntry::Source(p)) if p == Path::new("/tmp/ws/rtl/top.sv"))
        );
    }

    #[test]
    fn 未定义环境变量报错而非panic() {
        let entries = parse_lines("$STUNE_NO_SUCH_VAR_XYZ/x.sv\n");
        assert!(entries[0].is_err());
    }
}
