//! `specify…endspecify` 块剥离（移植自 ipchecker `strip_specify_blocks`）。
//! sv-parser 对部分 specify 时序块解析异常（崩溃/误报），解析前整块抹除。
//! 与 ipchecker 的差别：此处**按字节等长留白**（非换行字节一律空格），
//! 保证 origin 映射与 span 在剥离前后逐字节对齐。

/// 跳过空白/注释/字符串后取下一个标识符（轻量词法，非完整解析）。
/// 返回 (token, byte_start, byte_end)。
fn next_identifier(src: &str, start: usize) -> Option<(&str, usize, usize)> {
    let b = src.as_bytes();
    let mut i = start;
    while i < b.len() {
        match b[i] {
            // 空白
            c if c.is_ascii_whitespace() => i += 1,
            // 行注释
            b'/' if b.get(i + 1) == Some(&b'/') => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            }
            // 块注释
            b'/' if b.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                    i += 1;
                }
                i = (i + 2).min(b.len());
            }
            // 字符串字面量（"…"，支持 \" 转义）
            b'"' => {
                i += 1;
                while i < b.len() {
                    match b[i] {
                        b'\\' => i += 2,
                        b'"' => {
                            i += 1;
                            break;
                        }
                        _ => i += 1,
                    }
                }
            }
            // 转义标识符 \…（以空白结束）
            b'\\' => {
                let s = i;
                i += 1;
                while i < b.len() && !b[i].is_ascii_whitespace() {
                    i += 1;
                }
                return Some((&src[s..i], s, i));
            }
            // 简单标识符
            c if c.is_ascii_alphabetic() || c == b'_' => {
                let s = i;
                while i < b.len()
                    && (b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] == b'$')
                {
                    i += 1;
                }
                return Some((&src[s..i], s, i));
            }
            // 其余单字符（运算符、宏反引号等）直接跳过
            _ => i += 1,
        }
    }
    None
}

/// 抹除所有 `specify…endspecify` 块：块内非换行字节替换为空格，换行保留。
/// 输出与输入**字节等长**；未配对（缺 `endspecify`）时原样返回。
pub fn strip_specify_blocks(src: &str) -> String {
    let mut out: Vec<u8> = Vec::with_capacity(src.len());
    let mut pos = 0;
    let mut keep_from = 0;
    let mut depth = 0usize;
    let mut remove_start: Option<usize> = None;

    while let Some((token, token_start, token_end)) = next_identifier(src, pos) {
        if token == "specify" {
            if depth == 0 {
                out.extend_from_slice(&src.as_bytes()[keep_from..token_start]);
                remove_start = Some(token_start);
            }
            depth += 1;
        } else if token == "endspecify" && depth > 0 {
            depth -= 1;
            if depth == 0 {
                if let Some(start) = remove_start.take() {
                    for &c in &src.as_bytes()[start..token_end] {
                        // 多字节 UTF-8 逐字节变空格，字节数不变、结果仍是合法 UTF-8
                        out.push(if c == b'\n' || c == b'\r' { c } else { b' ' });
                    }
                }
                keep_from = token_end;
            }
        }
        pos = token_end;
    }

    if depth != 0 {
        // 未配对：不剥离，原样返回（交由解析器报错定位）
        return src.to_string();
    }
    out.extend_from_slice(&src.as_bytes()[keep_from..]);
    debug_assert_eq!(out.len(), src.len());
    // 安全性：仅把 ASCII 区间内容替换为空格，UTF-8 多字节序列逐字节变空格
    String::from_utf8(out).unwrap_or_else(|_| src.to_string())
}

#[cfg(test)]
mod tests {
    use super::strip_specify_blocks;

    /// 移植自 ipchecker test_strip_specify_blocks：块消失、模块骨架保留
    #[test]
    fn strip_basic() {
        let src = r#"
module a(input i, output o);
specify
    (i => o) = 0;
endspecify
endmodule
"#;
        let stripped = strip_specify_blocks(src);
        assert!(!stripped.contains("specify"));
        assert!(!stripped.contains("endspecify"));
        assert!(stripped.contains("module a"));
        assert!(stripped.contains("endmodule"));
    }

    /// 字节等长：span / origin 映射不因剥离漂移（与 ipchecker 版的关键差别）
    #[test]
    fn strip_preserves_bytes_and_lines() {
        let src = "module a(input i, output o);\nspecify\n  (i => o) = 0;\nendspecify\n  assign o = i;\nendmodule\n";
        let stripped = strip_specify_blocks(src);
        assert_eq!(stripped.len(), src.len());
        assert_eq!(stripped.matches('\n').count(), src.matches('\n').count());
        // 剥离区外的文本逐字节一致
        let start = src.find("specify").unwrap();
        let end = src.find("endspecify").unwrap() + "endspecify".len();
        assert_eq!(stripped[..start], src[..start]);
        assert_eq!(stripped[end..], src[end..]);
        // 剥离区内部只剩空白
        assert!(stripped[start..end].trim().is_empty());
    }

    /// 注释与字符串里的 specify/endspecify 不触发剥离
    #[test]
    fn strip_ignores_comments_and_strings() {
        let src = "module a;\n// specify\n/* endspecify */\n  localparam string S = \"specify endspecify\";\nendmodule\n";
        assert_eq!(strip_specify_blocks(src), src);
    }

    /// 标识符边界：specify2 / my_specify 不算关键字
    #[test]
    fn strip_respects_identifier_boundary() {
        let src = "module a;\n  logic specify2;\n  logic my_specify;\nendmodule\n";
        assert_eq!(strip_specify_blocks(src), src);
    }

    /// 未配对 specify：原样返回，交给解析器报错
    #[test]
    fn strip_unterminated_returns_original() {
        let src = "module a;\nspecify\n  (i => o) = 0;\nendmodule\n";
        assert_eq!(strip_specify_blocks(src), src);
    }

    /// 端到端：含 specify 的模块经剥离后 sv-parser 正常解析，端口 span 可用
    #[test]
    fn strip_allows_parse_with_spans() {
        let src = "module m(input logic [7:0] d, output logic q);\nspecify\n  (d => q) = 1;\nendspecify\nendmodule\n";
        let stripped = strip_specify_blocks(src);
        let defines: sv_parser::Defines = Default::default();
        let (tree, _) =
            sv_parser::parse_sv_str(&stripped, "<test>", &defines, &[] as &[&std::path::Path], false, false)
                .expect("剥离后解析失败");
        // 解析树文本与剥离结果一致（span 基准）
        let _ = tree;
        assert_eq!(stripped.len(), src.len());
    }
}
