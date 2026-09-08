//! DesignDb — 模块信息数据底座（docs/hdxml/module-info.md）。
//! 纯净分析层：无条件全量收集 params/ports/instances/层级，零功能标志位。

pub mod cache;
pub mod extract;
pub mod strip;
pub mod xml;

use anyhow::Result;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// 表达式：原文保真 + 依赖符号集（B-1：不求值）
#[derive(Debug, Clone, PartialEq)]
pub struct ExprText {
    pub text: String,
    pub deps: Vec<String>,
}

impl ExprText {
    pub fn new(text: &str) -> Self {
        Self {
            text: text.to_string(),
            deps: scan_identifiers(text),
        }
    }
}

/// 从表达式文本扫描标识符依赖（轻量词法，非完整解析）
fn scan_identifiers(text: &str) -> Vec<String> {
    const KEYWORDS: &[&str] = &[
        "logic",
        "wire",
        "reg",
        "int",
        "bit",
        "byte",
        "shortint",
        "longint",
        "integer",
        "time",
        "signed",
        "unsigned",
        "parameter",
        "localparam",
        "type",
        "input",
        "output",
        "inout",
        "ref",
        "interface",
        "modport",
        "void",
        "tri",
        "uwire",
        "wand",
        "wor",
        "shortreal",
        "real",
    ];
    let mut out = BTreeSet::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        let start_ok = c.is_ascii_alphabetic() || c == b'_' || c == b'`';
        if !start_ok {
            i += 1;
            continue;
        }
        let begin = i;
        while i < bytes.len()
            && (bytes[i].is_ascii_alphanumeric() || matches!(bytes[i], b'_' | b'$' | b'`'))
        {
            i += 1;
        }
        let tok = &text[begin..i];
        // 跳过纯数字开头不会发生（start_ok 不含数字）；跳过关键字
        if !KEYWORDS.contains(&tok) {
            out.insert(tok.to_string());
        }
    }
    out.into_iter().collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ParamKind {
    #[default]
    Parameter,
    Localparam,
    Type,
}

impl ParamKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Parameter => "parameter",
            Self::Localparam => "localparam",
            Self::Type => "type",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "parameter" => Some(Self::Parameter),
            "localparam" => Some(Self::Localparam),
            "type" => Some(Self::Type),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParamInfo {
    pub name: String,
    pub kind: ParamKind,
    pub data_type: Option<String>,
    pub default: Option<ExprText>,
    /// 文件相对字节偏移 [start, end)
    pub span: [usize; 2],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortDir {
    Input,
    Output,
    Inout,
    Ref,
    Interface,
}

impl PortDir {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Input => "input",
            Self::Output => "output",
            Self::Inout => "inout",
            Self::Ref => "ref",
            Self::Interface => "interface",
        }
    }

    /// 缓存 XML 标签名还原方向（`<port>` 为方向未知，由调用方映射 None）
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "input" => Some(Self::Input),
            "output" => Some(Self::Output),
            "inout" => Some(Self::Inout),
            "ref" => Some(Self::Ref),
            "interface" => Some(Self::Interface),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PortInfo {
    pub name: String,
    pub dir: Option<PortDir>,
    pub data_type: Option<String>,
    pub interface: Option<String>,
    pub modport: Option<String>,
    /// 参数化维度原文，如 "W-1:0"（不含方括号）
    pub packed: Vec<ExprText>,
    pub unpacked: Vec<ExprText>,
    pub default: Option<ExprText>,
    pub span: [usize; 2],
}

