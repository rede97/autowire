# Wishbone interconnect：广播窗偏移收敛为共享 wire（设计草稿）

> 状态：**已实现（2026-09-28）**。emit.ts 已发射共享 `<group>_off` wire；hbm demo 已重生成；`test/wishbone-tag.test.ts` 断言已更新；tsc/biome/单测通过。Verilator 冒烟为既有盲区，未跑。
> 背景：`*_interconnect.sv` 里每个广播订阅者的 `_i_wb_adr` 都内联重复 `(g_adr_dec - <bcast_base>)`，N 个订阅者重复 N 次。

## 1. 现状

`src/plugins/wishbone-bus/emit.ts` 的 `emitSlaveCombo`（约 L710）与 `emitSlavePipe`（约 L857）为每个订阅者发射：

```systemverilog
assign chN_i_wb_adr = (slot_sel[SLOT_CHN] || broadcast_ch_all)
  ? (({19{slot_sel[SLOT_CHN]}} & g_adr_dec) | ({19{broadcast_ch_all}} & (g_adr_dec - 19'h11000))) & ~19'h7f000
  : 19'd0;
```

`(g_adr_dec - 19'h11000)` 是广播窗基址偏移，**同一广播组的所有订阅者完全相同**（hbm demo：16 个 channel 各重复一遍）。

## 2. 改动（已确认）

每个广播组只发射**一根**偏移 wire，订阅者引用它：

```systemverilog
logic [18:0] ch_all_off;
assign ch_all_off = g_adr_dec - 19'h11000;   // 紧挨 broadcast_ch_all 生成
...
assign chN_i_wb_adr = (slot_sel[SLOT_CHN] || broadcast_ch_all)
  ? (({19{slot_sel[SLOT_CHN]}} & g_adr_dec) | ({19{broadcast_ch_all}} & ch_all_off)) & ~19'h7f000
  : 19'd0;
```

- **只收广播基址偏移** `(adr - base)`。`& ~mask` 是 per-slave（掩码可不同），保留在各条里；本地项 `{aw{slot}} & adr` 也保留。不收本地偏移（掩码不一致时不成立）。
- wire 命名 `<broadcast_name>_off`（如 `ch_all_off`），与 `broadcast_<name>` 同处生成（emit.ts 约 L650-654）。
- combo（L710）与 pipe（L857）两条发射路径都改，保持一致。
- 语义等价：`<name>_off` 只是 `(adr - base)` 的组合别名。

## 3. 改动面

- `src/plugins/wishbone-bus/emit.ts`：广播 wire 块新增 `assign ${name}_off = ${adr} - base;`；combo/pipe 路径把内联的 `(${adr} - ...base)` 换成 `${name}_off`。
- 重新生成受影响 demo（hbm 用 broadcastBy；soc 若无广播则不变）。
- `test/wishbone-bus.test.ts`：对生成 SV 的精确字符串断言同步更新。
- `bun run lint` 干净；**Verilator 冒烟**确认等价（当前 sim 路径为既有盲区，卡在 sdspi patch）。

## 4. 备注

- 单订阅者的广播组也会生成一根只用一次的 wire（可接受，保持发射逻辑统一）。
- 纯生成器改动；`rtl/gen/*.sv` 是生成物，不手改。
