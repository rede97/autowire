//! RtlIndex XML 导出器：每源文件一个 XML + 顶层 index.xml（docs/hdxml/module-info.md §5）。
//!
//! 固定排序规则（每次序列化结果一致）：
//! - `<files>`：按源文件路径字典序
//! - 文件内 `<module>`：按模块名字典序
//! - `<module>` 子结构固定次序：`<params>` → `<ports>` → `<instances>`；组内按源码声明序
//! - `<hierarchy>` 子节点：按目标模块名字典序（去重，DAG 边集）

use super::cache::{CacheMeta, defines_fingerprint, incdirs_fingerprint};
use super::{DesignDb, ExprText, ModuleDecl, PortInfo};
use anyhow::{Context, Result};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// 导出统计
pub struct ExportStats {
    pub files: usize,
    pub modules: usize,
}

pub struct XmlExport<'a> {
    db: &'a DesignDb,
    files: &'a [PathBuf],
    /// 分析时使用的宏定义（名称, 值文本）；None = 登记未展开（raw），按名称字典序
    defines: &'a [(String, Option<String>)],
    /// 每文件缓存指纹（增量缓存基；无条目的文件不写缓存元数据，不可复用）
    stamps: &'a BTreeMap<PathBuf, CacheMeta>,
    /// include 搜索路径（顺序敏感；写入 incdirsFp 作为增量全局闸门之一）
    incdirs: &'a [PathBuf],
    /// 生成时间戳（unix 秒）；测试可注入固定值保证字节级确定性
    generated: u64,
}

impl<'a> XmlExport<'a> {
    pub fn new(
        db: &'a DesignDb,
        files: &'a [PathBuf],
        defines: &'a [(String, Option<String>)],
        stamps: &'a BTreeMap<PathBuf, CacheMeta>,
        incdirs: &'a [PathBuf],
    ) -> Self {
        Self {
            db,
            files,
            defines,
            stamps,
            incdirs,
            generated: now_unix(),
        }
    }

    #[cfg(test)]
    fn with_generated(
        db: &'a DesignDb,
        files: &'a [PathBuf],
        defines: &'a [(String, Option<String>)],
        stamps: &'a BTreeMap<PathBuf, CacheMeta>,
        incdirs: &'a [PathBuf],
        generated: u64,
    ) -> Self {
        Self {
            db,
            files,
            defines,
            stamps,
            incdirs,
            generated,
        }
    }


    /// 写出整个索引目录：manifest 驱动 GC（旧 index.xml 产物集 − 本次产物集 = 删除），
    /// index.xml 最后写入——中途崩溃旧 manifest 仍在，下次 GC 依然正确。
    pub fn write(&self, out_dir: &Path) -> Result<ExportStats> {
        std::fs::create_dir_all(out_dir)
            .with_context(|| format!("failed to create output dir {}", out_dir.display()))?;
        let cwd = std::env::current_dir().context("failed to get current dir")?;

        // 模块按源文件分组（BTreeMap：路径字典序）；组内按模块名排序
        let mut by_file: BTreeMap<&PathBuf, Vec<&ModuleDecl>> = BTreeMap::new();
        for m in self.db.defs.values() {
            by_file.entry(&m.file).or_default().push(m);
        }
        for mods in by_file.values_mut() {
            mods.sort_by(|a, b| a.name.cmp(&b.name));
        }

        let mut inputs: Vec<&PathBuf> = self.files.iter().collect();
        inputs.sort();

        // 本次产物集合：源文件 → 相对 out_dir 的 XML 路径（镜像源码相对路径）
        let mut index_of: BTreeMap<&PathBuf, String> = BTreeMap::new();
        for f in &inputs {
            let rel = file_xml_rel(f, &cwd);
            index_of.insert(*f, rel.to_string_lossy().into_owned());
        }

        // GC：删除旧 manifest 中本次不再产出的 XML（源码已删除/移出输入集），并修剪空目录
        let planned: BTreeSet<&str> = index_of.values().map(String::as_str).collect();
        for stale in read_old_manifest(out_dir) {
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

        for f in &inputs {
            let xml_rel = &index_of[f];
            let mods = by_file.get(f).map(Vec::as_slice).unwrap_or(&[]);
            let errors = self.db.errors.get(*f).map(Vec::as_slice).unwrap_or(&[]);
            let body = self.render_file_xml(f, mods, errors);
            let dest = out_dir.join(xml_rel);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&dest, body).with_context(|| format!("write failed {}", dest.display()))?;
        }

        let index = self.render_index_xml(&inputs, &by_file, &index_of);
        std::fs::write(out_dir.join("index.xml"), index).context("write failed index.xml")?;

        Ok(ExportStats {
            files: inputs.len(),
            modules: self.db.defs.len(),
        })
    }

