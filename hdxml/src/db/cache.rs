//! 增量缓存（有输出目录即默认）：以输出目录旧产物为缓存基，不新增产物类型。
//!
//! 失效判定（docs/hdxml/module-info.md §5）：
//! - 全局闸门：旧 index.xml 的 tool / definesFp / incdirsFp 任一不一致 → 整库重解析；
//! - 每文件：源码与 `include 闭包全部成员的 mtime+size 快路径，漂移则 blake3 内容哈希仲裁
//!   （touch / git checkout 只动 mtime 仍命中）；
//! - 不可缓存：含解析/合并错误（XML 带 <error>）或宏计算 include（`include `FOO）的文件
//!   不写缓存元数据，每次运行都重解析。
//!
//! 缓存格式即每文件 XML 的 srcHash/srcSize 属性与 <includes> 子节（契约向后兼容新增），
//! 读取侧只认自产格式的行扫描（与 read_old_manifest 同式），不引入 XML 解析依赖。

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use super::{
    ExprText, InstanceInfo, ModKind, ModuleDecl, ParamConn, ParamInfo, ParamKind, PortDir,
    PortInfo, short_hash,
};

/// 缓存载荷格式（`--format`）：决定增量缓存读写 `index.xml`/`*.xml` 还是 `index.json`/`*.json`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Payload {
    Xml,
    Json,
}

/// manifest GC：删除 manifest 中不在 planned 的产物并逐级修剪空目录（两种格式共用，
/// 也用于跨格式切换时清空另一格式的全部产物——planned 传空集）
pub(crate) fn gc_stale(out_dir: &Path, manifest: Vec<String>, planned: &BTreeSet<&str>) {
    for stale in manifest {
        if planned.contains(stale.as_str()) {
            continue;
        }
        let p = out_dir.join(&stale);
        if std::fs::remove_file(&p).is_ok() {
            let mut dir = p.parent();
            while let Some(d) = dir {
                if d == out_dir || std::fs::remove_dir(d).is_err() {
                    break;
                }
                dir = d.parent();
            }
        }
    }
}

/// 文件指纹：mtime+size 快路径 + blake3 内容哈希仲裁
#[derive(Debug, Clone, PartialEq)]
pub struct FileStamp {
    pub mtime: u64,
    pub size: u64,
    pub hash: String,
}

impl FileStamp {
    /// 读取文件内容并捕获指纹（源文件分析路径已持有内容时走 from_content）
    pub fn capture(path: &Path) -> Option<Self> {
        let content = std::fs::read(path).ok()?;
        Self::from_content(path, &content)
    }

    pub fn from_content(path: &Path, content: &[u8]) -> Option<Self> {
        let meta = std::fs::metadata(path).ok()?;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_secs());
        Some(Self {
            mtime,
            size: meta.len(),
            hash: short_hash(content),
        })
    }

    /// 两级校验：stat 快路径；mtime/size 漂移再读内容哈希
    pub fn is_fresh(&self, path: &Path) -> bool {
        let Ok(meta) = std::fs::metadata(path) else {
            return false;
        };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_secs());
        if mtime == self.mtime && meta.len() == self.size {
            return true;
        }
        std::fs::read(path).is_ok_and(|b| short_hash(&b) == self.hash)
    }
}

/// `include 闭包成员：解析后路径 + 指纹
#[derive(Debug, Clone, PartialEq)]
pub struct IncludeStamp {
    pub path: PathBuf,
    pub stamp: FileStamp,
}

/// 每文件缓存元数据：源码指纹 + include 闭包（路径字典序）
#[derive(Debug, Clone, PartialEq)]
pub struct CacheMeta {
    pub source: FileStamp,
    pub includes: Vec<IncludeStamp>,
}

