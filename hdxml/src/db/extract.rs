//! 事件流提取器：Enter/Leave 窗口 + Locate span 切片。
//! 名称用节点字段直取（XxxIdentifier.nodes.0），文本用窗口 min/max offset 切原文。

use super::{
    ExprText, InstanceInfo, ModKind, ModuleDecl, ParamConn, ParamInfo, ParamKind, PortDir, PortInfo,
    short_hash,
};
use std::path::Path;
use sv_parser::{Identifier, Locate, NodeEvent, RefNode, SyntaxTree};

/// 窗口：收集其间所有 token 的 min/max 偏移
#[derive(Clone, Copy)]
struct Win {
    lo: usize,
    hi: usize,
    set: bool,
}

impl Win {
    fn new() -> Self {
        Self {
            lo: usize::MAX,
            hi: 0,
            set: false,
        }
    }
    fn feed(&mut self, l: &Locate) {
        self.set = true;
        self.lo = self.lo.min(l.offset);
        self.hi = self.hi.max(l.offset + l.len);
    }
    fn text<'a>(&self, src: &'a str) -> Option<&'a str> {
        self.set.then(|| src[self.lo..self.hi].trim())
    }
    fn span(&self) -> [usize; 2] {
        [self.lo, self.hi]
    }
}

fn ident_text(src: &str, id: &Identifier) -> String {
    match id {
        Identifier::SimpleIdentifier(s) => s.nodes.0.str(src).to_string(),
        Identifier::EscapedIdentifier(e) => e.nodes.0.str(src).trim().to_string(),
    }
}

/// 通用文本捕获窗口的标签
#[derive(Clone, Copy, PartialEq)]
enum Cap {
    PackedDim,
    UnpackedDim,
    DataType,
    /// 默认/覆盖值表达式（维度窗口开启时不捕获）
    Expr,
    /// 参数连接（NamedParameterAssignment/OrderedParameterAssignment 整体文本，取参数名用）
    ParamConn,
}

#[derive(Default)]
struct ModB {
    kind: ModKind,
    name: String,
    win: Win,
    params: Vec<ParamInfo>,
    ports: Vec<PortInfo>,
    instances: Vec<InstanceInfo>,
}

impl Default for Win {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Default)]
struct PortB {
    names: Vec<String>,
    dir: Option<PortDir>,
    data_type: Option<String>,
    interface: Option<String>,
    modport: Option<String>,
    packed: Vec<ExprText>,
    unpacked: Vec<ExprText>,
    default: Option<ExprText>,
    win: Win,
}

#[derive(Default)]
struct ParamB {
    name: String,
    kind: ParamKind,
    data_type: Option<String>,
    unpacked: Vec<ExprText>,
    default: Option<ExprText>,
    win: Win,
}

#[derive(Default)]
struct InstB {
    target: String,
    params: Vec<ParamConn>,
    /// 当前参数连接的表达式值（嵌套 Expr 窗口在 ParamConn 收尾前写入）
    pending_value: Option<String>,
    win: Win,
}

#[derive(Default)]
struct HierB {
    name: String,
    win: Win,
}

enum Frame {
    Mod(ModB),
    /// ParameterDeclaration/LocalParameterDeclaration 窗口（kind 适用于其内全部 assignment）
    ParamDecl {
        kind: ParamKind,
        dtype: Option<String>,
    },
    ParamAssign(ParamB),
    Port(PortB),
    Inst(InstB),
    Hier(HierB),
    Cap(Cap, Win),
}

pub struct Extractor<'a> {
    src: &'a str,
    stack: Vec<Frame>,
    pub modules: Vec<ModuleDecl>,
}

impl<'a> Extractor<'a> {
    pub fn new(src: &'a str) -> Self {
        Self {
            src,
            stack: Vec::new(),
            modules: Vec::new(),
        }
    }

    /// 最近的模块帧
    fn cur_mod(&mut self) -> Option<&mut ModB> {
        self.stack.iter_mut().rev().find_map(|f| match f {
            Frame::Mod(m) => Some(m),
            _ => None,
        })
    }

    /// 最近的端口帧
    fn cur_port(&mut self) -> Option<&mut PortB> {
        self.stack.iter_mut().rev().find_map(|f| match f {
            Frame::Port(p) => Some(p),
            _ => None,
        })
    }

    fn cur_param(&mut self) -> Option<&mut ParamB> {
        self.stack.iter_mut().rev().find_map(|f| match f {
            Frame::ParamAssign(p) => Some(p),
            _ => None,
        })
    }

