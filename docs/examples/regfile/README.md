# Regfile 作者面示例

寄存器 **SoT** 为 TypeScript：`Regfile(...)` 命名导出（`RegfileDef`）。

- 综合示例：[`regfile.ts`](./regfile.ts) + 展示 SV [`sub_module_a_regfile.sv`](./sub_module_a_regfile.sv) / [`sub_module_b_regfile.sv`](./sub_module_b_regfile.sv)
- SoC 冒烟：[`demo/soc/regs/smoke.ts`](../../../demo/soc/regs/smoke.ts) → `smoke_regfile.sv` 由 `soc_wb_system` 挂上总线 + [`smoke_wb.v`](../../../demo/soc/rtl/smoke_wb.v)（仅 sideband glue）；C 字段 layout：`fw/gen/regfile/smoke.h`；地址图：`fw/gen/bus/soc_wb_map.h`（入库展示）；固件：`fw/regfile_smoke`，`./sim/verilator/run.sh --regfile`
- SoC sha256：[`demo/soc/regs/sha256_wb.ts`](../../../demo/soc/regs/sha256_wb.ts) → 一份 `sha256_regfile`，bus `SlaveRegfile(sha256, …, { id })` ×2 进 wrapper；C：`fw/gen/regfile/sha256.h`；[`sha256_wb_regs.v`](../../../demo/soc/rtl/sha256_wb_regs.v) + `sha256wb` 仅 AXIS/core glue
- Excel：`[plugins.regfile] export=` 一份工作簿，每表一 sheet（主干列；无空列 A / `ADDRWIDTH`）
- DSL：[`src/plugins/wishbone-regfile/dsl.ts`](../../../src/plugins/wishbone-regfile/dsl.ts)
- 契约：[`../../plugins/wishbone-regfile.md`](../../plugins/wishbone-regfile.md)

generate + analysis 后用 **`<aw-inst mod="…_regfile">`**（或薄 WB 包装）；**无** HTML 寄存器桩。

```bash
bun test test/wishbone-regfile.test.ts
cd demo/soc && bun ../../index.ts plugin generate wishbone-regfile
```
