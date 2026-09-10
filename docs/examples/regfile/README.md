# Regfile 作者面示例

寄存器 **SoT** 为 TypeScript：`Regfile(...)` 命名导出（`RegfileDef`）。

- 综合示例：[`regfile.ts`](./regfile.ts) + 展示 SV [`sub_module_a_regfile.sv`](./sub_module_a_regfile.sv) / [`sub_module_b_regfile.sv`](./sub_module_b_regfile.sv)
- SoC 冒烟：[`demo/soc/regs/smoke.ts`](../../../demo/soc/regs/smoke.ts) → `gen/plugins/wishbone-regfile/smoke_regfile.sv` + [`smoke_wb.v`](../../../demo/soc/rtl/smoke_wb.v)（RWW 计数器 / RWE FIFO loopback）；C：`fw/regfile_smoke`，`./sim/verilator/run.sh --regfile`
- SoC sha256：[`demo/soc/regs/sha256_wb.ts`](../../../demo/soc/regs/sha256_wb.ts) → `gen/plugins/wishbone-regfile/sha256_wb_regfile.sv` + [`sha256_wb_regs.v`](../../../demo/soc/rtl/sha256_wb_regs.v)
- DSL：[`src/plugins/wishbone-regfile/dsl.ts`](../../../src/plugins/wishbone-regfile/dsl.ts)
- 契约：[`../../plugins/wishbone-regfile.md`](../../plugins/wishbone-regfile.md)

generate + analysis 后用 **`<aw-inst mod="…_regfile">`**（或薄 WB 包装）；**无** HTML 寄存器桩。

```bash
bun test test/wishbone-regfile.test.ts
cd demo/soc && bun ../../index.ts plugin generate wishbone-regfile
```
