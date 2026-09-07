//! DesignDb — 模块信息数据底座（docs/hdxml/module-info.md）。
//! 纯净分析层：无条件全量收集 params/ports/instances/层级，零功能标志位。

pub mod extract;
pub mod strip;
pub mod xml;

use anyhow::Result;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

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
}

#[derive(Debug, Clone)]
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
}

#[derive(Debug, Clone)]
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
#[derive(Debug, Clone)]
pub struct ParamConn {
    /// 命名覆盖的参数名；位置连接为 None
    pub name: Option<String>,
    /// 覆盖表达式原文（如 `1`、`W`）
    pub value: String,
}

#[derive(Debug, Clone)]
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
}

#[derive(Debug, Clone)]
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
#[derive(Debug, Clone)]
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
use std::path::Path;
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

/// 构建宏定义表（K-2 修复：无 `=VALUE` 视为 `NAME=1`）
///
/// 两通道：`defs`（-D / toml `[analysis.defines]` 带值）真展开；`keep_raw` 转哨兵保原文。
/// 宏表值语义（sv-parser-pp `HashMap<String, Option<Define>>`）：
/// `Some` = 展开（哨兵也是一种展开）；`None` = 删除宏引用；未登记 = 预处理报 `DefineNotFound`。
/// 覆盖顺序：`defs` → `keep_raw`（显式保原文最强）。
pub fn build_defines(
    defs: &[String],
    keep_raw: &[String],
) -> Result<HashMap<String, Option<Define>>> {
    let mut defines: HashMap<String, Option<Define>> = HashMap::new();
    for d in defs {
        let (name, value) = match d.split_once('=') {
            Some((n, v)) => (n.trim(), v.trim().to_string()),
            None => (d.trim(), "1".to_string()), // -D NAME ≡ -D NAME=1（EDA 惯例，仅 CLI）
        };
        defines.insert(
            name.to_string(),
            Some(Define::new(
                name.to_string(),
                Vec::new(),
                Some(DefineText::new(value, None)),
            )),
        );
    }
    for name in keep_raw {
        let name = name.trim();
        defines.insert(name.to_string(), sentinel_define(name, &[]));
    }
    Ok(defines)
}

/// 并行解析 + 提取（barrier 后 DesignDb 不可变）。
/// 单文件失败不中止：错误（含行列定位）收入 `DesignDb.errors`，由导出层写入对应 XML。
/// `sub_bars`：每线程子进度条（spinner 显示当前处理文件，svo 同款渲染样式）。
pub fn analyze_files(
    files: &[PathBuf],
    defines: &HashMap<String, Option<Define>>,
    incdirs: &[PathBuf],
    pool: &rayon::ThreadPool,
    pc: &crate::progress::ProgressCenter,
    sub_bars: bool,
) -> Result<DesignDb> {
    use dashmap::DashMap;
    use rayon::prelude::*;

    let collected: DashMap<String, ModuleDecl> = DashMap::new();
    let errors: DashMap<PathBuf, Vec<FileError>> = DashMap::new();

    let pb = pc.phase("Analyzing", files.len() as u64);
    pool.install(|| {
        files.par_iter().for_each(|path| {
            let sub = sub_bars.then(|| {
                pc.sub_bar(
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
                    .map_err(|e| FileError::new(format!("读取失败: {e}")))?;
                let stripped = strip::strip_specify_blocks(&raw);
                let (pp, pp_defines) =
                    sv_parser::preprocess_str(&stripped, path, defines, incdirs, false, false, 0, 0)
                        .map_err(|e| FileError::new(format!("预处理失败: {e}")))?;
                let src = pp.text().to_string();
                let (tree, _) = sv_parser::parse_sv_pp(pp, pp_defines, false).map_err(|e| {
                    FileError::located(format!("解析失败: {e}"), &format!("{e:?}"), &src)
                })?;
                let mut mods = extract::Extractor::new(&src).run(&tree);
                for m in &mut mods {
                    m.file = path.clone();
                }
                Ok(mods)
            })();
            match result {
                Ok(mods) => {
                    for m in mods {
                        if let Some(prev) = collected.insert(m.name.clone(), m) {
                            errors.entry(path.clone()).or_default().push(FileError::new(
                                format!(
                                    "模块重复定义: {}（另见 {}）",
                                    prev.name,
                                    prev.file.display()
                                ),
                            ));
                        }
                    }
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

    Ok(DesignDb::new(
        collected.into_iter().collect(),
        errors.into_iter().collect(),
    ))
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
            &["WIDTH".to_string(), "DEPTH".to_string()],
        )
        .unwrap();
        let w = defs.get("WIDTH").unwrap().as_ref().unwrap();
        assert_eq!(
            w.text.as_ref().unwrap().text,
            format!("{MACRO_RAW_PREFIX}WIDTH"),
            "keep_raw 必须覆盖 -D 展开值"
        );
        assert!(defs.get("DEPTH").unwrap().is_some());
        assert_eq!(
            defs.get("SYNTH").unwrap().as_ref().unwrap().text.as_ref().unwrap().text,
            "1",
            "裸名 -D 仍按 EDA 惯例展开为 1"
        );
    }

    #[test]
    fn keep_raw_expands_sentinel_and_ifdef_true() {
        let defs = build_defines(&[], &["WIDTH".to_string()]).unwrap();
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
            "raw 宏必须展开为哨兵占位符: {text}"
        );
        assert!(
            text.contains("localparam int K"),
            "`ifdef 对 keep_raw 宏必须判真: {text}"
        );
    }

    /// 端到端：keep_raw 零参宏带实参使用时，pp 将实参表原样接回哨兵后
    #[test]
    fn keep_raw_fn_usage_keeps_actual_args() {
        let defs = build_defines(&[], &["H_MIN".to_string()]).unwrap();
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
            "实参表必须原样接回: {}",
            pp.text()
        );
    }
}