impl CacheMeta {
    /// 分析成功后捕获；None = 不可缓存（include 扫描分歧 / 成员不可读）
    pub fn capture(path: &Path, raw: &str, incdirs: &[PathBuf]) -> Option<Self> {
        let source = FileStamp::from_content(path, raw.as_bytes())?;
        let closure = scan_include_closure(raw, incdirs)?;
        let mut includes = Vec::with_capacity(closure.len());
        for p in closure {
            includes.push(IncludeStamp {
                stamp: FileStamp::capture(&p)?,
                path: p,
            });
        }
        Some(Self { source, includes })
    }

    /// 源码与 include 闭包全体成员新鲜才命中
    pub fn is_fresh(&self, source: &Path) -> bool {
        self.source.is_fresh(source)
            && self.includes.iter().all(|i| i.stamp.is_fresh(&i.path))
    }
}

/// 宏指纹：排序后逐行哈希（展开宏 "name=value"；raw 宏 "name" 无等号）。
/// 增量闸门与 index.xml 的 definesFp 属性共用此函数。
pub fn defines_fingerprint(defines: &[(String, Option<String>)]) -> String {
    short_hash(
        defines
            .iter()
            .map(|(n, v)| match v {
                Some(v) => format!("{n}={v}"),
                None => n.clone(),
            })
            .collect::<Vec<_>>()
            .join("\n")
            .as_bytes(),
    )
}

/// incdirs 指纹（顺序敏感：include 解析按序取首个存在者）
pub fn incdirs_fingerprint(incdirs: &[PathBuf]) -> String {
    short_hash(
        incdirs
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join("\n")
            .as_bytes(),
    )
}

/// 旧 index.xml 的全局闸门与产物清单（行扫描自产格式）
pub struct OldIndex {
    pub tool: String,
    pub defines_fp: String,
    pub incdirs_fp: String,
    /// source（XML 原始字符串）→ 索引 XML 相对路径
    pub manifest: BTreeMap<String, String>,
}

/// 旧 index 的全局闸门与产物清单；按载荷格式分发（XML 行扫描 / JSON serde_json 解析）
pub fn read_old_index(out_dir: &Path, payload: Payload) -> Option<OldIndex> {
    match payload {
        Payload::Xml => read_old_index_xml(out_dir),
        Payload::Json => read_old_index_json(out_dir),
    }
}

/// 旧 index.xml 的全局闸门与产物清单（行扫描自产格式）
pub fn read_old_index_xml(out_dir: &Path) -> Option<OldIndex> {
    let body = std::fs::read_to_string(out_dir.join("index.xml")).ok()?;
    let mut tool = None;
    let mut defines_fp = None;
    let mut incdirs_fp = None;
    let mut manifest = BTreeMap::new();
    for line in body.lines() {
        let line = line.trim_start();
        if line.starts_with("<rtlIndex ") {
            tool = attr(line, "tool");
            defines_fp = attr(line, "definesFp");
            incdirs_fp = attr(line, "incdirsFp");
        } else if line.starts_with("<file ")
            && let (Some(src), Some(idx)) = (attr(line, "source"), attr(line, "index"))
        {
            manifest.insert(src, idx);
        }
    }
    Some(OldIndex {
        tool: tool?,
        defines_fp: defines_fp?,
        incdirs_fp: incdirs_fp?,
        manifest,
    })
}

