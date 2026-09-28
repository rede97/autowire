//! 输入收集：.f/.vc 列表 / 目录遍历 / 散文件（语义见 docs/hdxml/cli.md §2 共享输入组）。
//! 与 svo 的差异：全部错误走 anyhow::Result，不再 panic。
//!
//! VCS 风格列表的最小支持子集：源路径、`#`/`//` 注释、`$ENV` 整段展开、
//! `-f`（内容相对 CWD）/`-F`（内容相对该列表所在目录）嵌套、`+incdir+`、`+define+`。
//! 其余 `+`/`-` 开关一律报错：库搜索（`-y`/`+libext+`/`-v`）与仿真器开关不实现。

use anyhow::{Context, Result, anyhow};
use std::collections::{HashSet, VecDeque};
use std::env;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// .f/.vc 文件解析器：逐行产出条目；支持 `#`/`//` 注释、`-f`/`-F` 嵌套、
/// `+incdir+`、`+define+`、`$ENV` 整段展开。不支持的开关报错。
pub struct FileList {
    content: String,
    idx: usize,
    /// 一行可能产出多条（+incdir+a+b），多余的排在这里
    pending: VecDeque<FileEntry>,
    /// 相对路径基准；None = 按原写法（CWD 相对），Some = 该列表所在目录（-F 语义）
    base: Option<PathBuf>,
    /// 列表自身路径（错误信息定位）
    name: PathBuf,
}

/// 列表中的一行解析结果
pub enum FileEntry {
    /// 普通源文件路径
    Source(PathBuf),
    /// 嵌套的另一个列表（-f 或按扩展名推断；内容相对 CWD）
    Nested(PathBuf),
    /// 嵌套的另一个列表（-F；内容相对该子列表所在目录）
    NestedF(PathBuf),
    /// +incdir+：并入 include 搜索路径
    IncDir(PathBuf),
    /// +define+NAME[=VALUE]：并入宏定义（无值按 NAME=1，与 -D 一致）
    Define(String),
}

impl FileList {
    pub fn from_file<P: AsRef<Path>>(p: P) -> Result<Self> {
        Self::read(p.as_ref(), None)
    }

    /// -F 语义：列表内的相对路径相对该列表所在目录
    pub fn from_file_frel<P: AsRef<Path>>(p: P) -> Result<Self> {
        let p = p.as_ref();
        let base = p.parent().map(Path::to_path_buf);
        Self::read(p, base)
    }

    fn read(p: &Path, base: Option<PathBuf>) -> Result<Self> {
        let content = std::fs::read_to_string(p)
            .with_context(|| format!("failed to read filelist: {}", p.display()))?;
        Ok(Self {
            content,
            idx: 0,
            pending: VecDeque::new(),
            base,
            name: p.to_path_buf(),
        })
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

    /// 相对路径按基准目录改写；基准为 None 或绝对路径时原样
    fn resolve(&self, p: PathBuf) -> PathBuf {
        match &self.base {
            Some(b) if p.is_relative() => b.join(p),
            _ => p,
        }
    }

    fn unsupported(&self, line: &str) -> anyhow::Error {
        anyhow!(
            "filelist {}: unsupported option '{}' (supported: source paths, -f/-F, +incdir+, +define+; library search -y/+libext+/-v and simulator flags are not implemented)",
            self.name.display(),
            line
        )
    }

    /// 分类一行，可能产出多条（+incdir+a+b / +define+A=1+B）
    fn classify(&self, line: &str) -> Result<Vec<FileEntry>> {
        if let Some(rest) = line.strip_prefix("+incdir+") {
            if rest.is_empty() {
                return Err(anyhow!(
                    "filelist {}: empty +incdir+",
                    self.name.display()
                ));
            }
            return rest
                .split('+')
                .map(|d| {
                    if d.is_empty() {
                        Err(anyhow!(
                            "filelist {}: empty segment in '{}'",
                            self.name.display(),
                            line
                        ))
                    } else {
                        Ok(FileEntry::IncDir(self.resolve(PathBuf::from(expand_env(d)?))))
                    }
                })
                .collect();
        }
        if let Some(rest) = line.strip_prefix("+define+") {
            if rest.is_empty() {
                return Err(anyhow!(
                    "filelist {}: empty +define+",
                    self.name.display()
                ));
            }
            return rest
                .split('+')
                .map(|d| {
                    let name = d.split('=').next().unwrap_or("");
                    if name.is_empty() {
                        Err(anyhow!(
                            "filelist {}: bad +define+ segment in '{}'",
                            self.name.display(),
                            line
                        ))
                    } else {
                        Ok(FileEntry::Define(expand_env(d)?))
                    }
                })
                .collect();
        }
        if line.starts_with('+') {
            return Err(self.unsupported(line));
        }
        if let Some(rest) = strip_flag(line, "-f") {
            if rest.is_empty() {
                return Err(anyhow!("filelist {}: -f without a path", self.name.display()));
            }
            return Ok(vec![FileEntry::Nested(self.resolve(PathBuf::from(
                expand_env(rest)?,
            )))]);
        }
        if let Some(rest) = strip_flag(line, "-F") {
            if rest.is_empty() {
                return Err(anyhow!("filelist {}: -F without a path", self.name.display()));
            }
            return Ok(vec![FileEntry::NestedF(self.resolve(PathBuf::from(
                expand_env(rest)?,
            )))]);
        }
        if line.starts_with('-') {
            return Err(self.unsupported(line));
        }
        let p = self.resolve(PathBuf::from(expand_env(line)?));
        Ok(vec![if is_list_file(line) {
            FileEntry::Nested(p)
        } else {
            FileEntry::Source(p)
        }])
    }
}

/// 精确匹配 `-f` / `-F` 开关：开关与路径之间必须有空白（"-full64" 不是 -f）
fn strip_flag<'a>(line: &'a str, flag: &str) -> Option<&'a str> {
    let rest = line.strip_prefix(flag)?;
    let rest = rest.strip_prefix(|c: char| c.is_whitespace())?;
    Some(rest.trim())
}

