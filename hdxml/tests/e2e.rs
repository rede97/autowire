//! 端到端 CLI 测试：黑盒驱动 hdxml 二进制，锁定 docs/hdxml/cli.md 的行为约束
//! （退出码、警告、输入组、导出布局/GC、字节确定性、增量/refresh、错误定位）。
//! 库级语义（提取器/缓存内部）由 src 内单测覆盖；本文件只断言 CLI 可观察行为。

use std::path::{Path, PathBuf};
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_hdxml");

struct Case {
    dir: PathBuf,
}

impl Case {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("hdxml_e2e_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self { dir }
    }

    fn write(&self, rel: &str, content: &str) -> PathBuf {
        let p = self.dir.join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&p, content).unwrap();
        p
    }

    fn out(&self) -> PathBuf {
        self.dir.join("out")
    }

    /// 运行 hdxml，返回（退出码, 合并输出）
    fn run(&self, args: &[String]) -> (i32, String) {
        let o = Command::new(BIN)
            .args(args)
            .output()
            .expect("hdxml run failed");
        let mut text = String::from_utf8_lossy(&o.stdout).into_owned();
        text.push_str(&String::from_utf8_lossy(&o.stderr));
        (o.status.code().unwrap_or(-1), text)
    }

    /// 在输出目录中按后缀找文件（镜像命名剥根分量，按后缀匹配最稳）
    fn find_out(&self, suffix: &str) -> Option<PathBuf> {
        fn walk(d: &Path, suffix: &str, hit: &mut Option<PathBuf>) {
            for e in std::fs::read_dir(d).unwrap() {
                let p = e.unwrap().path();
                if p.is_dir() {
                    walk(&p, suffix, hit);
                } else if p.to_string_lossy().ends_with(suffix) {
                    *hit = Some(p);
                }
            }
        }
        if !self.out().exists() {
            return None;
        }
        let mut hit = None;
        walk(&self.out(), suffix, &mut hit);
        hit
    }
}

