//! RtlIndex JSON 导出器：XML 产物的逐字段镜像（docs/hdxml/rtlindex-xml.md §8）。
//!
//! 与 XML 共用同一份数据与排序规则（路径字典序 / BTreeMap 序 / 声明序），
//! 输出因此同样字节确定。`--format json` 时 JSON 即增量缓存载荷
//! （cache::load_cached_file_json 回读重建）；盘上只写当前格式。
//! 文件名：`index.xml` → `index.json`，`ip/x.v.xml` → `ip/x.v.json`（同相对路径换后缀）。

use super::cache::{CacheMeta, defines_fingerprint, incdirs_fingerprint};
use super::xml::{dims_text, file_mtime, file_xml_rel, restore_raw_macros, span_text};
use super::{DesignDb, ModuleDecl, PortInfo};
use anyhow::{Context, Result};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// 导出统计
pub struct ExportStats {
    pub files: usize,
    pub modules: usize,
}

pub struct JsonExport<'a> {
    db: &'a DesignDb,
    files: &'a [PathBuf],
    defines: &'a [(String, Option<String>)],
    stamps: &'a BTreeMap<PathBuf, CacheMeta>,
    incdirs: &'a [PathBuf],
    /// 生成时间戳（unix 秒）；测试可注入固定值保证字节级确定性
    generated: u64,
}

impl<'a> JsonExport<'a> {
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

    /// 写出 JSON 镜像目录：manifest 驱动 GC（旧 index.json 产物集 − 本次产物集 = 删除），
    /// index.json 最后写入——中途崩溃旧 manifest 仍在，下次 GC 依然正确。
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

        // 本次产物集合：源文件 → 相对 out_dir 的 JSON 路径（与 XML 同相对路径，后缀换 .json）
        let mut index_of: BTreeMap<&PathBuf, String> = BTreeMap::new();
        for f in &inputs {
            index_of.insert(*f, json_rel(file_xml_rel(f, &cwd)));
        }

        // GC：删除旧 manifest 中本次不再产出的 JSON，并修剪空目录
        let planned: BTreeSet<&str> = index_of.values().map(String::as_str).collect();
        super::cache::gc_stale(out_dir, read_old_manifest(out_dir), &planned);

        // 跨格式切换清理：删除遗留 XML 产物（index.xml + 其 manifest 列出的 *.xml）
        super::cache::gc_stale(out_dir, super::xml::read_old_manifest(out_dir), &BTreeSet::new());
        let _ = std::fs::remove_file(out_dir.join("index.xml"));