    fn cur_inst(&mut self) -> Option<&mut InstB> {
        self.stack.iter_mut().rev().find_map(|f| match f {
            Frame::Inst(i) => Some(i),
            _ => None,
        })
    }

    fn cur_hier(&mut self) -> Option<&mut HierB> {
        self.stack.iter_mut().rev().find_map(|f| match f {
            Frame::Hier(h) => Some(h),
            _ => None,
        })
    }

    /// 维度窗口是否开启（开启时抑制 Expr 捕获——维度内含 ConstantExpression）
    fn dim_open(&self) -> bool {
        self.stack
            .iter()
            .any(|f| matches!(f, Frame::Cap(Cap::PackedDim | Cap::UnpackedDim, _)))
    }

    fn in_param_decl(&self) -> bool {
        self.stack
            .iter()
            .any(|f| matches!(f, Frame::ParamDecl { .. } | Frame::ParamAssign(_)))
    }

    fn feed_locate(&mut self, l: &Locate) {
        for f in &mut self.stack {
            match f {
                Frame::Mod(m) => m.win.feed(l),
                Frame::ParamAssign(p) => p.win.feed(l),
                Frame::Port(p) => p.win.feed(l),
                Frame::Inst(i) => i.win.feed(l),
                Frame::Hier(h) => h.win.feed(l),
                Frame::Cap(_, w) => w.feed(l),
                Frame::ParamDecl { .. } => {}
            }
        }
    }