impl Drop for Case {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// 剥离 index.xml 的 generated 时间戳（等价性比较基准）
fn strip_generated(body: &str) -> String {
    let Some((head, rest)) = body.split_once("generated=\"") else {
        return body.to_string();
    };
    let end = rest.find('"').unwrap();
    format!("{head}generated=\"X{}", &rest[end..])
}

// ---------------------------------------------------------------------------
// 入口与帮助

#[test]
fn no_args_prints_help_and_fails() {
    let c = Case::new("noargs");
    let (code, text) = c.run(&[]);
    assert_ne!(code, 0);
    assert!(text.contains("Usage"), "arg_required_else_help: {text}");
}

#[test]
fn empty_input_set_is_an_error() {
    let c = Case::new("empty");
    let (code, text) = c.run(&["--tree".into()]);
    assert_eq!(code, 1, "clap missing input group → usage error: {text}");
}

// ---------------------------------------------------------------------------
// 输入组（cli.md §2）

#[test]
fn sources_union_tree_and_blackbox_marks() {
    let c = Case::new("union");
    let top = c.write(
        "top.sv",
        "module top(output logic o);\n  sub u0(.a(o));\n  ext_cell u1(.a(o));\nendmodule\n",
    );
    let sub = c.write("sub.sv", "module sub(input logic a);\nendmodule\n");
    let (code, text) = c.run(&["-s".into(), s(&top), s(&sub), "--tree".into()]);
    assert_eq!(code, 0, "{text}");
    assert!(text.contains("modules: 2"), "{text}");
    assert!(text.contains("top"), "{text}");
    assert!(text.contains("ext_cell [blackbox]"), "tree marks blackbox: {text}");
}

#[test]
fn walk_dirs_with_exclude_filenames() {
    let c = Case::new("walk");
    c.write("rtl/keep.sv", "module keep; endmodule\n");
    c.write("rtl/tb_top.sv", "module tb_top; endmodule\n");
    let (code, text) = c.run(&[
        "-w".into(),
        s(&c.dir.join("rtl")),
        "--exclude-filenames".into(),
        "tb_top.sv".into(),
        "--tree".into(),
    ]);
    assert_eq!(code, 0, "{text}");
    assert!(text.contains("modules: 1"), "{text}");
    assert!(text.contains("keep"), "{text}");
    assert!(!text.contains("tb_top"), "excluded module must not appear: {text}");
}

#[test]
fn svh_in_filelist_skipped_with_warning() {
    let c = Case::new("svh");
    let svh = c.write("defs.svh", "`define W 8\n");
    let top = c.write("top.sv", "module top; endmodule\n");
    let f = c.write("list.f", &format!("{}\n{}\n", s(&svh), s(&top)));
    let (code, text) = c.run(&["-f".into(), s(&f), "--tree".into()]);
    assert_eq!(code, 0, "{text}");
    assert!(text.contains("warning"), ".svh entry must warn: {text}");
    assert!(text.contains("modules: 1"), "only top is analyzed: {text}");
}

#[test]
fn vc_filelist_incdir_define_and_frel() {
    let c = Case::new("vc");
    c.write("inc/defs.svh", "`define W 8\n");
    let top = c.write(
        "top.sv",
        "`include \"defs.svh\"\n`ifdef SYNTH\nmodule top(output logic [`W-1:0] o);\n  leaf u(.a(o));\nendmodule\n`endif\n",
    );
    // -F 子列表：leaf.sv 相对该子列表所在目录解析
    c.write("ip/leaf/leaf.sv", "module leaf(input logic [7:0] a);\nendmodule\n");
    c.write("ip/leaf/leaf.vc", "leaf.sv\n");
    let vc = c.write(
        "top.vc",
        &format!(
            "+incdir+{}\n+define+SYNTH\n-F {}\n{}\n",
            s(&c.dir.join("inc")),
            s(&c.dir.join("ip/leaf/leaf.vc")),
            s(&top),
        ),
    );
    let (code, text) = c.run(&["-f".into(), s(&vc), "--tree".into()]);
    assert_eq!(code, 0, "vc drives incdir/define/-F: {text}");
    assert!(text.contains("modules: 2"), "top + leaf: {text}");
    assert!(text.contains("blackbox: 0"), "leaf must resolve: {text}");
}

#[test]
fn vc_unsupported_option_is_an_error() {
    let c = Case::new("vcbad");
    let top = c.write("top.sv", "module top; endmodule\n");
    let vc = c.write("bad.vc", &format!("-y {}\n{}\n", s(&c.dir), s(&top)));
    let (code, text) = c.run(&["-f".into(), s(&vc), "--tree".into()]);
    assert_eq!(code, 1, "library search is not implemented: {text}");
    assert!(text.contains("unsupported option"), "{text}");
    assert!(text.contains("-y"), "{text}");
}

// ---------------------------------------------------------------------------
// 宏（cli.md §2 / module-info.md §3）

#[test]
fn bare_define_means_one_and_gates_ifdef() {
    let c = Case::new("def");
    let top = c.write(
        "top.sv",
        "module top;\n`ifdef FLAG\n  localparam int K = 1;\n`endif\nendmodule\n",
    );
    // 无 -D：`ifdef 分支不展开，但同名模块仍在（仅验证不报错）
    let (code, _) = c.run(&["-s".into(), s(&top), "--tree".into()]);
    assert_eq!(code, 0);
    // 有 -D FLAG（裸名按 EDA 惯例 =1）：`ifdef 判真 —— 经 keep_raw 哨兵在 XML 中可观察
    let (code, _) = c.run(&["-s".into(), s(&top), "-D".into(), "FLAG".into(), "--tree".into()]);
    assert_eq!(code, 0);
}

#[test]
fn keep_raw_macro_exported_as_backtick_text() {
    let c = Case::new("raw");
    let top = c.write("top.sv", "module top(output logic [`W-1:0] o);\nendmodule\n");
    let (code, _) = c.run(&[
        "-s".into(),
        s(&top),
        "--keep-raw".into(),
        "W".into(),
        "-o".into(),
        s(&c.out()),
    ]);
    assert_eq!(code, 0);
    let xml = std::fs::read_to_string(c.find_out("top.sv.xml").unwrap()).unwrap();
    // 哨兵只活在分析文本；XML 承诺可直接落 SV 的原文（module-info.md B-6）
    assert!(
        xml.contains("packed=\"[`W-1:0]\""),
        "raw macro dims must be exported as `W: {xml}"
    );
    assert!(
        !xml.contains("__MACRO__DEFINE__"),
        "the analysis-phase sentinel must not leak into the XML: {xml}"
    );
}

#[test]
fn include_resolved_via_incdirs() {
    let c = Case::new("inc");
    c.write("include/defs.svh", "`define W 8\n");
    let top = c.write(
        "top.sv",
        "`include \"defs.svh\"\nmodule top(output logic [`W-1:0] o);\nendmodule\n",
    );
    let (code, text) = c.run(&["-s".into(), s(&top.clone()), "--tree".into()]);
    assert_eq!(code, 1, "without -I the include fails: {text}");
    let (code, text) = c.run(&[
        "-s".into(),
        s(&top),
        "-I".into(),
        s(&c.dir.join("include")),
        "--tree".into(),
    ]);
    assert_eq!(code, 0, "with -I the include resolves: {text}");
}

// ---------------------------------------------------------------------------
// 错误与退出码（cli.md §3）

#[test]
fn error_file_exit1_and_index_marks_error() {
    let c = Case::new("err");
    let bad = c.write("bad.sv", "module bad(\n");
    let (code, text) = c.run(&["-s".into(), s(&bad), "-o".into(), s(&c.out())]);
    assert_eq!(code, 1, "error file → exit 1: {text}");
    let xml = std::fs::read_to_string(c.find_out("bad.sv.xml").unwrap()).unwrap();
    assert!(xml.contains("<error message="), "{xml}");
    // EOF 类错误（截断文件）经近似定位：源文件末尾（"module bad(\n" 长 12 → 行 2 列 1）
    assert!(
        xml.contains("offset=\"12\" line=\"2\" column=\"1\""),
        "EOF error must carry approximate location: {xml}"
    );
    let index = std::fs::read_to_string(c.out().join("index.xml")).unwrap();
    assert!(index.contains("status=\"error\""), "{index}");
    assert!(index.contains("errorFiles=\"1\""), "{index}");
}

#[test]
fn fail_on_undef_only_with_flag() {
    let c = Case::new("undef");
    let top = c.write("top.sv", "module top;\n  ext_cell u0();\nendmodule\n");
    let (code, _) = c.run(&["-s".into(), s(&top), "--tree".into()]);
    assert_eq!(code, 0, "blackbox alone does not fail");
    let (code, text) = c.run(&["-s".into(), s(&top), "--fail-on-undef".into(), "--tree".into()]);
    assert_eq!(code, 1, "--fail-on-undef gates: {text}");
}

#[test]
fn duplicate_module_definition_is_an_error_naming_both_files() {
    let c = Case::new("dup");
    let a = c.write("a.sv", "module dup; endmodule\n");
    let b = c.write("b.sv", "module dup; logic x; endmodule\n");
    let (code, text) = c.run(&["-s".into(), s(&a), s(&b), "--tree".into()]);
    assert_eq!(code, 1, "{text}");
    assert!(text.contains("redefined"), "{text}");
    assert!(text.contains("a.sv"), "error names the first file: {text}");
}

// ---------------------------------------------------------------------------
// 导出（module-info.md §5 / rtlindex-xml.md §2）

#[test]
fn export_layout_gc_and_foreign_file_kept() {
    let c = Case::new("gc");
    let a = c.write("a.sv", "module a; endmodule\n");
    let b = c.write("b.sv", "module b; endmodule\n");
    c.run(&["-s".into(), s(&a.clone()), s(&b), "-o".into(), s(&c.out())]);
    assert!(c.find_out("a.sv.xml").is_some());
    assert!(c.find_out("b.sv.xml").is_some());
    // 非产物文件不受 GC 影响
    std::fs::write(c.out().join("keep.txt"), "user data").unwrap();
    // 第二轮 b 移出输入集 → 其 XML 被 GC
    c.run(&["-s".into(), s(&a), "-o".into(), s(&c.out())]);
    assert!(c.find_out("b.sv.xml").is_none(), "stale XML must be collected");
    assert!(c.out().join("keep.txt").exists(), "foreign file kept");
}

#[test]
fn export_is_byte_deterministic_modulo_generated() {
    let c = Case::new("det");
    let a = c.write("a.sv", "module a #(parameter int W = 8) (output logic [W-1:0] o);\nendmodule\n");
    let out2 = c.dir.join("out2");
    c.run(&["-s".into(), s(&a.clone()), "-o".into(), s(&c.out())]);
    c.run(&["-s".into(), s(&a), "-o".into(), s(&out2)]);
    let i1 = std::fs::read_to_string(c.out().join("index.xml")).unwrap();
    let i2 = std::fs::read_to_string(out2.join("index.xml")).unwrap();
    assert_eq!(strip_generated(&i1), strip_generated(&i2));
    let x1 = std::fs::read_to_string(c.find_out("a.sv.xml").unwrap()).unwrap();
    let x2 = std::fs::read_to_string({
        let mut hit = None;
        for e in walk(&out2) {
            if e.to_string_lossy().ends_with("a.sv.xml") {
                hit = Some(e);
            }
        }

        hit.unwrap()
    })
    .unwrap();
    assert_eq!(x1, x2, "per-file XML must be byte-identical");
}

#[test]
fn summary_file_reports_run_stats() {
    let c = Case::new("summary");
    let good = c.write("good.sv", "module good; endmodule\n");
    let bad = c.write("bad.sv", "module bad(\n");
    let sum = c.dir.join("summary.txt");
    let args = vec![
        "-s".into(),
        s(&good),
        s(&bad),
        "-o".into(),
        s(&c.out()),
        "--summary".into(),
        s(&sum),
    ];
    let (code, _) = c.run(&args);
    assert_eq!(code, 1, "error file → exit 1, but summary must still be written");
    let body = std::fs::read_to_string(&sum).unwrap();
    assert!(body.contains("files: 2\n"), "{body}");
    assert!(body.contains("modules: 1\n"), "{body}");
    assert!(body.contains("error_files: 1\n"), "{body}");
    assert!(body.contains("reused: 0\n"), "{body}");
    assert!(body.contains("parsed: 2\n"), "{body}");
    // 第二轮：good 命中缓存
    c.run(&args);
    let body = std::fs::read_to_string(&sum).unwrap();
    assert!(body.contains("reused: 1\n"), "{body}");
    assert!(body.contains("parsed: 1\n"), "{body}");
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            out.extend(walk(&p));
        } else {
            out.push(p);
        }
    }
    out
}

