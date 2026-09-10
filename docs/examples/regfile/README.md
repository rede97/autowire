# Regfile 作者面示例

寄存器 **SoT** 为 TypeScript：`Regfile(...)` 命名导出（`RegfileDef`）。

- 综合示例：[`regfile.ts`](./regfile.ts) + 展示 SV [`sub_module_a_regfile.sv`](./sub_module_a_regfile.sv) / [`sub_module_b_regfile.sv`](./sub_module_b_regfile.sv)
- 功能点冒烟：[`smoke.ts`](./smoke.ts)（RC / RO / RW / RWW / RWE / W1P / W1C / Shadow / 宽 field）
- SoC：[`demo/soc/regs/sha256_wb.ts`](../../../demo/soc/regs/sha256_wb.ts) → [`sha256_wb_regfile.sv`](../../../demo/soc/rtl/sha256_wb_regfile.sv)
- DSL：[`src/plugins/wishbone-regfile/dsl.ts`](../../../src/plugins/wishbone-regfile/dsl.ts)
- 契约：[`../../plugins/wishbone-regfile.md`](../../plugins/wishbone-regfile.md)

```bash
bun test test/wishbone-regfile.test.ts   # 含 smoke features + sha256 SoT
bun index.ts plugin generate wishbone-regfile   # 需 toml [regfile.*] ts=
```
