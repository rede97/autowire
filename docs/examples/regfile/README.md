# Regfile 作者面示例

寄存器 **SoT** 为 TypeScript：`Regfile(...)` 命名导出（`RegfileDef`）。

- SoT：[`regfile.ts`](./regfile.ts)（同文件可多个：`sub_module_a` / `sub_module_b`）
- 生成展示：[`sub_module_a_regfile.sv`](./sub_module_a_regfile.sv)、[`sub_module_b_regfile.sv`](./sub_module_b_regfile.sv)
- DSL：[`src/plugins/wishbone-regfile/dsl.ts`](../../../src/plugins/wishbone-regfile/dsl.ts)
- 契约：[`../../plugins/wishbone-regfile.md`](../../plugins/wishbone-regfile.md)

正式产物进 `[dump] plugins_dir/wishbone-regfile/`；本目录 `.sv` 仅作示例展示。

```toml
[regfile.examples]
ts = "docs/examples/regfile/regfile.ts"
# exports = ["sub_module_a"]   # 可选；省略 = 全部 RegfileDef
```

```bash
bun index.ts plugin generate wishbone-regfile
```

可选 HTML 桩 `<awx-regfile value="sub_module_a">` 的 `value` = **export 绑定名**（与 toml source id 无关）。