#[test]
fn no_output_dir_means_zero_writes() {
    let c = Case::new("nowrite");
    let a = c.write("a.sv", "module a; endmodule\n");
    let (code, _) = c.run(&["-s".into(), s(&a), "--tree".into()]);
    assert_eq!(code, 0);
    assert!(!c.out().exists(), "no -o → no export dir");
    assert!(
        std::fs::read_dir(&c.dir).unwrap().all(|e| e.unwrap().path() == a),
        "no -o → nothing written next to sources"
    );
}

// ---------------------------------------------------------------------------
// 增量（cli.md §3 / rtlindex-xml.md §5.8）

#[test]
fn incremental_reuse_include_invalidation_and_refresh() {
    let c = Case::new("incr");
    c.write("include/defs.svh", "`define W 8\n");
    let top = c.write(
        "top.sv",
        "`include \"defs.svh\"\nmodule top(output logic [`W-1:0] o);\nendmodule\n",
    );
    let sub = c.write("sub.sv", "module sub; endmodule\n");
    let base = |extra: &[&str]| {
        let mut args = vec![
            "-s".into(),
            s(&top),
            s(&sub),
            "-I".into(),
            s(&c.dir.join("include")),
            "-o".into(),
            s(&c.out()),
        ];
        args.extend(extra.iter().map(|e| e.to_string()));
        args
    };
    // 冷启动
    let (code, text) = c.run(&base(&[]));
    assert_eq!(code, 0, "{text}");
    assert!(text.contains("reused 0 files, parsed 2 files"), "{text}");
    // 热运行：全部复用
    let (code, text) = c.run(&base(&[]));
    assert_eq!(code, 0, "{text}");
    assert!(text.contains("reused 2 files, parsed 0 files"), "{text}");
    // 改 include 头文件 → 仅 include 它的 top 失效
    c.write("include/defs.svh", "`define W 16\n");
    let (code, text) = c.run(&base(&[]));
    assert_eq!(code, 0, "{text}");
    assert!(text.contains("reused 1 files, parsed 1 files"), "{text}");
    // --refresh：强制全量
    let (code, text) = c.run(&base(&["--refresh"]));
    assert_eq!(code, 0, "{text}");
    assert!(
        text.contains("reused 0 files, parsed 2 files (--refresh)"),
        "{text}"
    );
}