    /// 单文件 XML：模块（参数/端口/实例）+ 文件级错误
    fn render_file_xml(
        &self,
        file: &Path,
        mods: &[&ModuleDecl],
        errors: &[super::FileError],
    ) -> String {
        let mut w = XmlWriter::new();
        let mtime = file_mtime(file);
        // 缓存元数据（增量复用依据）：无指纹的文件（错误/宏 include）不写，
        // 读取侧缺 srcHash 即判不可缓存
        let mut head = vec![
            ("source", file.to_string_lossy().into_owned()),
            ("mtime", mtime.to_string()),
        ];
        if let Some(meta) = self.stamps.get(file) {
            head.push(("srcSize", meta.source.size.to_string()));
            head.push(("srcHash", meta.source.hash.clone()));
        }
        w.open("fileIndex", &head);
        if let Some(meta) = self.stamps.get(file)
            && !meta.includes.is_empty()
        {
            w.open("includes", &[]);
            for inc in &meta.includes {
                w.empty(
                    "include",
                    &[
                        ("path", inc.path.to_string_lossy().into_owned()),
                        ("hash", inc.stamp.hash.clone()),
                        ("size", inc.stamp.size.to_string()),
                        ("mtime", inc.stamp.mtime.to_string()),
                    ],
                );
            }
            w.close("includes");
        }
        for m in mods {
            // package 无 interfaceSig（契约 §5.2：无端口，签名无意义）
            let mut attrs = vec![
                ("name", m.name.clone()),
                ("kind", m.kind.as_str().to_string()),
                ("span", span_text(m.span)),
                ("contentHash", m.content_hash.clone()),
                ("normHash", m.norm_hash.clone()),
            ];
            if m.kind != super::ModKind::Package {
                attrs.push(("interfaceSig", m.interface_sig.clone()));
            }
            if m.imports.is_empty()
                && m.params.is_empty()
                && m.ports.is_empty()
                && m.instances.is_empty()
            {
                w.empty("module", &attrs);
                continue;
            }
            w.open("module", &attrs);
            if m.kind != super::ModKind::Package && !m.imports.is_empty() {
                w.open("imports", &[]);
                for i in &m.imports {
                    w.empty(
                        "import",
                        &[
                            ("package", i.package.clone()),
                            ("symbol", i.symbol.clone()),
                            ("via", i.via.as_str().to_string()),
                            ("span", span_text(i.span)),
                        ],
                    );
                }
                w.close("imports");
            }
            if !m.params.is_empty() {
                w.open("params", &[]);
                for p in &m.params {
                    let mut a = vec![
                        ("name", p.name.clone()),
                        ("kind", p.kind.as_str().to_string()),
                    ];
                    if let Some(t) = &p.data_type {
                        a.push(("dataType", t.clone()));
                    }
                    if let Some(d) = &p.default {
                        a.push(("default", d.text.clone()));
                        push_deps(&mut a, d);
                    }
                    a.push(("span", span_text(p.span)));
                    w.empty("param", &a);
                }
                w.close("params");
            }
            if !m.ports.is_empty() {
                w.open("ports", &[]);
                for p in &m.ports {
                    // 方向即标签名（<input>/<output>/…）；方向未知（非 ANSI 未补全）退回 <port>
                    let tag = p.dir.map_or("port", |d| d.as_str());
                    w.empty(tag, &port_attrs(p));
                }
                w.close("ports");
            }
            if !m.instances.is_empty() {
                w.open("instances", &[]);
                for i in &m.instances {
                    if i.params.is_empty() {
                        w.empty(
                            "instance",
                            &[
                                ("name", i.inst.clone()),
                                ("target", i.target.clone()),
                                ("span", span_text(i.span)),
                            ],
                        );
                        continue;
                    }
                    w.open(
                        "instance",
                        &[
                            ("name", i.inst.clone()),
                            ("target", i.target.clone()),
                            ("span", span_text(i.span)),
                        ],
                    );
                    for c in &i.params {
                        let mut a = Vec::new();
                        if let Some(n) = &c.name {
                            a.push(("name", n.clone()));
                        }
                        a.push(("value", c.value.clone()));
                        w.empty("param", &a);
                    }
                    w.close("instance");
                }
                w.close("instances");
            }
            w.close("module");
        }
        for e in errors {
            let mut a = vec![("message", e.message.clone())];
            if let Some(o) = e.offset {
                a.push(("offset", o.to_string()));
            }
            if let Some(l) = e.line {
                a.push(("line", l.to_string()));
            }
            if let Some(c) = e.column {
                a.push(("column", c.to_string()));
            }
            w.empty("error", &a);
        }
        w.close("fileIndex");
        w.buf
    }