    fn enter(&mut self, node: RefNode<'a>) {
        match node {
            RefNode::ModuleDeclarationAnsi(_)
            | RefNode::ModuleDeclarationNonansi(_)
            | RefNode::ModuleDeclarationWildcard(_) => {
                self.stack.push(Frame::Mod(ModB {
                    kind: ModKind::Module,
                    ..Default::default()
                }));
            }
            RefNode::InterfaceDeclarationAnsi(_)
            | RefNode::InterfaceDeclarationNonansi(_)
            | RefNode::InterfaceDeclarationWildcard(_) => {
                self.stack.push(Frame::Mod(ModB {
                    kind: ModKind::Interface,
                    ..Default::default()
                }));
            }
            RefNode::ModuleDeclaration(m) => {
                // enum 级事件先于具体变体到达，此处仅补名字兜底（变体事件会建帧）
                let _ = m;
            }
            RefNode::ParameterDeclaration(_) => {
                self.stack.push(Frame::ParamDecl {
                    kind: ParamKind::Parameter,
                    dtype: None,
                });
            }
            RefNode::LocalParameterDeclaration(_) => {
                self.stack.push(Frame::ParamDecl {
                    kind: ParamKind::Localparam,
                    dtype: None,
                });
            }
            RefNode::ParamAssignment(pa) => {
                let (kind, dtype) = self
                    .stack
                    .iter()
                    .rev()
                    .find_map(|f| match f {
                        Frame::ParamDecl { kind, dtype } => Some((*kind, dtype.clone())),
                        _ => None,
                    })
                    .unwrap_or((ParamKind::Parameter, None));
                let mut b = ParamB {
                    kind,
                    data_type: dtype,
                    ..Default::default()
                };
                b.name = ident_text(self.src, &pa.nodes.0.nodes.0);
                self.stack.push(Frame::ParamAssign(b));
            }
            RefNode::TypeAssignment(ta) => {
                // parameter type T = int
                let name = ident_text(self.src, &ta.nodes.0.nodes.0);
                let win = Win::new();
                self.stack.push(Frame::ParamAssign(ParamB {
                    name,
                    kind: ParamKind::Type,
                    win,
                    ..Default::default()
                }));
            }
            RefNode::AnsiPortDeclaration(_) => {
                self.stack.push(Frame::Port(PortB::default()));
            }
            RefNode::PortDeclaration(pd) => {
                use sv_parser::PortDeclaration as PD;
                let dir = match pd {
                    PD::Inout(_) => Some(PortDir::Inout),
                    PD::Input(_) => Some(PortDir::Input),
                    PD::Output(_) => Some(PortDir::Output),
                    PD::Ref(_) => Some(PortDir::Ref),
                    PD::Interface(_) => Some(PortDir::Interface),
                };
                self.stack.push(Frame::Port(PortB {
                    dir,
                    ..Default::default()
                }));
            }
            RefNode::PortDirection(pd) => {
                use sv_parser::PortDirection as D;
                let dir = match pd {
                    D::Input(_) => PortDir::Input,
                    D::Output(_) => PortDir::Output,
                    D::Inout(_) => PortDir::Inout,
                    D::Ref(_) => PortDir::Ref,
                };
                if let Some(p) = self.cur_port()
                    && p.dir.is_none()
                {
                    p.dir = Some(dir);
                }
            }
            RefNode::PortIdentifier(id) => {
                let name = ident_text(self.src, &id.nodes.0);
                if let Some(p) = self.cur_port() {
                    p.names.push(name);
                }
            }
            RefNode::InterfaceIdentifier(id) => {
                let t = ident_text(self.src, &id.nodes.0);
                // 端口声明窗口内 → 端口的 interface 类型；否则若在接口声明帧 → 接口名
                if let Some(p) = self.cur_port() {
                    if p.interface.is_none() {
                        p.interface = Some(t);
                    }
                } else if let Some(m) = self.cur_mod()
                    && m.kind == ModKind::Interface
                    && m.name.is_empty()
                {
                    m.name = t;
                }
            }
            RefNode::ModportIdentifier(id) => {
                let t = ident_text(self.src, &id.nodes.0);
                if let Some(p) = self.cur_port()
                    && p.modport.is_none()
                {
                    p.modport = Some(t);
                }
            }
            RefNode::PackedDimension(_) => self.stack.push(Frame::Cap(Cap::PackedDim, Win::new())),
            RefNode::UnpackedDimension(_) | RefNode::VariableDimension(_) => {
                self.stack.push(Frame::Cap(Cap::UnpackedDim, Win::new()))
            }
            RefNode::DataType(_) | RefNode::DataTypeOrImplicit(_) => {
                self.stack.push(Frame::Cap(Cap::DataType, Win::new()))
            }
            RefNode::ConstantExpression(_) | RefNode::ConstantParamExpression(_) => {
                // 参数/端口默认值、实例参数覆盖值（维度内表达式已被 dim_open 抑制）
                if !self.dim_open()
                    && (self.in_param_decl() || self.in_port_decl() || self.in_param_conn())
                {
                    self.stack.push(Frame::Cap(Cap::Expr, Win::new()));
                }
            }
            RefNode::ParamExpression(_) => {
                // 实例参数覆盖的表达式节点（NamedParameterAssignment 内不是 ConstantExpression）
                if !self.dim_open() && self.in_param_conn() {
                    self.stack.push(Frame::Cap(Cap::Expr, Win::new()));
                }
            }
            RefNode::ModuleInstantiation(_) | RefNode::InterfaceInstantiation(_) => {
                self.stack.push(Frame::Inst(InstB::default()));
            }
            RefNode::HierarchicalInstance(_) => {
                self.stack.push(Frame::Hier(HierB::default()));
            }
            RefNode::InstanceIdentifier(id) => {
                let t = ident_text(self.src, &id.nodes.0);
                if let Some(h) = self.cur_hier()
                    && h.name.is_empty()
                {
                    h.name = t;
                }
            }
            RefNode::ModuleIdentifier(id) => {
                let name = ident_text(self.src, &id.nodes.0);
                // 实例化窗口内 → 目标模块名；模块声明帧内 → 模块名
                if let Some(i) = self.cur_inst()
                    && i.target.is_empty()
                {
                    i.target = name;
                    return;
                }
                if let Some(m) = self.cur_mod()
                    && m.name.is_empty()
                {
                    m.name = name;
                }
            }
            RefNode::NamedParameterAssignment(_) | RefNode::OrderedParameterAssignment(_) => {
                self.stack.push(Frame::Cap(Cap::ParamConn, Win::new()));
            }
            RefNode::Locate(l) => self.feed_locate(l),
            _ => {}
        }
    }

    fn in_port_decl(&self) -> bool {
        self.stack.iter().any(|f| matches!(f, Frame::Port(_)))
    }

    /// 是否处于实例参数连接窗口内（覆盖值表达式需要捕获）
    fn in_param_conn(&self) -> bool {
        self.stack
            .iter()
            .any(|f| matches!(f, Frame::Cap(Cap::ParamConn, _)))
    }

