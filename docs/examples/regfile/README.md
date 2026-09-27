# Regfile 作者面示例

寄存器 **SoT** 为 TypeScript：`Regfile(...)` 命名导出（`RegfileDef`）。

- 综合示例：[`regfile.ts`](./regfile.ts) + 展示 SV [`sub_module_a_regfile.sv`](./sub_module_a_regfile.sv) / [`sub_module_b_regfile.sv`](./sub_module_b_regfile.sv)
- SoC 冒烟：[`demo/soc/sot/wb_reg_smoke.ts`](../../../demo/soc/sot/wb_reg_smoke.ts) → `smoke_regfile.sv` 由 `soc_wb_system` 挂上总线 + [`smoke_wb.v`](../../../demo/soc/rtl/smoke_wb.v)（仅 sideband glue）；打包 C：`fw/gen/wishbone/smoke.h` + `soc_wb_map.h`（入库展示）；固件：`fw/regfile_smoke`，`./sim/verilator/run.sh --regfile`。Bun Access/theme 叶子在 [`test/fixtures/wb_reg_access.ts`](../../../test/fixtures/wb_reg_access.ts)，不进 demo SoT。
- SoC sha256：[`demo/soc/sot/wb_reg_sha256.ts`](../../../demo/soc/sot/wb_reg_sha256.ts) → 一份 `sha256_regfile`，channel `SlaveRegfile(sha256, 0x40)` 挂一次，顶层 `SlaveBus` ×2；C：`fw/gen/wishbone/sha256.h`；[`sha256_wb_regs.v`](../../../demo/soc/rtl/sha256_wb_regs.v) + `sha256wb` 仅 AXIS/core glue
- Excel：`[plugins.wishbone] export=` 一份工作簿（字段 sheet + 每棵总线一张地址叶子 sheet；主干列；无空列 A / `ADDRWIDTH`）
- DSL：[`src/plugins/wishbone-regfile/dsl.ts`](../../../src/plugins/wishbone-regfile/dsl.ts)
- 契约：[`../../plugins/wishbone-regfile.md`](../../plugins/wishbone-regfile.md)

generate + analysis 后用 **`<aw-inst mod="…_regfile">`**（或薄 WB 包装）；**无** HTML 寄存器桩。

```bash
bun test test/wishbone-regfile.test.ts
cd demo/soc && bun ../../index.ts plugin wishbone run
```