/// 旧 index.json 的全局闸门与产物清单（serde_json 解析；字段同 XML 闸门）
pub fn read_old_index_json(out_dir: &Path) -> Option<OldIndex> {
    let body = std::fs::read_to_string(out_dir.join("index.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&body).ok()?;
    let mut manifest = BTreeMap::new();
    for f in v.get("files")?.as_array()? {
        let src = f.get("source")?.as_str()?;
        let idx = f.get("index")?.as_str()?;
        manifest.insert(src.to_string(), idx.to_string());
    }
    Some(OldIndex {
        tool: v.get("tool")?.as_str()?.to_string(),
        defines_fp: v.get("definesFp")?.as_str()?.to_string(),
        incdirs_fp: v.get("incdirsFp")?.as_str()?.to_string(),
        manifest,
    })
}

// ---------------------------------------------------------------------------
// `include 闭包扫描（词法级，镜像 sv-parser-pp 0.13.4 解析规则）

/// 扫描源文本的 `include 闭包（排序去重）。
/// None = 不可缓存：宏计算 include（`include `FOO）、指令畸形、成员不可读或嵌套过深。
/// 解析规则镜像 sv-parser-pp：文件名按原写法（CWD 相对）优先，相对且不存在时
/// 按 incdirs 顺序取首个存在者；嵌套递归，深度封顶 64。
pub fn scan_include_closure(src: &str, incdirs: &[PathBuf]) -> Option<Vec<PathBuf>> {
    let mut visited = BTreeSet::new();
    scan_into(src, incdirs, 0, &mut visited)?;
    Some(visited.into_iter().collect())
}

fn scan_into(
    src: &str,
    incdirs: &[PathBuf],
    depth: usize,
    visited: &mut BTreeSet<PathBuf>,
) -> Option<()> {
    if depth >= 64 {
        return None;
    }
    for name in find_includes(src)? {
        let path = resolve_include(&name, incdirs)?;
        if visited.insert(path.clone()) {
            let content = std::fs::read_to_string(&path).ok()?;
            scan_into(&content, incdirs, depth + 1, visited)?;
        }
    }
    Some(())
}

/// 提取 `` `include `` 指令的文件名（剥离 // 与 /* */ 注释、字符串字面量）。
/// None = 含宏计算 include 或畸形指令 —— 调用方判不可缓存（保守重解析）。
fn find_includes(src: &str) -> Option<Vec<String>> {
    let b = src.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'/' if b.get(i + 1) == Some(&b'/') => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                    i += 1;
                }
                i = (i + 2).min(b.len());
            }
            b'"' => {
                i += 1;
                while i < b.len() && b[i] != b'"' {
                    if b[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
                i += 1;
            }
            b'`' => {
                i += 1;
                let start = i;
                while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
                    i += 1;
                }
                if &src[start..i] == "include" {
                    while i < b.len() && b[i].is_ascii_whitespace() {
                        i += 1;
                    }
                    match b.get(i) {
                        Some(b'"') => {
                            i += 1;
                            let s = i;
                            while i < b.len() && b[i] != b'"' {
                                i += 1;
                            }
                            out.push(src[s..i].to_string());
                            i += 1;
                        }
                        Some(b'<') => {
                            i += 1;
                            let s = i;
                            while i < b.len() && b[i] != b'>' {
                                i += 1;
                            }
                            out.push(src[s..i].to_string());
                            i += 1;
                        }
                        _ => return None,
                    }
                }
            }
            _ => i += 1,
        }
    }
    Some(out)
}

/// 镜像 sv-parser-pp：绝对路径或按原写法存在 → 直接使用；否则按 incdirs 顺序取首个存在者
fn resolve_include(name: &str, incdirs: &[PathBuf]) -> Option<PathBuf> {
    let path = PathBuf::from(name);
    if !path.is_relative() || path.exists() {
        return Some(path);
    }
    incdirs.iter().map(|d| d.join(&path)).find(|c| c.exists())
}

// ---------------------------------------------------------------------------
// 缓存读取：XML 行扫描（自产格式每元素一行）/ JSON serde_json 解析

/// 从每文件产物重建模块声明与缓存元数据；按载荷格式分发。
/// None = 不可作为缓存：缺 srcHash/srcSize、含错误条目（解析/合并错误文件每次重解析）、
/// 或格式漂移；调用方将其归入重解析集合。模块 file 字段取当前输入路径 `source`。
pub fn load_cached_file(
    path: &Path,
    source: &Path,
    payload: Payload,
) -> Option<(Vec<ModuleDecl>, CacheMeta)> {
    match payload {
        Payload::Xml => load_cached_file_xml(path, source),
        Payload::Json => load_cached_file_json(path, source),
    }
}