    fn leave(&mut self, node: RefNode<'a>) {
        match node {
            RefNode::ModuleDeclarationAnsi(_)
            | RefNode::ModuleDeclarationNonansi(_)
            | RefNode::ModuleDeclarationWildcard(_)
            | RefNode::InterfaceDeclarationAnsi(_)
            | RefNode::InterfaceDeclarationNonansi(_)
            | RefNode::InterfaceDeclarationWildcard(_) => {
                if let Some(Frame::Mod(m)) = self.stack.pop() {
                    self.finish_module(m);
                }
            }
            RefNode::ParameterDeclaration(_) | RefNode::LocalParameterDeclaration(_) => {
                if matches!(self.stack.last(), Some(Frame::ParamDecl { .. })) {
                    self.stack.pop();
                }
            }
            RefNode::ParamAssignment(_) | RefNode::TypeAssignment(_) => {
                if let Some(Frame::ParamAssign(p)) = self.stack.pop() {
                    let span = p.win.span();
                    if let Some(m) = self.cur_mod() {
                        m.params.push(ParamInfo {
                            name: p.name,
                            kind: p.kind,
                            data_type: p.data_type,
                            default: p.default,
                            span,
                        });
                    }
                }
            }
            RefNode::AnsiPortDeclaration(_) | RefNode::PortDeclaration(_) => {
                if let Some(Frame::Port(p)) = self.stack.pop() {
                    let span = p.win.span();
                    if let Some(m) = self.cur_mod() {
                        for name in &p.names {
                            m.ports.push(PortInfo {
                                name: name.clone(),
                                dir: p.dir,
                                data_type: p.data_type.clone(),
                                interface: p.interface.clone(),
                                modport: p.modport.clone(),
                                packed: p.packed.clone(),
                                unpacked: p.unpacked.clone(),
                                default: p.default.clone(),
                                span,
                            });
                        }
                    }
                }
            }
            RefNode::ModuleInstantiation(_) | RefNode::InterfaceInstantiation(_) => {
                // HierarchicalInstance 已在各自 leave 时产出 InstanceInfo
                if matches!(self.stack.last(), Some(Frame::Inst(_))) {
                    self.stack.pop();
                }
            }
            RefNode::HierarchicalInstance(_) => {
                if let Some(Frame::Hier(h)) = self.stack.pop() {
                    let target = self
                        .stack
                        .iter()
                        .rev()
                        .find_map(|f| match f {
                            Frame::Inst(i) => Some(i.target.clone()),
                            _ => None,
                        })
                        .unwrap_or_default();
                    let params = self
                        .stack
                        .iter()
                        .rev()
                        .find_map(|f| match f {
                            Frame::Inst(i) => Some(i.params.clone()),
                            _ => None,
                        })
                        .unwrap_or_default();
                    if let Some(m) = self.cur_mod()
                        && !target.is_empty()
                    {
                        m.instances.push(InstanceInfo {
                            inst: h.name,
                            target,
                            params,
                            span: h.win.span(),
                        });
                    }
                }
            }
            RefNode::PackedDimension(_) => self.pop_cap(Cap::PackedDim),
            RefNode::UnpackedDimension(_) | RefNode::VariableDimension(_) => {
                self.pop_cap(Cap::UnpackedDim)
            }
            RefNode::DataType(_) | RefNode::DataTypeOrImplicit(_) => self.pop_cap(Cap::DataType),
            RefNode::ConstantExpression(_)
            | RefNode::ConstantParamExpression(_)
            | RefNode::ParamExpression(_) => {
                if matches!(self.stack.last(), Some(Frame::Cap(Cap::Expr, _))) {
                    self.pop_cap(Cap::Expr);
                }
            }
            RefNode::NamedParameterAssignment(_) | RefNode::OrderedParameterAssignment(_) => {
                self.pop_cap(Cap::ParamConn)
            }
            _ => {}
        }
    }

