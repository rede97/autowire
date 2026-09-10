# Demo SoC generated-plugin audit

## Scope

Reviewed generated RTL under `demo/soc/gen/plugins/` and the generator, SoT, integration, documentation, and smoke harness required to assess its behavior:

- `wishbone-bus/soc_wb_interconnect.sv`
- `wishbone-regfile/sha256_0_regfile.sv`
- `wishbone-regfile/sha256_1_regfile.sv`
- `wishbone-regfile/smoke_regfile.sv`

Review date: 2026-09-10.

## Current decision

**Accepted after remediation.** The generated RTL now honors `SEL`, forwards TGA to the shadowed leaf, and the standard SoC smoke test reaches `SMOKE PASS`.

## Remediation status — 2026-09-11

| Original finding | Current state | Evidence |
|---|---|---|
| P1: regfiles ignored `SEL` | Resolved | Generated RW/RWW writes are byte-lane gated; W1C/W1P data is masked; RWE exposes `wstrb`. `test/wishbone-regfile.test.ts` simulates a disabled lane write. |
| P1: fabric dropped TGA | Resolved | `soc_wb_interconnect` forwards `m_tga_i` to `smoke_i_wb_tga`; `smoke_wb` derives the CPU tag from `rg_bank_sel`. |
| P1: smoke did not elaborate | Resolved | `demo/soc/sim/run_smoke.sh` compiles and prints `SMOKE PASS`. |
| P2: remap scalar selector selected highest set bit | Resolved under the scalar-selector contract | The generated priority encoder now scans high to low, so the final assignment selects the lowest set bit. |
| W1C HW set lost during a zero-lane SW write | Resolved | The W1C software branch now retains a per-lane HW-set fallback. The targeted RTL simulation passes. |

## Initial findings — historical record

### P1 — Regfiles ignore Wishbone `SEL`

**Evidence**

- `docs/plugins/wishbone-regfile.md:335-343` defines `SEL` as byte enables and requires partial writes to use `ADR + SEL`.
- `src/plugins/wishbone-regfile/emit.ts:549-557` derives write selection only from `CYC`, `STB`, `WE`, and the decoded address.
- Register assignments use the complete field value without any lane mask, for example `src/plugins/wishbone-regfile/emit.ts:797-800` and generated `sha256_0_regfile.sv:186-189`.
- `sha256_0_regfile.sv` exposes `sha256_0_i_wb_sel` at line 39 but never consumes it in generated write behavior.

A throwaway simulation instantiated `sha256_0_regfile`, performed a write to `CTRL.soft_reset` with `DAT[0]=1` and `SEL=4'b0010`, then asserted that `soft_reset` remained zero. The assertion failed:

```text
FATAL: byte-select violation: SEL[0]=0 changed soft_reset
```

**Impact**

Byte stores can modify bits in byte lanes that were not selected. This affects RW, RWW, W1C, W1P, and RWE behavior; it is unsafe for CPU byte accesses and for DMA masters that use byte enables.

**Required fix**

Generate field-byte masks from `i_wb_sel` and apply them consistently:

1. RW/RWW: retain unselected bits with masked read-modify-write.
2. W1C/W1P: mask write data before clear/pulse generation.
3. RWE: add a write-strobe sideband such as `ext_<field>_wstrb`, or reject partial writes explicitly. The existing documented contract requires correct byte-enable support.

### P1 — Fabric does not forward TGA, so shadow banks are unreachable

**Evidence**

- `docs/plugins/wishbone-bus.md:49,57` requires arbiter/decoder/pipe TGA forwarding whenever TGA is enabled.
- `docs/plugins/wishbone-regfile.md:351-360` requires shadow selection to come exclusively from `wb_tga`.
- `src/plugins/wishbone-bus/dsl.ts:17-26` has no tag-width or tag-port model.
- `src/plugins/wishbone-bus/emit.ts:28-42` generates only ADR/DAT/SEL/CYC/STB/WE slave request signals.
- The generated SoC wiring hard-wires the smoke regfile tag:

```systemverilog
.smoke_i_wb_tga(2'b00)
```

at `demo/soc/gen/connect/soc_top.sv:594-603`.