/// XML 载荷重建（自产格式行扫描）。
pub fn load_cached_file_xml(xml_path: &Path, source: &Path) -> Option<(Vec<ModuleDecl>, CacheMeta)> {
    let body = std::fs::read_to_string(xml_path).ok()?;
    let mut mods: Vec<ModuleDecl> = Vec::new();
    let mut stack: Vec<String> = Vec::new();
    let mut src_stamp: Option<FileStamp> = None;
    let mut includes: Vec<IncludeStamp> = Vec::new();

    for raw in body.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with("<?") {
            continue;
        }
        if line.starts_with("</") {
            stack.pop();
            continue;
        }
        if !line.starts_with('<') {
            return None;
        }
        let selfclose = line.ends_with("/>");
        let tag_end = line[1..]
            .find(|c: char| c.is_ascii_whitespace() || c == '>' || c == '/')
            .map(|p| p + 1)?;
        let tag = &line[1..tag_end];
        let attrs = parse_attrs(&line[tag_end..]);
        match tag {
            "fileIndex" => {
                src_stamp = Some(FileStamp {
                    mtime: attrs.get("mtime")?.parse().ok()?,
                    size: attrs.get("srcSize")?.parse().ok()?,
                    hash: attrs.get("srcHash")?.clone(),
                });
            }
            "include" => {
                includes.push(IncludeStamp {
                    path: PathBuf::from(attrs.get("path")?),
                    stamp: FileStamp {
                        mtime: attrs.get("mtime")?.parse().ok()?,
                        size: attrs.get("size")?.parse().ok()?,
                        hash: attrs.get("hash")?.clone(),
                    },
                });
            }
            "module" => {
                mods.push(ModuleDecl {
                    name: attrs.get("name")?.clone(),
                    kind: ModKind::parse(attrs.get("kind")?)?,
                    file: source.to_path_buf(),
                    span: parse_span(attrs.get("span")?)?,
                    params: Vec::new(),
                    ports: Vec::new(),
                    instances: Vec::new(),
                    imports: Vec::new(),
                    content_hash: attrs.get("contentHash")?.clone(),
                    // package 无 interfaceSig（契约 §5.2）
                    norm_hash: attrs.get("normHash")?.clone(),
                    interface_sig: attrs.get("interfaceSig").cloned().unwrap_or_default(),
                });
            }
            "import" if stack.last().is_some_and(|t| t == "imports") => {
                mods.last_mut()?.imports.push(super::ImportInfo {
                    package: attrs.get("package")?.clone(),
                    symbol: attrs.get("symbol")?.clone(),
                    via: super::ImportVia::parse(attrs.get("via")?)?,
                    span: parse_span(attrs.get("span")?)?,
                });
            }
            "param" => match stack.last().map(String::as_str) {
                Some("params") => mods.last_mut()?.params.push(ParamInfo {
                    name: attrs.get("name")?.clone(),
                    kind: ParamKind::parse(attrs.get("kind")?)?,
                    data_type: attrs.get("dataType").cloned(),
                    default: attrs.get("default").map(|d| ExprText::new(d)),
                    span: parse_span(attrs.get("span")?)?,
                }),
                Some("instance") => mods
                    .last_mut()?
                    .instances
                    .last_mut()?
                    .params
                    .push(ParamConn {
                        name: attrs.get("name").cloned(),
                        value: attrs.get("value")?.clone(),
                    }),
                _ => return None,
            },
            "input" | "output" | "inout" | "ref" | "interface" | "port"
                if stack.last().is_some_and(|t| t == "ports") =>
            {
                mods.last_mut()?.ports.push(PortInfo {
                    name: attrs.get("name")?.clone(),
                    dir: if tag == "port" {
                        None
                    } else {
                        Some(PortDir::parse(tag)?)
                    },
                    data_type: attrs.get("dataType").cloned(),
                    interface: attrs.get("interface").cloned(),
                    modport: attrs.get("modport").cloned(),
                    packed: parse_dims(attrs.get("packed").map_or("", String::as_str))?,
                    unpacked: parse_dims(attrs.get("unpacked").map_or("", String::as_str))?,
                    default: attrs.get("default").map(|d| ExprText::new(d)),
                    span: parse_span(attrs.get("span")?)?,
                });
            }
            "instance" => mods.last_mut()?.instances.push(InstanceInfo {
                inst: attrs.get("name")?.clone(),
                target: attrs.get("target")?.clone(),
                params: Vec::new(),
                span: parse_span(attrs.get("span")?)?,
            }),
            "error" => return None, // 错误文件不入缓存：每次运行重解析
            _ => {}
        }
        if !selfclose {
            stack.push(tag.to_string());
        }
    }
    let source_stamp = src_stamp?;
    Some((
        mods,
        CacheMeta {
            source: source_stamp,
            includes,
        },
    ))
}