        for f in &inputs {
            let json_rel = &index_of[f];
            let mods = by_file.get(f).map(Vec::as_slice).unwrap_or(&[]);
            let errors = self.db.errors.get(*f).map(Vec::as_slice).unwrap_or(&[]);
            let body = self.render_file_json(f, mods, errors);
            let dest = out_dir.join(json_rel);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&dest, body).with_context(|| format!("write failed {}", dest.display()))?;
        }

        let index = self.render_index_json(&inputs, &by_file, &index_of);
        std::fs::write(out_dir.join("index.json"), index).context("write failed index.json")?;

        Ok(ExportStats {
            files: inputs.len(),
            modules: self.db.defs.len(),
        })
    }

    /// 单文件 JSON：镜像 render_file_xml（模块/参数/端口/实例 + 文件级错误）
    fn render_file_json(
        &self,
        file: &Path,
        mods: &[&ModuleDecl],
        errors: &[super::FileError],
    ) -> String {
        let mtime = file_mtime(file);
        let mut root = Obj::new();
        root.str("source", &file.to_string_lossy());
        root.num("mtime", mtime);
        // 缓存元数据：无指纹的文件（错误/宏 include）不写，规则同 XML
        if let Some(meta) = self.stamps.get(file) {
            root.num("srcSize", meta.source.size as u64);
            root.str("srcHash", &meta.source.hash);
            if !meta.includes.is_empty() {
                let mut arr = Arr::new();
                for inc in &meta.includes {
                    let mut o = Obj::new();
                    o.str("path", &inc.path.to_string_lossy());
                    o.str("hash", &inc.stamp.hash);
                    o.num("size", inc.stamp.size as u64);
                    o.num("mtime", inc.stamp.mtime as u64);
                    arr.obj(o);
                }
                root.arr("includes", arr);
            }
        }
        if !mods.is_empty() {
            let mut arr = Arr::new();
            for m in mods {
                arr.obj(self.module_json(m));
            }
            root.arr("modules", arr);
        }
        if !errors.is_empty() {
            let mut arr = Arr::new();
            for e in errors {
                let mut o = Obj::new();
                o.str("message", &e.message);
                if let Some(v) = e.offset {
                    o.num("offset", v as u64);
                }
                if let Some(v) = e.line {
                    o.num("line", v as u64);
                }
                if let Some(v) = e.column {
                    o.num("column", v as u64);
                }
                arr.obj(o);
            }
            root.arr("errors", arr);
        }
        render(&Value::Obj(root))
    }

    /// 模块对象：键次序镜像 XML 属性/子元素次序；空组省略键（XML 写空 <module/>）
    fn module_json(&self, m: &ModuleDecl) -> Obj {
        let mut o = Obj::new();
        o.str("name", &m.name);
        o.str("kind", m.kind.as_str());
        o.str("span", &span_text(m.span));
        o.str("contentHash", &m.content_hash);
        o.str("normHash", &m.norm_hash);
        // package 无 interfaceSig（契约 §5.2）
        if m.kind != super::ModKind::Package {
            o.str("interfaceSig", &m.interface_sig);
        }
        if m.kind != super::ModKind::Package && !m.imports.is_empty() {
            let mut arr = Arr::new();
            for i in &m.imports {
                let mut io = Obj::new();
                io.str("package", &i.package);
                io.str("symbol", &i.symbol);
                io.str("via", i.via.as_str());
                io.str("span", &span_text(i.span));
                arr.obj(io);
            }
            o.arr("imports", arr);
        }
        if !m.params.is_empty() {
            let mut arr = Arr::new();
            for p in &m.params {
                let mut po = Obj::new();
                po.str("name", &p.name);
                po.str("kind", p.kind.as_str());
                if let Some(t) = &p.data_type {
                    po.str("dataType", &restore_raw_macros(t));
                }
                if let Some(d) = &p.default {
                    po.str("default", &restore_raw_macros(&d.text));
                    if !d.deps.is_empty() {
                        po.str("deps", &restore_raw_macros(&d.deps.join(",")));
                    }
                }
                po.str("span", &span_text(p.span));
                arr.obj(po);
            }
            o.arr("params", arr);
        }
        if !m.ports.is_empty() {
            let mut arr = Arr::new();
            for p in &m.ports {
                arr.obj(port_json(p));
            }
            o.arr("ports", arr);
        }
        if !m.instances.is_empty() {
            let mut arr = Arr::new();
            for i in &m.instances {
                let mut io = Obj::new();
                io.str("name", &i.inst);
                io.str("target", &i.target);
                io.str("span", &span_text(i.span));
                if !i.params.is_empty() {
                    let mut ps = Arr::new();
                    for c in &i.params {
                        let mut co = Obj::new();
                        if let Some(n) = &c.name {
                            co.str("name", n);
                        }
                        co.str("value", &restore_raw_macros(&c.value));
                        ps.obj(co);
                    }
                    io.arr("params", ps);
                }
                arr.obj(io);
            }
            o.arr("instances", arr);
        }
        o
    }

    /// index.json：镜像 render_index_xml（文件清单 + 模块/包映射 + 顶层 DAG 层级树）
    fn render_index_json(
        &self,
        inputs: &[&PathBuf],
        by_file: &BTreeMap<&PathBuf, Vec<&ModuleDecl>>,
        index_of: &BTreeMap<&PathBuf, String>,
    ) -> String {
        let mut root = Obj::new();
        root.str("tool", &format!("hdxml {}", env!("CARGO_PKG_VERSION")));
        root.num("generated", self.generated);

        let mut files = Arr::new();
        for f in inputs {
            let status = if self.db.errors.contains_key(*f) {
                "error"
            } else {
                "ok"
            };
            let n_mods = by_file.get(f).map_or(0, |v| v.len());
            let mut o = Obj::new();
            o.str("source", &f.to_string_lossy());
            o.str("index", &index_of[f]);
            o.str("status", status);
            o.num("modules", n_mods as u64);
            o.num("mtime", file_mtime(f));
            files.obj(o);
        }
        root.arr("files", files);

        let mut defines = Arr::new();
        for (n, v) in self.defines {
            let mut o = Obj::new();
            o.str("name", n);
            match v {
                Some(v) => o.str("value", v),
                None => o.boolean("raw", true),
            }
            defines.obj(o);
        }
        root.arr("defines", defines);

        root.str("definesFp", &defines_fingerprint(self.defines));
        root.str("incdirsFp", &incdirs_fingerprint(self.incdirs));

        let mut modules = Arr::new();
        for (name, m) in &self.db.defs {
            if m.kind == super::ModKind::Package {
                continue;
            }
            let mut o = Obj::new();
            o.str("name", name);
            o.str("index", &index_of[&m.file]);
            modules.obj(o);
        }
        root.arr("modules", modules);

        let mut packages = Arr::new();
        for (name, m) in &self.db.defs {
            if m.kind != super::ModKind::Package {
                continue;
            }
            let mut o = Obj::new();
            o.str("name", name);
            o.str("index", &index_of[&m.file]);
            packages.obj(o);
        }
        root.arr("packages", packages);

        let mut hierarchy = Arr::new();
        for t in &self.db.tops {
            let mut visited = BTreeSet::new();
            visited.insert(t.clone());
            let mut node = Obj::new();
            node.str("module", t);
            node.boolean("blackbox", false);
            node.boolean("cycle", false);
            node.arr("children", self.dag_children(t, &mut visited));
            hierarchy.obj(node);
        }
        root.arr("hierarchy", hierarchy);

        render(&Value::Obj(root))
    }

    /// DAG 子节点数组（镜像 render_dag_node：黑盒/环标注为叶节点并截断）
    fn dag_children(&self, name: &str, visited: &mut BTreeSet<String>) -> Arr {
        let mut arr = Arr::new();
        for sub in self.db.submods(name) {
            if self.db.undef.contains(&sub) {
                let mut o = Obj::new();
                o.str("module", &sub);
                o.boolean("blackbox", true);
                o.boolean("cycle", false);
                arr.obj(o);
                continue;
            }
            if visited.contains(&sub) {
                let mut o = Obj::new();
                o.str("module", &sub);
                o.boolean("blackbox", false);
                o.boolean("cycle", true);
                arr.obj(o);
                continue;
            }
            visited.insert(sub.clone());
            let mut o = Obj::new();
            o.str("module", &sub);
            o.boolean("blackbox", false);
            o.boolean("cycle", false);
            o.arr("children", self.dag_children(&sub, visited));
            visited.remove(&sub);
            arr.obj(o);
        }
        arr
    }
}