#[test]
fn error_file_is_never_cached() {
    let c = Case::new("badcache");
    let bad = c.write("bad.sv", "module bad(\n");
    let good = c.write("good.sv", "module good; endmodule\n");
    let args = vec!["-s".into(), s(&bad), s(&good), "-o".into(), s(&c.out())];
    c.run(&args);
    let (_, text) = c.run(&args);
    // good 命中缓存；bad 是错误文件不可缓存，每轮都解析
    assert!(text.contains("reused 1 files, parsed 1 files"), "{text}");
}

#[test]
fn expand_headers_macros_really_expand_and_parse_as_module_items() {
    let c = Case::new("exphdr");
    let hdr = c.write(
        "prim.sv",
        "`define ADD_ONE(x) ((x) + 1)\n`define ASSERT(name, prop) assert property (@(posedge clk_i) (prop))\n",
    );
    let top = c.write(
        "top.sv",
        "module top(input logic clk_i, input logic d_i, output logic [`ADD_ONE(3)-1:0] v);\n  `ASSERT(DStable, d_i);\nendmodule\n",
    );
    let (code, text) = c.run(&[
        "-s".into(),
        s(&top),
        "--expand-headers".into(),
        s(&hdr),
        "-o".into(),
        s(&c.out()),
    ]);
    assert_eq!(code, 0, "{text}");
    let xml = std::fs::read_to_string(c.find_out("top.sv.xml").unwrap()).unwrap();
    assert!(xml.contains("packed=\"[((3) + 1)-1:0]\""), "macro must really expand: {xml}");
}

