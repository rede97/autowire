# Regfile 作者面示例

寄存器 **SoT** 为 TypeScript：`Regfile(...)` 命名导出（`RegfileDef`）。

- 草稿 API + 示例导出：本目录 [`regfile.ts`](./regfile.ts)（`sub_module_a` / `sub_module_b`）
- 契约：[`../../plugins/wishbone-regfile.md`](../../plugins/wishbone-regfile.md)

可选 HTML 仅空桩 `<awx-regfile value="export_binding">`（只允许 `value`；无子节点），`value` 对应脚本中的 export——**不是**权威描述。

插件未落地前本文件只作作者面示意；实现以 `help status` 为准。