    fn pop_cap(&mut self, cap: Cap) {
        if !matches!(self.stack.last(), Some(Frame::Cap(c, _)) if *c == cap) {
            return;
        }
        let Some(Frame::Cap(_, win)) = self.stack.pop() else {
            return;
        };
        let Some(text) = win.text(self.src) else {
            return;
        };
        match cap {
            Cap::PackedDim => {
                if let Some(p) = self.cur_port() {
                    p.packed.push(ExprText::new(strip_brackets(text)));
                }
            }
            Cap::UnpackedDim => {
                if let Some(p) = self.cur_port() {
                    p.unpacked.push(ExprText::new(strip_brackets(text)));
                } else if let Some(p) = self.cur_param() {
                    p.unpacked.push(ExprText::new(strip_brackets(text)));
                }
            }
            Cap::DataType => {
                if let Some(p) = self.cur_port() {
                    if p.data_type.is_none() {
                        p.data_type = Some(text.to_string());
                    }
                } else if self.in_param_decl() {
                    // 写到最近的 ParamDecl 帧（其内全部 assignment 共享）
                    for f in self.stack.iter_mut().rev() {
                        if let Frame::ParamDecl { dtype, .. } = f {
                            if dtype.is_none() {
                                *dtype = Some(text.to_string());
                            }
                            break;
                        }
                    }
                }
            }
            Cap::Expr => {
                // 实例参数覆盖值：写入 InstB.pending_value，ParamConn 收尾时取用
                if self.in_param_conn() {
                    if let Some(i) = self.cur_inst() {
                        i.pending_value = Some(text.to_string());
                    }
                    return;
                }
                let e = ExprText::new(text);
                if let Some(p) = self.cur_param()
                    && p.default.is_none()
                {
                    p.default = Some(e);
                    return;
                }
                if let Some(p) = self.cur_port()
                    && p.default.is_none()
                {
                    p.default = Some(e);
                }
            }
            Cap::ParamConn => {
                let name = parse_conn_name(text);
                if let Some(i) = self.cur_inst() {
                    let value = i.pending_value.take().unwrap_or_default();
                    i.params.push(ParamConn { name, value });
                }
            }
        }
    }

    fn finish_module(&mut self, m: ModB) {
        if m.name.is_empty() {
            return;
        }
        // content_hash 与 span 严格对应：原始切片（不 trim），--check 无需解析即可复算
        // span 基准 = 预处理后文本（宏/include 已展开）；越界意味着提取器 bug，告警并截断
        let span = m.win.span();
        if span[1] > self.src.len() {
            eprintln!(
                "警告: 模块 {} span {:?} 超出预处理后文本长度 {}",
                m.name,
                span,
                self.src.len()
            );
        }
        let hi = span[1].min(self.src.len());
        let text = if m.win.set {
            &self.src[span[0]..hi]
        } else {
            ""
        };
        let mut decl = ModuleDecl {
            name: m.name,
            kind: m.kind,
            file: Path::new("").to_path_buf(), // 调用方回填
            span,
            params: m.params,
            ports: m.ports,
            instances: m.instances,
            content_hash: short_hash(text.as_bytes()),
            interface_sig: String::new(),
        };
        decl.interface_sig = decl.compute_sig();
        self.modules.push(decl);
    }

    pub fn run(mut self, tree: &'a SyntaxTree) -> Vec<ModuleDecl> {
        for ev in tree.into_iter().event() {
            match ev {
                NodeEvent::Enter(n) => self.enter(n),
                NodeEvent::Leave(n) => self.leave(n),
            }
        }
        self.modules
    }
}

/// "[W-1:0]" → "W-1:0"
fn strip_brackets(s: &str) -> &str {
    s.strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(s)
}