- The smoke SoT declares `Shadow("bank", 4, "1:0")` at `demo/soc/regs/smoke.ts:35-41`.

**Impact**

Only bank 0 is accessible in the demo. Banks 1–3 are dead despite being reset, stored, and exposed by the generated regfile.

**Required fix**

Model optional TGA width in the bus DSL, emit `m_tga_i`, and forward it through arbiter and decoder to each applicable `{slave}_i_wb_tga`. The integration layer must connect the master-provided TGA rather than tying the leaf to zero.

### P1 — Supplied smoke command cannot compile the generated SoC

**Evidence**

Running `demo/soc/sim/run_smoke.sh` fails before simulation because its Icarus file list omits all generated plugin RTL:

```text
Unknown module type: soc_wb_interconnect
Unknown module type: sha256_0_regfile
Unknown module type: sha256_1_regfile
Unknown module type: smoke_regfile
```

Adding the plugin files manually permits elaboration to proceed, but `demo/soc/sim/tb_sim.svh:24-32` then fails because it references removed hierarchy:

- `u_dut.u_sha_9.u_regs.*`
- `u_dut.u_ram_0.mem[*]`

**Impact**

The demo has no runnable end-to-end regression for the emitted design. Generator and integration breakages can ship undetected.

**Required fix**

1. Add the generated bus and regfile RTL files to `sim/run_smoke.sh`.
2. Replace hierarchical testbench probes with stable top-level observability, or update all probes to the current generated hierarchy.
3. Make this smoke command part of the post-generation acceptance path.

### P2 — Broadcast remap loses semantics when converted to scalar selector

**Evidence**

- `docs/plugins/wishbone-regfile.md:431-454` allows remaps to map one source tag to a multi-bit physical-copy mask.
- `src/plugins/wishbone-regfile/emit.ts:581-586` says it selects the "first set bit", but the ascending loop overwrites prior results and therefore selects the highest set bit:

```systemverilog
for (int __i = 0; __i < copies; __i++) begin
    if (mask_bank[__i]) o_bank_sel = ... __i;
end
```

**Impact**

The generated scalar selector does not preserve multi-copy/broadcast semantics for consumers such as RWE sidebands or inner shadow mux users. The behavior also contradicts its own generated comment.

**Required fix**

Expose the one-hot shadow mask for consumers that need broadcast semantics. If a scalar selector is the only supported interface, reject multi-bit remaps for those consumers or define and implement a stable first-set priority encoder.

## Positive observations

- All four generated plugin modules compile with `iverilog -g2012 -tnull`.
- Icarus produced only its known `always_comb` constant-select sensitivity warning for the response mux; it produced no syntax or module-elaboration error for the plugin modules themselves.
- The current interconnect’s address decoding follows its stated lowest-index priority, and its registered fixed-priority arbitration correctly retains a grant while that master keeps `CYC` asserted.
- Generated address-map and sideband comments are sufficient to trace the SoT register layout into the emitted RTL.

## Current verification record

| Check | Result |
|---|---|
| `bun test test/wishbone-regfile.test.ts` | Pass: 24 tests, including the W1C zero-lane regression |
| Generated W1C RTL | Contains per-lane HW-set fallback when `SEL` omits the W1C lane |
| `demo/soc/sim/run_smoke.sh` | Pass: prints `SMOKE PASS: cpu boot + sram copy + dma -> axis -> sha256 digest ok` |
| Targeted Biome check | Pass: `src/plugins/wishbone-regfile/emit.ts` and `test/wishbone-regfile.test.ts` |
| Full `bun run lint` | Blocked by 16 diagnostics in `src/core/aw.ts` and `src/plugins/wishbone-bus/emit.ts`; neither file was changed by this remediation |

## Acceptance criteria status

1. **Met:** a disabled `SEL` lane cannot change field bits in that lane.
2. **Met:** partial writes preserve unselected byte lanes in RW/RWW fields.
3. **Met:** TGA reaches the shadowed regfile from the CPU master.
4. **Met:** the standard smoke command compiles and reaches `SMOKE PASS`.
5. **Met:** broadcast remap scalar selection is explicitly lowest-set-bit priority.
6. **Met:** a W1C hardware set survives a simultaneous zero-lane software write.