/// 实例参数覆盖（v1 存表达式原文，不含 `.name(...)` 包裹与注释；不求值）
#[derive(Debug, Clone, PartialEq)]
pub struct ParamConn {
    /// 命名覆盖的参数名；位置连接为 None
    pub name: Option<String>,
    /// 覆盖表达式原文（如 `1`、`W`）
    pub value: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct InstanceInfo {
    pub inst: String,
    pub target: String,
    pub params: Vec<ParamConn>,
    pub span: [usize; 2],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ModKind {
    #[default]
    Module,
    Interface,
}

impl ModKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Module => "module",
            Self::Interface => "interface",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "module" => Some(Self::Module),
            "interface" => Some(Self::Interface),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModuleDecl {
    pub name: String,
    pub kind: ModKind,
    pub file: PathBuf,
    pub span: [usize; 2],
    pub params: Vec<ParamInfo>,
    pub ports: Vec<PortInfo>,
    pub instances: Vec<InstanceInfo>,
    pub content_hash: String,
    pub interface_sig: String,
}

/// 规范化：剥离全部空白（签名对格式不敏感，对内容敏感）
fn normalize(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

impl ModuleDecl {
    /// 接口签名（docs/hdxml/module-info.md §4）：参数+端口按声明序规范化后 blake3
    pub fn compute_sig(&self) -> String {
        let mut canon = String::with_capacity(256);
        for p in &self.params {
            canon.push_str(&format!(
                "{:?}|{}|{}|{}\n",
                p.kind,
                p.name,
                p.data_type.as_deref().map(normalize).unwrap_or_default(),
                p.default
                    .as_ref()
                    .map(|d| normalize(&d.text))
                    .unwrap_or_default(),
            ));
        }
        for q in &self.ports {
            canon.push_str(&format!(
                "{:?}|{}|{}|{}|{}|{}|{}\n",
                q.dir,
                q.name,
                q.data_type.as_deref().map(normalize).unwrap_or_default(),
                q.interface.as_deref().unwrap_or(""),
                q.modport.as_deref().unwrap_or(""),
                q.packed
                    .iter()
                    .map(|e| normalize(&e.text))
                    .collect::<Vec<_>>()
                    .join(","),
                q.unpacked
                    .iter()
                    .map(|e| normalize(&e.text))
                    .collect::<Vec<_>>()
                    .join(","),
            ));
        }
        short_hash(canon.as_bytes())
    }
}

pub fn short_hash(data: &[u8]) -> String {
    blake3::hash(data).to_hex()[..32].to_string()
}

/// 单文件分析错误（定位参考 ipchecker：sv-parser 错误 Debug 串尾部字节偏移 → 行列）
#[derive(Debug, Clone, PartialEq)]
pub struct FileError {
    pub message: String,
    /// 预处理后文本字节偏移（可定位时）
    pub offset: Option<usize>,
    /// 1-based 行/列（预处理后文本基准）
    pub line: Option<usize>,
    pub column: Option<usize>,
}

impl FileError {
    pub fn new(message: String) -> Self {
        Self {
            message,
            offset: None,
            line: None,
            column: None,
        }
    }

    /// 带定位构造：err_debug 为 sv-parser 错误的 Debug 串，src 为预处理后文本
    pub fn located(message: String, err_debug: &str, src: &str) -> Self {
        let mut e = Self::new(message);
        if let Some(pos) = parse_sv_error_pos(err_debug) {
            let (line, col) = byte_offset_to_line_col(src, pos);
            e.offset = Some(pos);
            e.line = Some(line);
            e.column = Some(col);
        }
        e
    }
}

/// 从 sv-parser 错误 Debug 串提取字节偏移，形如 `Parse(Some(("label", 12345)))`
fn parse_sv_error_pos(err_str: &str) -> Option<usize> {
    err_str
        .rsplit(|c: char| !c.is_ascii_digit())
        .find(|s| !s.is_empty())
        .and_then(|s| s.parse::<usize>().ok())
}

/// 字节偏移 → 1-based (行, 列)
fn byte_offset_to_line_col(src: &str, offset: usize) -> (usize, usize) {
    let offset = offset.min(src.len());
    let prefix = &src[..offset];
    let line = prefix.bytes().filter(|&b| b == b'\n').count() + 1;
    let last_newline = prefix.rfind('\n').map_or(0, |i| i + 1);
    (line, offset - last_newline + 1)
}

/// 全局设计数据库（屏障后不可变）
#[derive(Debug, Default)]
pub struct DesignDb {
    /// 模块名 → 声明（BTreeMap：XML 输出稳定有序）
    pub defs: BTreeMap<String, ModuleDecl>,
    /// 黑盒：被实例化但无定义
    pub undef: BTreeSet<String>,
    /// 顶层：有定义但未被任何模块实例化
    pub tops: Vec<String>,
    /// 文件级分析错误（解析失败/模块重复定义）；不中止整体分析
    pub errors: BTreeMap<PathBuf, Vec<FileError>>,
}

impl DesignDb {
    pub fn new(defs: BTreeMap<String, ModuleDecl>, errors: BTreeMap<PathBuf, Vec<FileError>>) -> Self {
        let mut db = Self {
            defs,
            undef: BTreeSet::new(),
            tops: Vec::new(),
            errors,
        };
        db.solve();
        db
    }

    /// solve：undef = 被引用 − 有定义；tops = 有定义 − 被引用
    fn solve(&mut self) {
        let mut referenced: BTreeSet<String> = BTreeSet::new();
        for m in self.defs.values() {
            for i in &m.instances {
                referenced.insert(i.target.clone());
            }
        }
        self.undef = referenced
            .iter()
            .filter(|n| !self.defs.contains_key(*n))
            .cloned()
            .collect();
        self.tops = self
            .defs
            .keys()
            .filter(|n| !referenced.contains(*n))
            .cloned()
            .collect();
    }
    /// 直接子模块名（去重，有序）
    pub fn submods(&self, name: &str) -> Vec<String> {
        self.defs
            .get(name)
            .map(|m| {
                m.instances
                    .iter()
                    .map(|i| i.target.clone())
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect()
            })
            .unwrap_or_default()
    }
}

// ---------------------------------------------------------------------------
// 分析驱动

use std::collections::HashMap;
use sv_parser::{Define, DefineText};

/// 保原文宏的展开哨兵前缀（svo `__MACRO__DEFINE__` 同式）：
/// `` `WIDTH `` 展开为 `__MACRO__DEFINE__WIDTH`，消费方 dump 时 strip_prefix 还原。
/// （sv-parser-pp 0.13.4 的 None 值是**删除**宏引用而非原文保留，故不能用 None。）
pub const MACRO_RAW_PREFIX: &str = "__MACRO__DEFINE__";

/// 宏的哨兵定义：`` `NAME `` 展开为 `__MACRO__DEFINE__NAME`（保原文，`ifdef` 判真）。
/// 带参宏保留形参表（`__MACRO__DEFINE__MIN(a,b)`），实参由 pp 替换落回原位，还原规则不变。
fn sentinel_define(name: &str, args: &[(String, Option<String>)]) -> Option<Define> {
    let text = if args.is_empty() {
        format!("{MACRO_RAW_PREFIX}{name}")
    } else {
        let params = args.iter().map(|(a, _)| a.as_str()).collect::<Vec<_>>().join(",");
        format!("{MACRO_RAW_PREFIX}{name}({params})")
    };
    Some(Define::new(
        name.to_string(),
        args.to_vec(),
        Some(DefineText::new(text, None)),
    ))
}

/// 构建宏定义表（K-2 修复：无 `=VALUE` 视为 `NAME=1`；SV_COV* 过滤保留）
///
/// 三通道：`defs`（-D / toml 带值）真展开；`headers`（.svh 头文件，替代 EDA「.f 头部 svh」
/// 的全局宏——逐文件并行预处理无法传递宏）与 `keep_raw` 转哨兵保原文。
/// 宏表值语义（sv-parser-pp `HashMap<String, Option<Define>>`）：
/// `Some` = 展开（哨兵也是一种展开）；`None` = 删除宏引用；未登记 = 预处理报 `DefineNotFound`。
/// 顺序：`-D` 先入种子（header 预处理可见 `ifdef 等）→ headers 按序合并（同名后者覆盖）
/// → `-D` 再压顶（显式展开优先于 header 哨兵）→ `keep_raw`（显式保原文最强）。
pub fn build_defines(
    defs: &[String],
    headers: &[PathBuf],
    keep_raw: &[String],
    incdirs: &[PathBuf],
) -> Result<HashMap<String, Option<Define>>> {
    let mut defines: HashMap<String, Option<Define>> = HashMap::new();
    // -D NAME ≡ -D NAME=1（EDA 惯例，仅 CLI）；先入种子 → header 预处理可见
    let mut parsed_defs: Vec<(String, String)> = Vec::with_capacity(defs.len());
    for d in defs {
        let (name, value) = match d.split_once('=') {
            Some((n, v)) => (n.trim(), v.trim().to_string()),
            None => (d.trim(), "1".to_string()),
        };
        parsed_defs.push((name.to_string(), value));
    }
    let insert_def = |defines: &mut HashMap<String, Option<Define>>, name: &str, value: &str| {
        defines.insert(
            name.to_string(),
            Some(Define::new(
                name.to_string(),
                Vec::new(),
                Some(DefineText::new(value.to_string(), None)),
            )),
        );
    };
    for (name, value) in &parsed_defs {
        insert_def(&mut defines, name, value);
    }
    for h in headers {
        // 头文件可再 `include 其他头文件：与源文件分析共用同一组 -I 搜索路径
        // （注意 sv_parser::preprocess 形参序为 strip_comments, ignore_include，与 preprocess_str 相反）
        let (_, hdr_defs) = sv_parser::preprocess(h, &defines, incdirs, true, false)
            .map_err(|e| anyhow::anyhow!("define header preprocess failed {}: {}", h.display(), e))?;
        for (name, def) in hdr_defs {
            if name.starts_with("SV_COV") {
                continue;
            }
            let args = def.as_ref().map(|d| d.arguments.clone()).unwrap_or_default();
            defines.insert(name.clone(), sentinel_define(&name, &args));
        }
    }
    // -D 压顶：同名 header 哨兵被显式展开值覆盖（keep_raw 仍最强，见下）
    for (name, value) in &parsed_defs {
        insert_def(&mut defines, name, value);
    }
    for name in keep_raw {
        let name = name.trim();
        defines.insert(name.to_string(), sentinel_define(name, &[]));
    }
    Ok(defines)
}

/// 分析驱动上下文：输入集 + 宏 + incdirs + 线程池/进度
pub struct Drive<'a> {
    pub files: &'a [PathBuf],
    pub defines: &'a HashMap<String, Option<Define>>,
    pub incdirs: &'a [PathBuf],
    pub pool: &'a rayon::ThreadPool,
    pub pc: &'a crate::progress::ProgressCenter,
    /// 每线程子进度条（spinner 显示当前处理文件，svo 同款渲染样式）
    pub sub_bars: bool,
}

/// parse_many 产出：成功文件声明组、失败文件错误、缓存指纹表
struct ParseOut {
    by_file: BTreeMap<PathBuf, Vec<ModuleDecl>>,
    errors: BTreeMap<PathBuf, Vec<FileError>>,
    stamps: BTreeMap<PathBuf, cache::CacheMeta>,
}

/// 并行解析 + 提取（不合并）：成功文件 → 声明组 + 缓存指纹（`include 闭包 + 内容哈希），
/// 失败文件 → 错误（含行列定位），不中止整体分析。
fn parse_many(d: &Drive, files: &[PathBuf]) -> ParseOut {
    use dashmap::DashMap;
    use rayon::prelude::*;

    let parsed: DashMap<PathBuf, Vec<ModuleDecl>> = DashMap::new();
    let stamps: DashMap<PathBuf, cache::CacheMeta> = DashMap::new();
    let errors: DashMap<PathBuf, Vec<FileError>> = DashMap::new();

    let pb = d.pc.phase("Analyzing", files.len() as u64);
    d.pool.install(|| {
        files.par_iter().for_each(|path| {
            let sub = d.sub_bars.then(|| {
                d.pc.sub_bar(
                    rayon::current_thread_index().unwrap_or(0),
                    &path.display().to_string(),
                )
            });
            let result = (|| -> std::result::Result<Vec<ModuleDecl>, FileError> {
                // specify…endspecify 先按字节等长留白（sv-parser 对时序块解析异常，
                // 移植自 ipchecker strip_specify_blocks；等长 ⇒ origin/span 不漂移）。
                // 两阶段：preprocess 展开宏/include 后，用 parse_sv_pp 直接解析
                // PreprocessedText（parse_sv_str 会二次预处理，宏文本再展开导致 locate 漂移）。
                // SyntaxTree.text 私有，提取器用同字节副本。
                let raw = std::fs::read_to_string(path)
                    .map_err(|e| FileError::new(format!("read failed: {e}")))?;
                let stripped = strip::strip_specify_blocks(&raw);
                let (pp, pp_defines) =
                    sv_parser::preprocess_str(&stripped, path, d.defines, d.incdirs, false, false, 0, 0)
                        .map_err(|e| FileError::new(format!("preprocess failed: {e}")))?;
                let src = pp.text().to_string();
                let (tree, _) = sv_parser::parse_sv_pp(pp, pp_defines, false).map_err(|e| {
                    FileError::located(format!("parse failed: {e}"), &format!("{e:?}"), &src)
                })?;
                let mut mods = extract::Extractor::new(&src).run(&tree);
                for m in &mut mods {
                    m.file = path.clone();
                }
                // 缓存指纹：`include 闭包 + 内容哈希；宏计算 include 等扫描分歧 → 不入缓存
                if let Some(meta) = cache::CacheMeta::capture(path, &raw, d.incdirs) {
                    stamps.insert(path.clone(), meta);
                }
                Ok(mods)
            })();
            match result {
                Ok(mods) => {
                    parsed.insert(path.clone(), mods);
                }
                Err(e) => {
                    errors.entry(path.clone()).or_default().push(e);
                }
            }
            if let Some(sub) = sub {
                sub.finish_and_clear();
            }
            pb.inc(1);
        });
    });
    pb.finish_and_clear();

    ParseOut {
        by_file: parsed.into_iter().collect(),
        errors: errors.into_iter().collect(),
        stamps: stamps.into_iter().collect(),
    }
}

/// 确定性合并（按文件路径字典序）：模块重定义错误归后到文件；屏障后 DesignDb 不可变。
fn assemble(
    by_file: BTreeMap<PathBuf, Vec<ModuleDecl>>,
    mut errors: BTreeMap<PathBuf, Vec<FileError>>,
) -> DesignDb {
    let mut defs = BTreeMap::new();
    for (file, mods) in by_file {
        for m in mods {
            if let Some(prev) = defs.insert(m.name.clone(), m) {
                errors.entry(file.clone()).or_default().push(FileError::new(format!(
                    "module redefined: {} (also see {})",
                    prev.name,
                    prev.file.display()
                )));
            }
        }
    }
    DesignDb::new(defs, errors)
}

/// 全量分析：解析全部输入文件并合并。
/// 返回（db, 缓存指纹表）——指纹表供 XML 导出层写缓存元数据，与是否增量无关。
pub fn analyze_files(d: &Drive) -> Result<(DesignDb, BTreeMap<PathBuf, cache::CacheMeta>)> {
    let out = parse_many(d, d.files);
    Ok((assemble(out.by_file, out.errors), out.stamps))
}

/// 增量分析（有输出目录即默认）：以 xml_dir 旧产物为缓存——全局闸门（tool/definesFp/incdirsFp）
/// 一致且每文件指纹（源码 + `include 闭包）新鲜的文件直接由缓存 XML 重建声明，只重解析
/// 失效文件；`refresh` 无视缓存强制全量。返回（db, 缓存指纹表, 缓存命中文件数）。
pub fn analyze_incremental(
    d: &Drive,
    define_pairs: &[(String, Option<String>)],
    xml_dir: &Path,
    refresh: bool,
) -> Result<(DesignDb, BTreeMap<PathBuf, cache::CacheMeta>, usize)> {
    let files = d.files;
    let mut cached: BTreeMap<PathBuf, Vec<ModuleDecl>> = BTreeMap::new();
    let mut stamps: BTreeMap<PathBuf, cache::CacheMeta> = BTreeMap::new();
    if !refresh
        && let Some(old) = cache::read_old_index(xml_dir)
        && old.tool == format!("hdxml {}", env!("CARGO_PKG_VERSION"))
        && old.defines_fp == cache::defines_fingerprint(define_pairs)
        && old.incdirs_fp == cache::incdirs_fingerprint(d.incdirs)
    {
        for f in files {
            let Some(rel) = old.manifest.get(f.to_string_lossy().as_ref()) else {
                continue;
            };
            let Some((mods, meta)) = cache::load_cached_file(&xml_dir.join(rel), f) else {
                continue;
            };
            if !meta.is_fresh(f) {
                continue;
            }
            stamps.insert(f.clone(), meta);
            cached.insert(f.clone(), mods);
        }
    }
    let fresh: Vec<PathBuf> = files
        .iter()
        .filter(|f| !cached.contains_key(*f))
        .cloned()
        .collect();
    let reused = cached.len();
    let out = parse_many(d, &fresh);
    let (mut by_file, errors, fresh_stamps) = (out.by_file, out.errors, out.stamps);
    for (f, mods) in cached {
        by_file.insert(f, mods);
    }
    stamps.extend(fresh_stamps);
    Ok((assemble(by_file, errors), stamps, reused))
}

/// 依赖树打印（termtree；黑盒标 [blackbox]）
pub fn dep_tree(db: &DesignDb) -> Vec<termtree::Tree<String>> {
    fn build(db: &DesignDb, name: &str, visited: &mut BTreeSet<String>) -> termtree::Tree<String> {
        if !visited.insert(name.to_string()) {
            return termtree::Tree::new(format!("{name} [cycle]"));
        }
        let label = if db.undef.contains(name) {
            format!("{name} [blackbox]")
        } else {
            name.to_string()
        };
        let mut tree = termtree::Tree::new(label);
        if let Some(m) = db.defs.get(name) {
            let subs: BTreeSet<String> = m.instances.iter().map(|i| i.target.clone()).collect();
            for s in subs {
                tree.push(build(db, &s, visited));
            }
        }
        visited.remove(name);
        tree
    }
    db.tops
        .iter()
        .map(|t| build(db, t, &mut BTreeSet::new()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{MACRO_RAW_PREFIX, build_defines};

    #[test]
    fn keep_raw_registers_sentinel_and_overrides() {
        let defs = build_defines(
            &["WIDTH=32".to_string(), "SYNTH".to_string()],
            &[],
            &["WIDTH".to_string(), "DEPTH".to_string()],
            &[],
        )
        .unwrap();
        let w = defs.get("WIDTH").unwrap().as_ref().unwrap();
        assert_eq!(
            w.text.as_ref().unwrap().text,
            format!("{MACRO_RAW_PREFIX}WIDTH"),
            "keep_raw must override the -D expanded value"
        );
        assert!(defs.get("DEPTH").unwrap().is_some());
        assert_eq!(
            defs.get("SYNTH").unwrap().as_ref().unwrap().text.as_ref().unwrap().text,
            "1",
            "bare -D NAME still expands to 1 per EDA convention"
        );
    }

    #[test]
    fn keep_raw_expands_sentinel_and_ifdef_true() {
        let defs = build_defines(&[], &[], &["WIDTH".to_string()], &[]).unwrap();
        let src = "module m(output logic [`WIDTH-1:0] o);\n`ifdef WIDTH\n  localparam int K = 1;\n`endif\nendmodule\n";
        let (pp, _) = sv_parser::preprocess_str(
            src,
            "<test>",
            &defs,
            &[] as &[&std::path::Path],
            false,
            false,
            0,
            0,
        )
        .unwrap();
        let text = pp.text();
        assert!(
            text.contains(&format!("{MACRO_RAW_PREFIX}WIDTH")),
            "raw macro must expand to the sentinel placeholder: {text}"
        );
        assert!(
            text.contains("localparam int K"),
            "`ifdef on a keep_raw macro must stay true: {text}"
        );
    }

    /// 端到端：keep_raw 零参宏带实参使用时，pp 将实参表原样接回哨兵后
    #[test]
    fn keep_raw_fn_usage_keeps_actual_args() {
        let defs = build_defines(&[], &[], &["H_MIN".to_string()], &[]).unwrap();
        let src = "module m;\n  localparam int K = `H_MIN(3, 5);\nendmodule\n";
        let (pp, _) = sv_parser::preprocess_str(
            src,
            "<test>",
            &defs,
            &[] as &[&std::path::Path],
            false,
            false,
            0,
            0,
        )
        .unwrap();
        assert!(
            pp.text().contains(&format!("{MACRO_RAW_PREFIX}H_MIN(3, 5)")),
            "actual args must be appended verbatim: {}",
            pp.text()
        );
    }

    /// 默认保原文：headers 宏转哨兵（带参宏保留形参）；-D 显式展开优先；keep_raw 最强
    #[test]
    fn headers_default_raw_and_override_order() {
        let dir = std::env::temp_dir().join(format!("hdxml_test_hdr_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let hdr = dir.join("defs.svh");
        std::fs::write(&hdr, "`define H_WIDTH 32\n`define H_MIN(a,b) ((a)<(b)?(a):(b))\n").unwrap();

        let defs = build_defines(&[], std::slice::from_ref(&hdr), &[], &[]).unwrap();
        let w = defs.get("H_WIDTH").unwrap().as_ref().unwrap();
        assert_eq!(
            w.text.as_ref().unwrap().text,
            format!("{MACRO_RAW_PREFIX}H_WIDTH"),
            "header macros must default to sentinel"
        );
        let m = defs.get("H_MIN").unwrap().as_ref().unwrap();
        assert_eq!(
            m.text.as_ref().unwrap().text,
            format!("{MACRO_RAW_PREFIX}H_MIN(a,b)"),
            "sentinel of a parameterized macro must keep the formal list"
        );
        assert_eq!(m.arguments.len(), 2, "formals must be kept (pp actual substitution relies on them)");

        // -D 显式给值 → 覆盖 header 哨兵，真展开
        let defs =
            build_defines(&["H_WIDTH=64".to_string()], std::slice::from_ref(&hdr), &[], &[])
                .unwrap();
        assert_eq!(
            defs.get("H_WIDTH").unwrap().as_ref().unwrap().text.as_ref().unwrap().text,
            "64"
        );
        // keep_raw → 覆盖 -D，回到哨兵
        let defs = build_defines(
            &["H_WIDTH=64".to_string()],
            std::slice::from_ref(&hdr),
            &["H_WIDTH".to_string()],
            &[],
        )
        .unwrap();
        assert_eq!(
            defs.get("H_WIDTH").unwrap().as_ref().unwrap().text.as_ref().unwrap().text,
            format!("{MACRO_RAW_PREFIX}H_WIDTH")
        );
    }

    /// 头文件可再 `include 其他头文件：经 -I 搜索路径解析（与源文件分析共用）
    #[test]
    fn header_include_resolved_via_incdirs() {
        let dir = std::env::temp_dir().join(format!("hdxml_test_inc_{}", std::process::id()));
        let inc = dir.join("include");
        std::fs::create_dir_all(&inc).unwrap();
        std::fs::write(inc.join("base.svh"), "`define BASE_W 8\n").unwrap();
        let hdr = dir.join("defs.svh");
        std::fs::write(&hdr, "`include \"base.svh\"\n`define TOP_W 16\n").unwrap();

        // 无 -I：被 include 的文件找不到 → 预处理报错（ignore_include=false）
        assert!(build_defines(&[], std::slice::from_ref(&hdr), &[], &[]).is_err());
        // 有 -I：两个头文件的宏都登记（默认哨兵）
        let defs = build_defines(&[], std::slice::from_ref(&hdr), &[], &[inc]).unwrap();
        assert!(defs.contains_key("BASE_W"), "macros from `include must be registered");
        assert!(defs.contains_key("TOP_W"));
    }

    /// -D seeds first: `ifdef inside a header sees -D macros (EDA .f-head behavior)
    #[test]
    fn define_seed_visible_in_header_ifdef() {
        let dir = std::env::temp_dir().join(format!("hdxml_test_seed_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let hdr = dir.join("defs.svh");
        std::fs::write(&hdr, "`ifdef SEED\n`define GATED 1\n`endif\n").unwrap();

        // Without the seed the `ifdef branch must not fire
        let defs = build_defines(&[], std::slice::from_ref(&hdr), &[], &[]).unwrap();
        assert!(!defs.contains_key("GATED"), "without seed, `ifdef branch must not fire");
        // With -D SEED=1 the gated macro is registered (sentinel by default)
        let defs =
            build_defines(&["SEED=1".to_string()], std::slice::from_ref(&hdr), &[], &[]).unwrap();
        assert!(defs.contains_key("GATED"), "-D seed must be visible to header `ifdef");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