/// 展开一行中的 `$VAR` 整段环境变量（按 `/` 分段）
fn expand_env(line: &str) -> Result<String> {
    let mut out = String::with_capacity(line.len() + 32);
    for (i, seg) in line.split('/').enumerate() {
        if i > 0 {
            out.push('/');
        }
        match seg.strip_prefix('$') {
            Some(var) if !var.is_empty() => {
                let val = env::var(var).map_err(|_| {
                    anyhow!("environment variable `${var}` in filelist is not defined")
                })?;
                out.push_str(&val);
            }
            _ => out.push_str(seg),
        }
    }
    Ok(out)
}

impl Iterator for FileList {
    type Item = Result<FileEntry>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if let Some(e) = self.pending.pop_front() {
                return Some(Ok(e));
            }
            let line = self.next_line()?.trim().to_string();
            if line.is_empty() || line.starts_with('#') || line.starts_with("//") {
                continue;
            }
            return Some(match self.classify(&line) {
                Ok(mut entries) => {
                    let first = entries.remove(0);
                    self.pending.extend(entries);
                    Ok(first)
                }
                Err(e) => Err(e),
            });
        }
    }
}

/// 列表文件扩展名：`.f` / `.vc` / `.lst` / `.flst` / `.list`（无 `-f` 前缀时按后缀推断嵌套）
fn is_list_file(line: &str) -> bool {
    matches!(
        Path::new(line).extension().and_then(|e| e.to_str()),
        Some("f" | "vc" | "lst" | "flst" | "list")
    )
}

/// 三来源并集去重后的文件集合
#[derive(Debug, Default)]
pub struct FilesSet {
    pub files: Vec<PathBuf>,
    /// 收集期警告（如 .svh 条目被跳过），由调用方打印
    pub warnings: Vec<String>,
    /// filelist 内 `+incdir+` 收集的 include 目录（按出现顺序，跟在 CLI -I 之后）
    pub incdirs: Vec<PathBuf>,
    /// filelist 内 `+define+` 收集的宏（NAME 或 NAME=VALUE，跟在 CLI -D 之后）
    pub defines: Vec<String>,
}