/// JSON 载荷重建（serde_json 解析；字段语义与 XML 载荷一一对应，重建结果相同）。
pub fn load_cached_file_json(json_path: &Path, source: &Path) -> Option<(Vec<ModuleDecl>, CacheMeta)> {
    let body = std::fs::read_to_string(json_path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&body).ok()?;
    // 错误文件不入缓存：每次运行重解析（errors 键存在即判不可缓存）
    if v.get("errors").is_some() {
        return None;
    }
    fn jstr<'a>(o: &'a serde_json::Value, k: &str) -> Option<&'a str> {
        o.get(k)?.as_str()
    }
    fn jnum(o: &serde_json::Value, k: &str) -> Option<u64> {
        o.get(k)?.as_u64()
    }
    let src_stamp = FileStamp {
        mtime: jnum(&v, "mtime")?,
        size: jnum(&v, "srcSize")?,
        hash: jstr(&v, "srcHash")?.to_string(),
    };
    let mut includes: Vec<IncludeStamp> = Vec::new();
    if let Some(arr) = v.get("includes") {
        for inc in arr.as_array()? {
            includes.push(IncludeStamp {
                path: PathBuf::from(jstr(inc, "path")?),
                stamp: FileStamp {
                    mtime: jnum(inc, "mtime")?,
                    size: jnum(inc, "size")?,
                    hash: jstr(inc, "hash")?.to_string(),
                },
            });
        }
    }
    let mut mods: Vec<ModuleDecl> = Vec::new();
    if let Some(arr) = v.get("modules") {
        for m in arr.as_array()? {
            let mut decl = ModuleDecl {
                name: jstr(m, "name")?.to_string(),
                kind: ModKind::parse(jstr(m, "kind")?)?,
                file: source.to_path_buf(),
                span: parse_span(jstr(m, "span")?)?,
                params: Vec::new(),
                ports: Vec::new(),
                instances: Vec::new(),
                imports: Vec::new(),
                content_hash: jstr(m, "contentHash")?.to_string(),
                norm_hash: jstr(m, "normHash")?.to_string(),
                // package 无 interfaceSig（契约 §5.2）
                interface_sig: jstr(m, "interfaceSig").unwrap_or_default().to_string(),
            };
            if let Some(arr) = m.get("imports") {
                for i in arr.as_array()? {
                    decl.imports.push(super::ImportInfo {
                        package: jstr(i, "package")?.to_string(),
                        symbol: jstr(i, "symbol")?.to_string(),
                        via: super::ImportVia::parse(jstr(i, "via")?)?,
                        span: parse_span(jstr(i, "span")?)?,
                    });
                }
            }
            if let Some(arr) = m.get("params") {
                for p in arr.as_array()? {
                    decl.params.push(ParamInfo {
                        name: jstr(p, "name")?.to_string(),
                        kind: ParamKind::parse(jstr(p, "kind")?)?,
                        data_type: jstr(p, "dataType").map(str::to_string),
                        default: jstr(p, "default").map(ExprText::new),
                        span: parse_span(jstr(p, "span")?)?,
                    });
                }
            }
            if let Some(arr) = m.get("ports") {
                for p in arr.as_array()? {
                    let dir = jstr(p, "dir")?;
                    decl.ports.push(PortInfo {
                        name: jstr(p, "name")?.to_string(),
                        dir: if dir == "port" { None } else { Some(PortDir::parse(dir)?) },
                        data_type: jstr(p, "dataType").map(str::to_string),
                        interface: jstr(p, "interface").map(str::to_string),
                        modport: jstr(p, "modport").map(str::to_string),
                        packed: parse_dims(jstr(p, "packed").unwrap_or(""))?,
                        unpacked: parse_dims(jstr(p, "unpacked").unwrap_or(""))?,
                        default: jstr(p, "default").map(ExprText::new),
                        span: parse_span(jstr(p, "span")?)?,
                    });
                }
            }
            if let Some(arr) = m.get("instances") {
                for i in arr.as_array()? {
                    let mut inst = InstanceInfo {
                        inst: jstr(i, "name")?.to_string(),
                        target: jstr(i, "target")?.to_string(),
                        params: Vec::new(),
                        span: parse_span(jstr(i, "span")?)?,
                    };
                    if let Some(ps) = i.get("params") {
                        for c in ps.as_array()? {
                            inst.params.push(ParamConn {
                                name: jstr(c, "name").map(str::to_string),
                                value: jstr(c, "value")?.to_string(),
                            });
                        }
                    }
                    decl.instances.push(inst);
                }
            }
            mods.push(decl);
        }
    }
    Some((
        mods,
        CacheMeta {
            source: src_stamp,
            includes,
        },
    ))
}

