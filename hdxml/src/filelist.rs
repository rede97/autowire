//! 输入收集：.f 列表 / 目录遍历 / 散文件（语义见 docs/cli.md §2 共享输入组）。
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

    /// 展开一行中的 `$VAR` 整段环境变量（按 `/` 分段）
    fn expand_line(line: &str) -> Result<PathBuf> {
        let mut out = PathBuf::with_capacity(128);
        for seg in line.split('/') {
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
                None => (line, line.ends_with(".f")),
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

/// 三来源并集去重后的文件集合
#[derive(Debug, Default)]
pub struct FilesSet {
    pub files: Vec<PathBuf>,
}

impl FilesSet {
    pub fn collect(input: &crate::args::InputArgs) -> Result<Self> {
        let mut files: HashSet<PathBuf> = HashSet::new();
        for f in &input.filelist {
            Self::walk_filelist(&mut files, f)?;
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
        Ok(Self { files })
    }

    fn walk_filelist(files: &mut HashSet<PathBuf>, p: &Path) -> Result<()> {
        let fl = FileList::from_file(p)?;
        for entry in fl {
            match entry? {
                FileEntry::Nested(n) => Self::walk_filelist(files, &n)?,
                FileEntry::Source(s) => {
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