impl FilesSet {
    pub fn collect(input: &crate::args::InputArgs) -> Result<Self> {
        let mut files: HashSet<PathBuf> = HashSet::new();
        let mut warnings: Vec<String> = Vec::new();
        let mut incdirs: Vec<PathBuf> = Vec::new();
        let mut defines: Vec<String> = Vec::new();
        for f in &input.filelist {
            Self::walk_filelist(&mut files, &mut incdirs, &mut defines, &mut warnings, f, false)?;
        }
        for d in &input.walk_dirs {
            Self::walk_directory(&mut files, d)?;
        }
        for s in &input.sources {
            let c = s
                .canonicalize()
                .with_context(|| format!("source file not found: {}", s.display()))?;
            files.insert(c);
        }
        let exclude: HashSet<&str> = input.exclude_filenames.iter().map(String::as_str).collect();
        let exclude_dirs: HashSet<&str> = input.exclude_dirs.iter().map(String::as_str).collect();
        files.retain(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_none_or(|n| !exclude.contains(n))
                && !p.components().any(|c| {
                    c.as_os_str().to_str().is_some_and(|n| exclude_dirs.contains(n))
                })
        });
        let mut files: Vec<PathBuf> = files.into_iter().collect();
        files.sort(); // 稳定顺序：进度与日志可复现
        Ok(Self {
            files,
            warnings,
            incdirs,
            defines,
        })
    }

    fn walk_filelist(
        files: &mut HashSet<PathBuf>,
        incdirs: &mut Vec<PathBuf>,
        defines: &mut Vec<String>,
        warnings: &mut Vec<String>,
        p: &Path,
        frel: bool,
    ) -> Result<()> {
        let fl = if frel {
            FileList::from_file_frel(p)?
        } else {
            FileList::from_file(p)?
        };
        for entry in fl {
            match entry? {
                FileEntry::Nested(n) => {
                    Self::walk_filelist(files, incdirs, defines, warnings, &n, false)?
                }
                FileEntry::NestedF(n) => {
                    Self::walk_filelist(files, incdirs, defines, warnings, &n, true)?
                }
                FileEntry::IncDir(d) => incdirs.push(d),
                FileEntry::Define(d) => defines.push(d),
                FileEntry::Source(s) => {
                    // 规则：列表中的 .svh 不识别——跳过并警告。
                    // svh 只走两条路：源内 `include（预处理）或 --define-headers 独立加载，
                    // 保证 hdxml 与 EDA 行为一致（降级方案：EDA 用 eda_load.f 头部加载 svh，
                    // 与分析器共享纯源码 rtl.f）。
                    if s.extension().and_then(|e| e.to_str()) == Some("svh") {
                        warnings.push(format!(
                            "filelist {}: skipping .svh entry {} (macro headers belong in --define-headers or in-source `include)",
                            p.display(),
                            s.display()
                        ));
                        continue;
                    }
                    let c = s
                        .canonicalize()
                        .with_context(|| format!("file in filelist not found: {}", s.display()))?;
                    files.insert(c);
                }
            }
        }
        Ok(())
    }

    fn walk_directory(files: &mut HashSet<PathBuf>, dir: &Path) -> Result<()> {
        for entry in WalkDir::new(dir).follow_links(false) {
            let entry = entry.with_context(|| format!("failed to walk dir: {}", dir.display()))?;
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
        for ext in ["f", "vc", "lst", "flst", "list"] {
            let entries = parse_lines(&format!("sub/defs.{ext}\n"));
            assert!(
                matches!(&entries[0], Ok(FileEntry::Nested(_))),
                ".{ext} must be inferred as a nested list by extension"
            );
        }
    }

    #[test]
    fn svh_entries_skipped_with_warning() {
        let dir = std::env::temp_dir().join(format!("hdxml_test_svh_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("top.sv"), "module t; endmodule\n").unwrap();
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
        assert_eq!(fs.files.len(), 1, ".svh must be skipped");
        assert!(fs.files[0].ends_with("top.sv"));
        assert_eq!(fs.warnings.len(), 1, "exactly one warning must be produced");
        assert!(fs.warnings[0].contains("defs.svh"));
    }

    #[test]
    fn absolute_path_keeps_leading_slash() {
        let entries = parse_lines("/tmp/ws/rtl/top.sv\n");
        assert!(
            matches!(&entries[0], Ok(FileEntry::Source(p)) if p == Path::new("/tmp/ws/rtl/top.sv")),
            "leading / of an absolute path must not be lost"
        );
    }

    #[test]
    fn exclude_dirs_prunes_matching_components() {
        let dir = std::env::temp_dir().join(format!("hdxml_test_xdirs_{}", std::process::id()));
        std::fs::create_dir_all(dir.join("rtl")).unwrap();
        std::fs::create_dir_all(dir.join("dv/uvm")).unwrap();
        std::fs::write(dir.join("rtl/keep.sv"), "module keep; endmodule\n").unwrap();
        std::fs::write(dir.join("dv/uvm/tb.sv"), "module tb; endmodule\n").unwrap();

        let input = crate::args::InputArgs {
            walk_dirs: vec![dir.clone()],
            exclude_dirs: vec!["dv".to_string()],
            ..Default::default()
        };
        let fs = FilesSet::collect(&input).unwrap();
        assert_eq!(fs.files.len(), 1, "dv subtree must be excluded: {:?}", fs.files);
        assert!(fs.files[0].ends_with("keep.sv"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn parse_lines(content: &str) -> Vec<Result<FileEntry>> {
        FileList {
            content: content.into(),
            idx: 0,
            pending: VecDeque::new(),
            base: None,
            name: PathBuf::from("test"),
        }
        .collect()
    }

    #[test]
    fn comments_and_blank_lines_are_skipped() {
        let entries = parse_lines("# comment\n// c2\n\nfoo.sv\n");
        assert_eq!(entries.len(), 1);
        assert!(matches!(&entries[0], Ok(FileEntry::Source(p)) if p == Path::new("foo.sv")));
    }

    #[test]
    fn f_nesting_and_extension_inference() {
        let entries = parse_lines("a.sv\n-f sub/list.f\nother.f\n");
        assert!(matches!(entries[0], Ok(FileEntry::Source(_))));
        assert!(matches!(entries[1], Ok(FileEntry::Nested(_))));
        // 无 -f 前缀但 .f 后缀也视为嵌套（svo 兼容行为）
        assert!(matches!(entries[2], Ok(FileEntry::Nested(_))));
    }

    #[test]
    fn env_var_segment_expansion() {
        unsafe { env::set_var("STUNE_TEST_WS", "/tmp/ws") };
        let entries = parse_lines("$STUNE_TEST_WS/rtl/top.sv\n");
        assert!(
            matches!(&entries[0], Ok(FileEntry::Source(p)) if p == Path::new("/tmp/ws/rtl/top.sv"))
        );
    }

    #[test]
    fn undefined_env_var_errors_instead_of_panic() {
        let entries = parse_lines("$STUNE_NO_SUCH_VAR_XYZ/x.sv\n");
        assert!(entries[0].is_err());
    }

    #[test]
    fn vc_incdir_and_define() {
        let entries = parse_lines("+incdir+rtl/include\n+define+SYNTHESIS\n+define+WIDTH=16\n");
        assert!(matches!(&entries[0], Ok(FileEntry::IncDir(p)) if p == Path::new("rtl/include")));
        assert!(matches!(&entries[1], Ok(FileEntry::Define(d)) if d == "SYNTHESIS"));
        assert!(matches!(&entries[2], Ok(FileEntry::Define(d)) if d == "WIDTH=16"));
    }

    #[test]
    fn vc_multi_segment_options() {
        let entries = parse_lines("+incdir+a+b/c\n+define+X=1+Y\n");
        assert_eq!(entries.len(), 4);
        assert!(matches!(&entries[0], Ok(FileEntry::IncDir(p)) if p == Path::new("a")));
        assert!(matches!(&entries[1], Ok(FileEntry::IncDir(p)) if p == Path::new("b/c")));
        assert!(matches!(&entries[2], Ok(FileEntry::Define(d)) if d == "X=1"));
        assert!(matches!(&entries[3], Ok(FileEntry::Define(d)) if d == "Y"));
    }

    #[test]
    fn vc_unsupported_options_error() {
        for line in [
            "-y rtl/lib",
            "+libext+.v+.sv",
            "-v cells.v",
            "-sverilog",
            "-timescale=1ns/1ps",
            "-full64",
            "+notimingcheck",
        ] {
            let entries = parse_lines(&format!("{line}\n"));
            assert!(
                matches!(&entries[0], Err(e) if e.to_string().contains("unsupported option")),
                "{line} must be rejected"
            );
        }
    }

    #[test]
    fn f_flag_requires_whitespace() {
        // "-full64" 之类不得被当作 -f 嵌套
        let entries = parse_lines("-full64\n");
        assert!(entries[0].is_err());
    }

    #[test]
    fn big_f_nested_resolves_relative_to_list_dir() {
        let dir = std::env::temp_dir().join(format!("hdxml_test_bigf_{}", std::process::id()));
        let sub = dir.join("ip/sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("leaf.sv"), "module leaf; endmodule\n").unwrap();
        std::fs::write(sub.join("ip.vc"), "leaf.sv\n").unwrap();
        std::fs::write(dir.join("top.sv"), "module top; endmodule\n").unwrap();
        let top_list = dir.join("top.f");
        std::fs::write(&top_list, format!("-F {}\n{}/top.sv\n", sub.join("ip.vc").display(), dir.display())).unwrap();

        let input = crate::args::InputArgs {
            filelist: vec![top_list],
            ..Default::default()
        };
        let fs = FilesSet::collect(&input).unwrap();
        assert_eq!(fs.files.len(), 2);
        assert!(fs.files.iter().any(|p| p.ends_with("ip/sub/leaf.sv")), "-F list contents resolve against the list dir: {:?}", fs.files);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn vc_incdir_and_define_reach_files_set() {
        let dir = std::env::temp_dir().join(format!("hdxml_test_vcset_{}", std::process::id()));
        std::fs::create_dir_all(dir.join("inc")).unwrap();
        std::fs::write(dir.join("top.sv"), "module t; endmodule\n").unwrap();
        let list = dir.join("rtl.vc");
        std::fs::write(
            &list,
            format!("+incdir+{}/inc\n+define+FOO=1\n{}/top.sv\n", dir.display(), dir.display()),
        )
        .unwrap();

        let input = crate::args::InputArgs {
            filelist: vec![list],
            ..Default::default()
        };
        let fs = FilesSet::collect(&input).unwrap();
        assert_eq!(fs.files.len(), 1);
        assert_eq!(fs.incdirs, vec![dir.join("inc")]);
        assert_eq!(fs.defines, vec!["FOO=1".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