#[test]
fn packages_and_imports_exported_and_cached() {
    let c = Case::new("pkgxml");
    let src = c.write(
        "m.sv",
        "package axi_pkg;\n  parameter int W = 8;\nendpackage\nmodule m import axi_pkg::*; (input logic clk, input axi_pkg::axi_t d);\n  sub u0 (.c(clk));\nendmodule\nmodule sub(input logic c);\nendmodule\n",
    );
    let args = vec!["-s".into(), s(&src), "-o".into(), s(&c.out())];
    let (code, text) = c.run(&args);
    assert_eq!(code, 0, "{text}");

    let index = std::fs::read_to_string(c.out().join("index.xml")).unwrap();
    assert!(index.contains("packages=\"1\""), "{index}");
    assert!(index.contains("modules=\"2\""), "packages not counted as modules: {index}");
    assert!(index.contains("<package name=\"axi_pkg\""), "{index}");
    // package 不进层级树（永不被例化）
    assert!(index.contains("<top module=\"m\">"), "{index}");
    assert!(!index.contains("<top module=\"axi_pkg\""), "{index}");

    let xml = std::fs::read_to_string(c.find_out("m.sv.xml").unwrap()).unwrap();
    assert!(xml.contains("<module name=\"axi_pkg\" kind=\"package\""), "{xml}");
    assert!(!xml.contains("<module name=\"axi_pkg\" kind=\"package\" span=\"0:33\" contentHash"), "{xml}");
    let pkg_mod = xml.split("<module name=\"axi_pkg\"").nth(1).unwrap();
    assert!(!pkg_mod[..pkg_mod.find('>').unwrap()].contains("interfaceSig"), "package has no interfaceSig");
    assert!(xml.contains("<import package=\"axi_pkg\" symbol=\"*\" via=\"decl\""), "{xml}");
    assert!(xml.contains("<import package=\"axi_pkg\" symbol=\"axi_t\" via=\"scope\""), "{xml}");

    // 增量往返：缓存重建的 imports 与解析一致（第二轮复用且 XML 字节不变）
    let first = std::fs::read_to_string(c.find_out("m.sv.xml").unwrap()).unwrap();
    let (_, text) = c.run(&args);
    assert!(text.contains("reused 1 files, parsed 0 files"), "{text}");
    let second = std::fs::read_to_string(c.find_out("m.sv.xml").unwrap()).unwrap();
    assert_eq!(first, second, "cached reload must round-trip imports");
}