/// 端口对象：XML 方向由标签名承载，JSON 统一收进 "dir"；可选键仅在非空时出现（同 port_attrs）
fn port_json(p: &PortInfo) -> Obj {
    let mut o = Obj::new();
    o.str("name", &p.name);
    o.str("dir", p.dir.map_or("port", |d| d.as_str()));
    if let Some(t) = &p.data_type {
        o.str("dataType", &restore_raw_macros(t));
    }
    if let Some(i) = &p.interface {
        o.str("interface", i);
    }
    if let Some(mp) = &p.modport {
        o.str("modport", mp);
    }
    if !p.packed.is_empty() {
        o.str("packed", &dims_text(&p.packed));
    }
    if !p.unpacked.is_empty() {
        o.str("unpacked", &dims_text(&p.unpacked));
    }
    if let Some(d) = &p.default {
        o.str("default", &restore_raw_macros(&d.text));
    }
    o.str("span", &span_text(p.span));
    o
}

/// XML 相对产物路径换后缀为 .json
fn json_rel(xml_rel: String) -> String {
    xml_rel
        .strip_suffix(".xml")
        .map_or_else(|| format!("{xml_rel}.json"), |s| format!("{s}.json"))
}

/// 读旧 index.json 的产物清单（自产格式行扫描 `"index": "…"` 即可）
pub(crate) fn read_old_manifest(out_dir: &Path) -> Vec<String> {
    let Ok(body) = std::fs::read_to_string(out_dir.join("index.json")) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in body.lines() {
        if let Some(rest) = line.split_once("\"index\": \"").map(|x| x.1)
            && let Some((val, _)) = rest.split_once('"')
        {
            out.push(val.to_string());
        }
    }
    out
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// JSON 字符串转义：`"`、`\` 及 < 0x20 控制字符（\uXXXX）；`/` 不转义
fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            _ => out.push(c),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// 极简 JSON 值模型 + 2 空格缩进打印器（无外部依赖，键序 = 插入序）

enum Value {
    Str(String),
    Num(u64),
    Bool(bool),
    Obj(Obj),
    Arr(Arr),
}

struct Obj(Vec<(String, Value)>);

impl Obj {
    fn new() -> Self {
        Self(Vec::new())
    }
    fn str(&mut self, k: &str, v: &str) {
        self.0.push((k.to_string(), Value::Str(v.to_string())));
    }
    fn num(&mut self, k: &str, v: u64) {
        self.0.push((k.to_string(), Value::Num(v)));
    }
    fn boolean(&mut self, k: &str, v: bool) {
        self.0.push((k.to_string(), Value::Bool(v)));
    }
    fn arr(&mut self, k: &str, v: Arr) {
        self.0.push((k.to_string(), Value::Arr(v)));
    }
}

struct Arr(Vec<Value>);

impl Arr {
    fn new() -> Self {
        Self(Vec::new())
    }
    fn obj(&mut self, v: Obj) {
        self.0.push(Value::Obj(v));
    }
}

/// 打印 JSON：2 空格缩进，文件尾换行
fn render(v: &Value) -> String {
    let mut buf = String::new();
    write_value(&mut buf, v, 0);
    buf.push('\n');
    buf
}

fn write_value(buf: &mut String, v: &Value, depth: usize) {
    match v {
        Value::Str(s) => buf.push_str(&format!("\"{}\"", esc(s))),
        Value::Num(n) => buf.push_str(&n.to_string()),
        Value::Bool(b) => buf.push_str(if *b { "true" } else { "false" }),
        Value::Obj(o) => {
            if o.0.is_empty() {
                buf.push_str("{}");
                return;
            }
            buf.push_str("{\n");
            let pad = "  ".repeat(depth + 1);
            for (i, (k, val)) in o.0.iter().enumerate() {
                buf.push_str(&format!("{pad}\"{}\": ", esc(k)));
                write_value(buf, val, depth + 1);
                if i + 1 < o.0.len() {
                    buf.push(',');
                }
                buf.push('\n');
            }
            buf.push_str(&"  ".repeat(depth));
            buf.push('}');
        }
        Value::Arr(a) => {
            if a.0.is_empty() {
                buf.push_str("[]");
                return;
            }
            buf.push_str("[\n");
            let pad = "  ".repeat(depth + 1);
            for (i, val) in a.0.iter().enumerate() {
                buf.push_str(&pad);
                write_value(buf, val, depth + 1);
                if i + 1 < a.0.len() {
                    buf.push(',');
                }
                buf.push('\n');
            }
            buf.push_str(&"  ".repeat(depth));
            buf.push(']');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_quotes_backslash_and_controls() {
        assert_eq!(esc("a\"b\\c"), "a\\\"b\\\\c");
        // 控制字符统一 \uXXXX（含 \n \t）；0x1f 边界
        assert_eq!(esc("\n\t\r\u{0}\u{1f}"), "\\u000a\\u0009\\u000d\\u0000\\u001f");
        // 边界：0x20 空格不转义；`/` 不转义；非 ASCII 直出
        assert_eq!(esc(" /x\u{7f}中文"), " /x\u{7f}中文");
    }

    #[test]
    fn render_escapes_keys_and_trailing_newline() {
        let mut o = Obj::new();
        o.str("k\"", "v\\");
        let out = render(&Value::Obj(o));
        assert_eq!(out, "{\n  \"k\\\"\": \"v\\\\\"\n}\n");
    }

    /// 确定性：同一输入两次导出字节一致（固定 generated）
    #[test]
    fn deterministic_bytes() {
        use crate::db::*;
        let file = PathBuf::from("ip/x.sv");
        let m = ModuleDecl {
            name: "x".into(),
            kind: ModKind::Module,
            file: file.clone(),
            span: [0, 10],
            params: vec![ParamInfo {
                name: "W".into(),
                kind: ParamKind::Parameter,
                data_type: Some("int".into()),
                default: Some(ExprText {
                    text: "8".into(),
                    deps: vec!["Y".into()],
                }),
                span: [1, 5],
            }],
            ports: vec![PortInfo {
                name: "o".into(),
                dir: Some(PortDir::Output),
                data_type: Some("logic".into()),
                interface: None,
                modport: None,
                packed: vec![ExprText {
                    text: "W-1:0".into(),
                    deps: vec![],
                }],
                unpacked: vec![],
                default: None,
                span: [2, 8],
            }],
            instances: vec![],
            imports: vec![],
            content_hash: "c".into(),
            norm_hash: "n".into(),
            interface_sig: "sig".into(),
        };
        let mut defs = BTreeMap::new();
        defs.insert("x".to_string(), m);
        let db = DesignDb::new(defs, BTreeMap::new());
        let stamps = BTreeMap::new();
        let defines: Vec<(String, Option<String>)> = vec![];
        let incdirs: Vec<PathBuf> = vec![];
        let files = vec![file];
        let run = || {
            let dir = std::env::temp_dir().join(format!("hdxml_json_det_{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            let e = JsonExport::with_generated(&db, &files, &defines, &stamps, &incdirs, 42);
            e.write(&dir).unwrap();
            let mut bytes: Vec<(String, Vec<u8>)> = Vec::new();
            fn walk(d: &Path, base: &Path, out: &mut Vec<(String, Vec<u8>)>) {
                for ent in std::fs::read_dir(d).unwrap() {
                    let p = ent.unwrap().path();
                    if p.is_dir() {
                        walk(&p, base, out);
                    } else {
                        out.push((
                            p.strip_prefix(base).unwrap().to_string_lossy().into_owned(),
                            std::fs::read(&p).unwrap(),
                        ));
                    }
                }
            }
            walk(&dir, &dir, &mut bytes);
            bytes.sort();
            let _ = std::fs::remove_dir_all(&dir);
            bytes
        };
        assert_eq!(run(), run());
    }

    /// GC：旧 manifest 中失效的 .json 被删除
    #[test]
    fn gc_removes_stale_json() {
        let db = DesignDb::default();
        let stamps = BTreeMap::new();
        let defines: Vec<(String, Option<String>)> = vec![];
        let incdirs: Vec<PathBuf> = vec![];
        let dir = std::env::temp_dir().join(format!("hdxml_json_gc_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let f1 = PathBuf::from("a.sv");
        let f2 = PathBuf::from("sub/b.sv");
        // 第一次：两个文件
        let files = vec![f1.clone(), f2.clone()];
        JsonExport::with_generated(&db, &files, &defines, &stamps, &incdirs, 1)
            .write(&dir)
            .unwrap();
        let stale = dir.join("sub/b.sv.json");
        assert!(stale.exists(), "b.sv.json written");
        // 第二次：只剩 a.sv → b.sv.json 被 GC，空目录 sub/ 被修剪
        let files = vec![f1.clone()];
        JsonExport::with_generated(&db, &files, &defines, &stamps, &incdirs, 1)
            .write(&dir)
            .unwrap();
        assert!(!stale.exists(), "stale b.sv.json removed");
        assert!(!dir.join("sub").exists(), "empty dir pruned");
        assert!(dir.join("index.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 缓存回读：JSON 载荷重建的 ModuleDecl 与导出源数据一致（ExprText::new 由原文重算 deps）
    #[test]
    fn cache_roundtrip_rebuilds_decls() {
        use crate::db::*;
        let file = PathBuf::from("ip/y.sv");
        let m = ModuleDecl {
            name: "y".into(),
            kind: ModKind::Module,
            file: file.clone(),
            span: [0, 20],
            params: vec![ParamInfo {
                name: "W".into(),
                kind: ParamKind::Parameter,
                data_type: Some("int".into()),
                default: Some(ExprText::new("A+B")),
                span: [1, 5],
            }],
            ports: vec![PortInfo {
                name: "o".into(),
                dir: Some(PortDir::Output),
                data_type: Some("logic".into()),
                interface: None,
                modport: None,
                packed: vec![ExprText::new("W-1:0")],
                unpacked: vec![],
                default: None,
                span: [2, 8],
            }],
            instances: vec![InstanceInfo {
                inst: "u0".into(),
                target: "z".into(),
                params: vec![ParamConn {
                    name: Some("W".into()),
                    value: "W".into(),
                }],
                span: [9, 19],
            }],
            imports: vec![ImportInfo {
                package: "p".into(),
                symbol: "*".into(),
                via: ImportVia::Decl,
                span: [0, 0],
            }],
            content_hash: "c".into(),
            norm_hash: "n".into(),
            interface_sig: "sig".into(),
        };
        let mut defs = BTreeMap::new();
        defs.insert("y".to_string(), m.clone());
        let db = DesignDb::new(defs, BTreeMap::new());
        // 写入真实文件以产生可用指纹（is_fresh 之外的重建正确性由本测试锁定）
        let tmp = std::env::temp_dir().join(format!("hdxml_json_rt_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let src = tmp.join("y.sv");
        std::fs::write(&src, b"module y; endmodule\n").unwrap();
        let mut stamps = BTreeMap::new();
        stamps.insert(file.clone(), cache::CacheMeta {
            source: cache::FileStamp::capture(&src).unwrap(),
            includes: vec![],
        });
        let defines: Vec<(String, Option<String>)> = vec![];
        let incdirs: Vec<PathBuf> = vec![];
        let files = vec![file.clone()];
        let out = tmp.join("out");
        JsonExport::with_generated(&db, &files, &defines, &stamps, &incdirs, 1)
            .write(&out)
            .unwrap();
        let json = out.join("ip/y.sv.json");
        let (mods, meta) = cache::load_cached_file_json(&json, &file).expect("cache rebuild");
        assert_eq!(mods, vec![m], "rebuilt ModuleDecl identical to source");
        // 虚拟路径 ip/y.sv 不在盘上，导出的 mtime=0；锁定 size/hash 一致性即可
        assert_eq!(meta.source.size, stamps[&file].source.size);
        assert_eq!(meta.source.hash, stamps[&file].source.hash);
        // 错误文件不可缓存
        let err_json = tmp.join("err.json");
        std::fs::write(&err_json, "{\"errors\": [{\"message\": \"x\"}]}\n").unwrap();
        assert!(cache::load_cached_file_json(&err_json, &file).is_none());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