/// 从连接文本提取名字：".clk(clk)" → Some("clk")；位置连接 → None
fn parse_conn_name(text: &str) -> Option<String> {
    let t = text.strip_prefix('.')?;
    let name: String = t
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '$')
        .collect();
    (!name.is_empty()).then_some(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::io::Write;

    /// 写入临时文件并提取（每用例独立路径，可并行）；两阶段与 analyze_files 一致
    fn extract_src(name: &str, src: &str) -> (Vec<ModuleDecl>, String) {
        let dir = std::env::temp_dir().join(format!("hdxml_test_{name}_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{name}.sv"));
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(src.as_bytes()).unwrap();
        drop(f);
        let defines = HashMap::new();
        let (pp, pp_defines) =
            sv_parser::preprocess(&path, &defines, &[] as &[&Path], false, false)
                .expect("测试源预处理失败");
        let pp_text = pp.text().to_string();
        let (tree, _) = sv_parser::parse_sv_pp(pp, pp_defines, false).expect("测试源解析失败");
        let mods = Extractor::new(&pp_text).run(&tree);
        (mods, pp_text)
    }

    #[test]
    fn content_hash_matches_span_slice() {
        let src = "module m(input logic clk);\nendmodule\n";
        let (mods, src) = extract_src("hash_consistency", src);
        assert_eq!(mods.len(), 1);
        let m = &mods[0];
        let slice = &src[m.span[0]..m.span[1]];
        assert_eq!(
            short_hash(slice.as_bytes()),
            m.content_hash,
            "span 切片哈希必须等于 content_hash；slice={slice:?}"
        );
    }

    #[test]
    fn parameterized_ports_and_deps() {
        let src = r#"module fifo #(parameter int W = 8, parameter type T = logic [W-1:0]) (
  input logic clk,
  input T din,
  output logic [W-1:0] dout,
  axi_if.slave s_axi
);
  sub #(.W(W)) u_sub (.clk(clk), .din(din), .dout(dout));
endmodule
"#;
        let (mods, _) = extract_src("fifo", src);
        assert_eq!(mods.len(), 1);
        let m = &mods[0];
        assert_eq!(m.name, "fifo");
        assert_eq!(m.params.len(), 2);
        assert_eq!(m.params[0].name, "W");
        assert_eq!(m.params[0].kind, ParamKind::Parameter);
        assert_eq!(m.params[0].default.as_ref().unwrap().text, "8");
        assert_eq!(m.params[1].kind, ParamKind::Type);
        assert_eq!(m.ports.len(), 4);
        assert_eq!(m.ports[0].dir, Some(PortDir::Input));
        assert_eq!(m.ports[2].packed[0].text, "W-1:0");
        assert_eq!(m.ports[2].packed[0].deps, vec!["W"]);
        assert_eq!(m.ports[3].interface.as_deref(), Some("axi_if"));
        assert_eq!(m.ports[3].modport.as_deref(), Some("slave"));
        assert_eq!(m.instances.len(), 1);
        assert_eq!(m.instances[0].target, "sub");
        assert_eq!(m.instances[0].inst, "u_sub");
        assert_eq!(m.instances[0].params[0].name.as_deref(), Some("W"));
        assert_eq!(m.instances[0].params[0].value, "W");
    }

    #[test]
    fn inst_param_values_strip_wrappers_and_comments() {
        let src = r#"module top;
  sub #(.IS_FUNCTIONAL(1) // The gate is required to prevent glitches
        ) u0 ();
  sub #(8, 16) u1 ();
endmodule
"#;
        let (mods, _) = extract_src("top", src);
        let m = &mods[0];
        assert_eq!(m.instances[0].params[0].name.as_deref(), Some("IS_FUNCTIONAL"));
        assert_eq!(m.instances[0].params[0].value, "1");
        assert_eq!(m.instances[1].params[0].name, None);
        assert_eq!(m.instances[1].params[0].value, "8");
        assert_eq!(m.instances[1].params[1].value, "16");
    }

    #[test]
    fn interface_sig_format_insensitive_content_sensitive() {
        let a = "module m(input logic [7:0] d);\nendmodule\n";
        let b = "module m(\n  input   logic [7:0] d\n);\nendmodule\n";
        let c = "module m(input logic [8:0] d);\nendmodule\n";
        let sig = |s: &str| extract_src("sig", s).0[0].interface_sig.clone();
        assert_eq!(sig(a), sig(b), "空白差异不应改变签名");
        assert_ne!(sig(a), sig(c), "位宽差异必须改变签名");
    }

    #[test]
    fn raw_macro_sentinel_kept_in_port_dims() {
        // keep_raw 链路：--keep-raw WIDTH → 哨兵展开 → 维度与 deps 含哨兵名（dump 时还原 `WIDTH）
        let src = "module m(output logic [`WIDTH-1:0] o);\nendmodule\n";
        let dir = std::env::temp_dir().join(format!("hdxml_test_raw_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("raw.sv");
        std::fs::write(&path, src).unwrap();
        let defines =
            crate::db::build_defines(&[], &["WIDTH".to_string()]).unwrap();
        let (pp, pp_defines) =
            sv_parser::preprocess(&path, &defines, &[] as &[&Path], false, false)
                .expect("预处理失败");
        let pp_text = pp.text().to_string();
        assert!(
            pp_text.contains(crate::db::MACRO_RAW_PREFIX),
            "预处理文本必须含哨兵: {pp_text}"
        );
        let (tree, _) = sv_parser::parse_sv_pp(pp, pp_defines, false).expect("解析失败");
        let mods = Extractor::new(&pp_text).run(&tree);
        let p = &mods[0].ports[0];
        assert_eq!(
            p.packed[0].text,
            format!("{}-1:0", crate::db::MACRO_RAW_PREFIX.to_string() + "WIDTH"),
            "维度必须保留哨兵: {:?}",
            p.packed[0].text
        );
        assert_eq!(
            p.packed[0].deps,
            vec![format!("{}WIDTH", crate::db::MACRO_RAW_PREFIX)],
            "deps 必须含哨兵名"
        );
    }
}