    /// index.xml：文件清单 + 模块→索引文件映射 + 顶层 DAG 层级树
    fn render_index_xml(
        &self,
        inputs: &[&PathBuf],
        by_file: &BTreeMap<&PathBuf, Vec<&ModuleDecl>>,
        index_of: &BTreeMap<&PathBuf, String>,
    ) -> String {
        let mut w = XmlWriter::new();
        // 全局指纹（增量闸门；消费方不一致即整库作废）：宏集合 + incdirs（顺序敏感）
        let defines_fp = defines_fingerprint(self.defines);
        let incdirs_fp = incdirs_fingerprint(self.incdirs);
        w.open(
            "rtlIndex",
            &[
                ("tool", format!("hdxml {}", env!("CARGO_PKG_VERSION"))),
                ("generated", self.generated.to_string()),
                ("files", inputs.len().to_string()),
                ("modules", self.db.defs.values().filter(|m| m.kind != super::ModKind::Package).count().to_string()),
                ("errorFiles", self.db.errors.len().to_string()),
                (
                    "packages",
                    self.db
                        .defs
                        .values()
                        .filter(|m| m.kind == super::ModKind::Package)
                        .count()
                        .to_string(),
                ),
                ("definesFp", defines_fp),
                ("incdirsFp", incdirs_fp),
            ],
        );
        if !self.defines.is_empty() {
            w.open("defines", &[]);
            for (n, v) in self.defines {
                match v {
                    Some(v) => w.empty("define", &[("name", n.clone()), ("value", v.clone())]),
                    None => w.empty("define", &[("name", n.clone()), ("raw", "true".to_string())]),
                }
            }
            w.close("defines");
        }
        w.open("files", &[]);
        for f in inputs {
            let xml = &index_of[f];
            let status = if self.db.errors.contains_key(*f) {
                "error"
            } else {
                "ok"
            };
            let n_mods = by_file.get(f).map_or(0, |v| v.len());
            w.empty(
                "file",
                &[
                    ("source", f.to_string_lossy().into_owned()),
                    ("index", xml.clone()),
                    ("status", status.to_string()),
                    ("modules", n_mods.to_string()),
                    ("mtime", file_mtime(f).to_string()),
                ],
            );
        }
        w.close("files");
        w.open("modules", &[]);
        for (name, m) in &self.db.defs {
            if m.kind == super::ModKind::Package {
                continue;
            }
            w.empty(
                "module",
                &[("name", name.clone()), ("index", index_of[&m.file].clone())],
            );
        }
        w.close("modules");
        w.open("packages", &[]);
        for (name, m) in &self.db.defs {
            if m.kind != super::ModKind::Package {
                continue;
            }
            w.empty(
                "package",
                &[("name", name.clone()), ("index", index_of[&m.file].clone())],
            );
        }
        w.close("packages");
        w.open("hierarchy", &[]);
        for t in &self.db.tops {
            let mut visited = std::collections::BTreeSet::new();
            w.open("top", &[("module", t.clone())]);
            self.render_dag_node(&mut w, t, &mut visited);
            w.close("top");
        }
        w.close("hierarchy");
        w.close("rtlIndex");
        w.buf
    }