/// 自产格式属性表：`<tag k="v" …>` 的 tag 后片段；值内 `"` 已由写出侧转义
fn parse_attrs(mut s: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    s = s.trim_end_matches(['>', '/']);
    while let Some(eq) = s.find("=\"") {
        let key = s[..eq].trim();
        let rest = &s[eq + 2..];
        let Some(end) = rest.find('"') else { break };
        out.insert(key.to_string(), unesc(&rest[..end]));
        s = &rest[end + 1..];
    }
    out
}

/// 单属性提取（index.xml 行扫描用）
fn attr(line: &str, key: &str) -> Option<String> {
    let rest = line.split_once(&format!("{key}=\""))?.1;
    let (val, _) = rest.split_once('"')?;
    Some(unesc(val))
}

/// 属性值反转义（esc 的逆：字符引用先还原，&amp; 最后）
fn unesc(s: &str) -> String {
    s.replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&#10;", "\n")
        .replace("&#13;", "\r")
        .replace("&amp;", "&")
}
fn parse_span(s: &str) -> Option<[usize; 2]> {
    let (a, b) = s.split_once(':')?;
    Some([a.parse().ok()?, b.parse().ok()?])
}

/// 维度文本还原：`[a][b]` → [a, b]；深度计数以容忍表达式内嵌套方括号（如 [foo[3]:0]）
fn parse_dims(s: &str) -> Option<Vec<ExprText>> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'[' {
            return None;
        }
        let start = i + 1;
        let mut depth = 1;
        i += 1;
        while i < b.len() && depth > 0 {
            match b[i] {
                b'[' => depth += 1,
                b']' => depth -= 1,
                _ => {}
            }
            if depth > 0 {
                i += 1;
            }
        }
        if depth != 0 {
            return None;
        }
        out.push(ExprText::new(&s[start..i]));
        i += 1;
    }
    Some(out)
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::xml::XmlExport;
    use crate::db::{self};
    use crate::progress::ProgressCenter;

    fn tmpdir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("hdxml_cache_test_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // --- 词法扫描 ---------------------------------------------------------

    #[test]
    fn find_includes_quoted_angle_and_masking() {
        let src = r#"
`include "a.svh"
`include <b.svh>
// `include "commented.svh"
/* `include "blocked.svh" */
string s = "`include not_real";
  `include   " spaced.svh"
"#;
        let got = find_includes(src).unwrap();
        assert_eq!(got, vec!["a.svh", "b.svh", " spaced.svh"]);
    }

    #[test]
    fn find_includes_macro_include_not_cacheable() {
        assert!(find_includes("`include `CFG_HDR").is_none());
    }

    #[test]
    fn parse_dims_nested_brackets() {
        let d = parse_dims("[W-1:0][2]").unwrap();
        assert_eq!(d, vec![ExprText::new("W-1:0"), ExprText::new("2")]);
        let d = parse_dims("[foo[3]:0]").unwrap();
        assert_eq!(d, vec![ExprText::new("foo[3]:0")]);
        assert!(parse_dims("[a").is_none());
        assert!(parse_dims("a]").is_none());
    }

    #[test]
    fn attrs_roundtrip_escaping() {
        let attrs = parse_attrs(r#" name="a&quot;b&amp;c" value="x&lt;y" "#);
        assert_eq!(attrs["name"], "a\"b&c");
        assert_eq!(attrs["value"], "x<y");
    }

    // --- 指纹与闭包 -------------------------------------------------------

    #[test]
    fn stamp_freshness_two_tiers() {
        let dir = tmpdir("stamp");
        let f = dir.join("a.sv");
        std::fs::write(&f, "module a; endmodule\n").unwrap();
        let s = FileStamp::capture(&f).unwrap();
        assert!(s.is_fresh(&f));
        // 内容变化 → 失效
        std::fs::write(&f, "module a2; endmodule\n").unwrap();
        assert!(!s.is_fresh(&f));
        // 文件消失 → 失效
        std::fs::remove_file(&f).unwrap();
        assert!(!s.is_fresh(&f));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn include_closure_nested_via_incdirs() {
        let dir = tmpdir("closure");
        let inc = dir.join("include");
        std::fs::create_dir_all(&inc).unwrap();
        std::fs::write(inc.join("base.svh"), "`define BASE_W 8\n").unwrap();
        std::fs::write(inc.join("mid.svh"), "`include \"base.svh\"\n`define MID 1\n").unwrap();
        let closure = scan_include_closure("`include \"mid.svh\"\n", &[inc]).unwrap();
        assert_eq!(closure.len(), 2, "nested include must be in closure: {closure:?}");
        assert!(closure[0].ends_with("base.svh"));
        assert!(closure[1].ends_with("mid.svh"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // --- 端到端：增量与全量输出一致 ----------------------------------------

    /// 小工程：top.sv（include defs.svh + 例化 sub）、sub.sv、bad.sv（语法错误）
    struct Fixture {
        dir: PathBuf,
        files: Vec<PathBuf>,
        incdirs: Vec<PathBuf>,
        svh: PathBuf,
        sub: PathBuf,
    }

    fn fixture(name: &str) -> Fixture {
        let dir = tmpdir(name);
        let svh = dir.join("defs.svh");
        std::fs::write(&svh, "`define W 8\n").unwrap();
        let top = dir.join("top.sv");
        std::fs::write(
            &top,
            "`include \"defs.svh\"\nmodule top #(parameter int W = `W) (output logic [`W-1:0] o);\n  sub u0 (.a(o));\nendmodule\n",
        )
        .unwrap();
        let sub = dir.join("sub.sv");
        std::fs::write(&sub, "module sub(input logic [7:0] a);\nendmodule\n").unwrap();
        let bad = dir.join("bad.sv");
        std::fs::write(&bad, "module bad(\n").unwrap();
        Fixture {
            files: vec![top.clone(), sub.clone(), bad.clone()],
            incdirs: vec![dir.clone()],
            dir,
            svh,
            sub,
        }
    }

    /// 跑一轮增量分析 + 导出；返回（命中数, 输出目录）
    fn run(fx: &Fixture, out: &Path, refresh: bool, extra_defines: &[String]) -> usize {
        let defines = db::build_defines(extra_defines, &[], &[], &[], &fx.incdirs).unwrap();
        let mut pairs: Vec<(String, Option<String>)> = defines
            .iter()
            .map(|(n, d)| {
                (
                    n.clone(),
                    d.as_ref()
                        .and_then(|d| d.text.as_ref())
                        .map(|t| t.text.clone()),
                )
            })
            .collect();
        pairs.sort();
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(2)
            .build()
            .unwrap();
        let pc = ProgressCenter::new();
        let drive = db::Drive {
            files: &fx.files,
            defines: &defines,
            incdirs: &fx.incdirs,
            pool: &pool,
            pc: &pc,
            sub_bars: false,
        };
        let (db, stamps, reused) = db::analyze_incremental(&drive, &pairs, out, refresh, crate::db::cache::Payload::Xml).unwrap();
        XmlExport::new(&db, &fx.files, &pairs, &stamps, &fx.incdirs)
            .write(out)
            .unwrap();
        reused
    }

    /// 目录快照：相对路径 → 内容（index.xml 剥离 generated 时间戳）
    fn snapshot(dir: &Path) -> BTreeMap<String, String> {
        let mut out = BTreeMap::new();
        for e in walkdir::WalkDir::new(dir).sort_by_file_name() {
            let e = e.unwrap();
            if !e.file_type().is_file() {
                continue;
            }
            let rel = e.path().strip_prefix(dir).unwrap().to_string_lossy().into_owned();
            let mut body = std::fs::read_to_string(e.path()).unwrap();
            if rel == "index.xml" {
                body = strip_generated(&body);
            }
            out.insert(rel, body);
        }
        out
    }

    fn strip_generated(body: &str) -> String {
        let Some(rest) = body.split_once("generated=\"").map(|x| x.0.to_string() + "generated=\"") else {
            return body.to_string();
        };
        let after = &body[rest.len()..];
        let end = after.find('"').unwrap();
        format!("{rest}X{}", &after[end..])
    }

    #[test]
    fn incremental_matches_full_and_tracks_includes() {
        let fx = fixture("e2e");
        let out = tmpdir("e2e_out");
        let out_full = tmpdir("e2e_full");

        // 首轮冷启动：全部解析
        assert_eq!(run(&fx, &out, false, &[]), 0);
        let first = snapshot(&out);

        // 第二轮：top/sub 命中（bad 是错误文件不可缓存，每次重解析）
        assert_eq!(run(&fx, &out, false, &[]), 2);
        assert_eq!(snapshot(&out), first, "incremental output must equal full output");

        // touch 不改内容（重写同字节 → mtime 漂移时哈希仲裁仍命中；
        // 同秒写入则 mtime 快路径命中——两级至少一级成立）
        std::fs::write(&fx.sub, "module sub(input logic [7:0] a);\nendmodule\n").unwrap();
        assert_eq!(run(&fx, &out, false, &[]), 2);

        // 改 include 头文件 → 仅 include 它的 top 失效
        std::fs::write(&fx.svh, "`define W 16\n").unwrap();
        assert_eq!(run(&fx, &out, false, &[]), 1);
        // 与全新全量运行逐字节一致（除 generated）
        assert_eq!(run(&fx, &out_full, true, &[]), 0);
        assert_eq!(snapshot(&out), snapshot(&out_full), "incremental must converge to full re-parse");

        // --refresh：无视缓存全部重解析，输出不变
        assert_eq!(run(&fx, &out, true, &[]), 0);
        assert_eq!(snapshot(&out), snapshot(&out_full));

        // 宏集合变化 → 全局闸门失配，整库重解析
        assert_eq!(run(&fx, &out, false, &["SYNTH=1".to_string()]), 0);

        let _ = std::fs::remove_dir_all(&fx.dir);
        let _ = std::fs::remove_dir_all(&out);
        let _ = std::fs::remove_dir_all(&out_full);
    }
}