    /// DAG 层级节点（svo 语义：子节点 = 直接引用模块去重有序；环/黑盒标注后截断）
    fn render_dag_node(
        &self,
        w: &mut XmlWriter,
        name: &str,
        visited: &mut std::collections::BTreeSet<String>,
    ) {
        if !visited.insert(name.to_string()) {
            return;
        }
        for sub in self.db.submods(name) {
            if self.db.undef.contains(&sub) {
                w.empty(
                    "node",
                    &[("module", sub.clone()), ("blackbox", "true".to_string())],
                );
                continue;
            }
            if visited.contains(&sub) {
                w.empty(
                    "node",
                    &[("module", sub.clone()), ("cycle", "true".to_string())],
                );
                continue;
            }
            w.open("node", &[("module", sub.clone())]);
            self.render_dag_node(w, &sub, visited);
            w.close("node");
        }
        visited.remove(name);
    }
}

fn span_text(span: [usize; 2]) -> String {
    format!("{}:{}", span[0], span[1])
}

fn push_deps(attrs: &mut Vec<(&'static str, String)>, e: &ExprText) {
    if !e.deps.is_empty() {
        attrs.push(("deps", e.deps.join(",")));
    }
}

fn dims_text(dims: &[ExprText]) -> String {
    dims.iter()
        .map(|d| format!("[{}]", d.text))
        .collect::<Vec<_>>()
        .join("")
}

fn port_attrs(p: &PortInfo) -> Vec<(&'static str, String)> {
    // 方向由标签名承载（<input>/<output>/…），不再重复 dir 属性
    let mut a = vec![("name", p.name.clone())];
    if let Some(t) = &p.data_type {
        a.push(("dataType", t.clone()));
    }
    if let Some(i) = &p.interface {
        a.push(("interface", i.clone()));
    }
    if let Some(mp) = &p.modport {
        a.push(("modport", mp.clone()));
    }
    if !p.packed.is_empty() {
        a.push(("packed", dims_text(&p.packed)));
    }
    if !p.unpacked.is_empty() {
        a.push(("unpacked", dims_text(&p.unpacked)));
    }
    if let Some(d) = &p.default {
        a.push(("default", d.text.clone()));
    }
    a.push(("span", span_text(p.span)));
    a
}


/// 每文件 XML 相对路径：镜像源码相对 CWD 的路径并追加 .xml（`src/foo.sv` → `src/foo.sv.xml`）。
/// CWD 之外的路径剥掉根/父级分量，保留可辨识层级；按构造唯一，无需哈希。
fn file_xml_rel(path: &Path, cwd: &Path) -> PathBuf {
    let rel: PathBuf = match path.strip_prefix(cwd) {
        Ok(r) => r.to_path_buf(),
        Err(_) => path
            .components()
            .filter_map(|c| match c {
                std::path::Component::Normal(s) => Some(s),
                _ => None,
            })
            .collect(),
    };
    let name = format!("{}.xml", rel.file_name().unwrap_or_default().to_string_lossy());
    rel.with_file_name(name)
}

/// 读旧 index.xml 的产物清单（`<file index="…">`；自产格式行扫描即可）
fn read_old_manifest(out_dir: &Path) -> Vec<String> {
    let Ok(body) = std::fs::read_to_string(out_dir.join("index.xml")) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in body.lines() {
        let line = line.trim_start();
        if !line.starts_with("<file ") {
            continue;
        }
        if let Some(rest) = line.split_once("index=\"").map(|x| x.1)
            && let Some((val, _)) = rest.split_once('"')
        {
            out.push(val.to_string());
        }
    }
    out
}

fn file_mtime(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs())
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// 属性值转义（XML 全部数据走属性，文本节点仅空白）。
/// 换行/回车必须转字符引用——属性内的字面换行会被合规解析器归一化为空格，
/// 且本格式的行扫描读取依赖每元素一行。
fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\n' => out.push_str("&#10;"),
            '\r' => out.push_str("&#13;"),
            _ => out.push(c),
        }
    }
    out
}

struct XmlWriter {
    buf: String,
    depth: usize,
}

impl XmlWriter {
    fn new() -> Self {
        Self {
            buf: String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"),
            depth: 0,
        }
    }

    fn attrs_text(attrs: &[(&str, String)]) -> String {
        attrs
            .iter()
            .map(|(k, v)| format!(" {k}=\"{}\"", esc(v)))
            .collect()
    }

    fn open(&mut self, name: &str, attrs: &[(&str, String)]) {
        let pad = "  ".repeat(self.depth);
        self.buf
            .push_str(&format!("{pad}<{name}{}>\n", Self::attrs_text(attrs)));
        self.depth += 1;
    }

    fn empty(&mut self, name: &str, attrs: &[(&str, String)]) {
        let pad = "  ".repeat(self.depth);
        self.buf
            .push_str(&format!("{pad}<{name}{}/>\n", Self::attrs_text(attrs)));
    }

    fn close(&mut self, name: &str) {
        self.depth -= 1;
        let pad = "  ".repeat(self.depth);
        self.buf.push_str(&format!("{pad}</{name}>\n"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{DesignDb, FileError, InstanceInfo, ModKind, ParamInfo, ParamKind, PortDir};

    fn demo_db(file: &Path) -> DesignDb {
        let sub = ModuleDecl {
            imports: vec![],
            name: "sub".into(),
            kind: ModKind::Module,
            norm_hash: "n_sub".into(),
            file: file.to_path_buf(),
            span: [0, 50],
            params: vec![ParamInfo {
                name: "W".into(),
                kind: ParamKind::Parameter,
                data_type: None,
                default: Some(ExprText::new("8")),
                span: [10, 20],
            }],
            ports: vec![PortInfo {
                name: "d".into(),
                dir: Some(PortDir::Input),
                data_type: Some("logic".into()),
                interface: None,
                modport: None,
                packed: vec![ExprText::new("W-1:0")],
                unpacked: vec![],
                default: None,
                span: [21, 30],
            }],
            instances: vec![],
            content_hash: "h_sub".into(),
            interface_sig: "s_sub".into(),
        };
        let mut top = sub.clone();
        top.name = "top".into();
        top.instances = vec![InstanceInfo {
            inst: "u0".into(),
            target: "sub".into(),
            params: vec![crate::db::ParamConn {
                name: Some("W".into()),
                value: "8".into(),
            }],
            span: [60, 70],
        }];
        top.content_hash = "h_top".into();
        top.interface_sig = "s_top".into();
        let mut defs = BTreeMap::new();
        defs.insert("sub".to_string(), sub);
        defs.insert("top".to_string(), top);
        DesignDb::new(defs, BTreeMap::new())
    }

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hdxml_xml_test_{name}_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn escape_attr_values() {
        assert_eq!(esc("a&b<c>\"d\""), "a&amp;b&lt;c&gt;&quot;d&quot;");
        assert_eq!(esc("plain_123"), "plain_123");
        // 多行表达式原文：换行必须转字符引用（属性内字面换行会被解析器归一化为空格）
        assert_eq!(esc("'{1,\n2}"), "'{1,&#10;2}");
    }

    #[test]
    fn deterministic_output() {
        let f = PathBuf::from("/nonexistent/top.sv");
        let db = demo_db(&f);
        let files = vec![f.clone()];
        let d1 = tmpdir("det1");
        let d2 = tmpdir("det2");
        XmlExport::with_generated(&db, &files, &[], &BTreeMap::new(), &[], 0).write(&d1).unwrap();
        XmlExport::with_generated(&db, &files, &[], &BTreeMap::new(), &[], 0).write(&d2).unwrap();
        let i1 = std::fs::read_to_string(d1.join("index.xml")).unwrap();
        let i2 = std::fs::read_to_string(d2.join("index.xml")).unwrap();
        assert_eq!(i1, i2, "two index.xml exports must be byte-identical");
        let x1 = std::fs::read_to_string(d1.join("nonexistent/top.sv.xml")).unwrap();
        let x2 = std::fs::read_to_string(d2.join("nonexistent/top.sv.xml")).unwrap();
        assert_eq!(x1, x2);
        // 层级：top → sub
        assert!(i1.contains("<top module=\"top\">"));
        assert!(i1.contains("<node module=\"sub\">"));
        // 模块映射
        assert!(i1.contains("<module name=\"sub\" index=\"nonexistent/top.sv.xml\"/>"));
        let _ = std::fs::remove_dir_all(&d1);
        let _ = std::fs::remove_dir_all(&d2);
    }

    #[test]
    fn error_file_xml_carries_location() {
        let f = PathBuf::from("/nonexistent/bad.sv");
        // 精确位：Error::Parse 携带 origin 文件 + 偏移（源文件坐标）
        let err = sv_parser::Error::Parse(Some((f.clone(), 42)));
        let raw = "aaaaaaaaaa\naaaaaaaaaa\naaaaaaaaaa\naaaaaaaaaa\naaaaaaaaaa\n";
        let located = FileError::parse_failed(&err, &f, raw);
        assert_eq!((located.offset, located.line, located.column), (Some(42), Some(4), Some(10)));
        // EOF 近似位：Parse(None)（nom Incomplete）→ 源文件末尾
        let approx = FileError::parse_failed(&sv_parser::Error::Parse(None), &f, raw);
        assert_eq!((approx.offset, approx.line, approx.column), (Some(raw.len()), Some(6), Some(1)));
        let mut errors: BTreeMap<PathBuf, Vec<FileError>> = BTreeMap::new();
        errors.insert(f.clone(), vec![located]);
        let db = DesignDb::new(BTreeMap::new(), errors);
        let files = vec![f.clone()];
        let dir = tmpdir("err");
        XmlExport::with_generated(&db, &files, &[], &BTreeMap::new(), &[], 0).write(&dir).unwrap();
        let body = std::fs::read_to_string(dir.join("nonexistent/bad.sv.xml")).unwrap();
        assert!(body.contains("offset=\"42\" line=\"4\" column=\"10\""), "{body}");
        let index = std::fs::read_to_string(dir.join("index.xml")).unwrap();
        assert!(index.contains("status=\"error\""), "{index}");
        assert!(index.contains("errorFiles=\"1\""), "{index}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn manifest_gc_removes_stale_but_keeps_foreign_files() {
        let f = PathBuf::from("/nonexistent/top.sv");
        let db = demo_db(&f);
        let files = vec![f.clone()];
        let dir = tmpdir("gc");
        // 旧 manifest：声称 stale/old.sv.xml 是产物；另有无关用户文件
        std::fs::create_dir_all(dir.join("stale")).unwrap();
        std::fs::write(dir.join("stale/old.sv.xml"), "<fileIndex/>").unwrap();
        std::fs::write(
            dir.join("index.xml"),
            "<rtlIndex>\n  <files>\n    <file source=\"/nonexistent/old.sv\" index=\"stale/old.sv.xml\" status=\"ok\" modules=\"1\" mtime=\"1\"/>\n  </files>\n</rtlIndex>\n",
        )
        .unwrap();
        std::fs::write(dir.join("keep.txt"), "user data").unwrap();

        XmlExport::with_generated(&db, &files, &[], &BTreeMap::new(), &[], 0).write(&dir).unwrap();

        assert!(!dir.join("stale/old.sv.xml").exists(), "stale XML must be collected");
        assert!(!dir.join("stale").exists(), "empty dirs must be pruned");
        assert!(dir.join("keep.txt").exists(), "non-artifact files must not be deleted");
        assert!(dir.join("nonexistent/top.sv.xml").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn defines_recorded_and_fingerprint_changes_with_macros() {
        let f = PathBuf::from("/nonexistent/top.sv");
        let db = demo_db(&f);
        let files = vec![f.clone()];
        let defs_a = vec![
            ("ADDR_W".to_string(), Some("32".to_string())),
            ("DATA_W".to_string(), Some("64".to_string())),
        ];
        let dir = tmpdir("defs");
        XmlExport::with_generated(&db, &files, &defs_a, &BTreeMap::new(), &[], 0)
            .write(&dir)
            .unwrap();
        let index = std::fs::read_to_string(dir.join("index.xml")).unwrap();
        // 清单按名称字典序、指纹属性存在
        let da = index.find("name=\"ADDR_W\"").unwrap();
        let dw = index.find("name=\"DATA_W\"").unwrap();
        assert!(da < dw, "defines must be sorted by name: {index}");
        assert!(index.contains("definesFp=\""), "{index}");

        // 宏集合变化 → 指纹必须变化（整库作废判定依据）
        let defs_b = vec![
            ("ADDR_W".to_string(), Some("32".to_string())),
            ("DATA_W".to_string(), Some("128".to_string())),
        ];
        let fp_of = |defs: &[(String, Option<String>)]| {
            let dir = tmpdir("defs_fp");
            XmlExport::with_generated(&db, &files, defs, &BTreeMap::new(), &[], 0)
                .write(&dir)
                .unwrap();
            let body = std::fs::read_to_string(dir.join("index.xml")).unwrap();
            let _ = std::fs::remove_dir_all(&dir);
            body.split("definesFp=\"").nth(1).unwrap()[..32].to_string()
        };
        assert_ne!(fp_of(&defs_a), fp_of(&defs_b), "a macro value change must change the fingerprint");
        assert_eq!(fp_of(&defs_a), fp_of(&defs_a), "same macro set must give a stable fingerprint");
        // raw 宏（None）：XML 记 raw="true" 且无 value；与空值展开宏指纹必须可区分
        let defs_raw = vec![
            ("ADDR_W".to_string(), Some("32".to_string())),
            ("DATA_W".to_string(), None),
        ];
        let dir_raw = tmpdir("defs_raw");
        XmlExport::with_generated(&db, &files, &defs_raw, &BTreeMap::new(), &[], 0)
            .write(&dir_raw)
            .unwrap();
        let index_raw = std::fs::read_to_string(dir_raw.join("index.xml")).unwrap();
        assert!(
            index_raw.contains("name=\"DATA_W\" raw=\"true\""),
            "raw macros must carry the raw attribute: {index_raw}"
        );
        let _ = std::fs::remove_dir_all(&dir_raw);
        assert_ne!(fp_of(&defs_a), fp_of(&defs_raw), "expanded and raw must be distinguishable");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
