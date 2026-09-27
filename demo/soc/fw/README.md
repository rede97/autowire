# demo/soc firmware (C)

C firmware for SoC smoke / DV. Built with an RV32IMC toolchain and loaded into
the SPI flash model via `$readmemh` / `+firmware=…`.

**Runner: Verilator only** (`sim/verilator/run.sh`). The external JTAG smoke
(`sim/verilator/jtag_host.h`) runs concurrently with the firmware.

## Layout

| Path | Role |
|------|------|
| `common/` | `soc_map.h` (aliases bus map + mmio helpers), `sdspi_regs.h`, `link.ld`, `crt0.S`, `makehex.py` |
| `gen/wishbone/` | Packed generated C (`smoke.h`, `sha256.h`, `sd_sha_map.h`, `soc_wb_map.h`, `wishbone.h`) and Excel `wishbone.xlsx` from `[plugins.wishbone]`; **git-tracked showcase** (regenerate in place, do not delete) |
| `basic_smoke/` | Cascade MMIO: smoke ID + SHA0/SHA1 CTRL via two `SlaveBus` channels + grant CSR |
| `regfile_smoke/` | Wishbone-regfile MMIO smoke (RC/RO/RW/RWW counter/RWE FIFO loopback/…) |
| `sd_sha256/` | SD0 init + CMD17 → channel DMA (FIFO A, relative SRC) → SHA256 |

Flash XIP reset PC = `0x0100_0000`. SRAM = `0x0000_0000`..`0x0000_FFFF`
(stack top `0x0001_0000`). KAT payload lives at flash offset `0x1000`
(CPU `0x0100_1000`).

## Build / run

```bash
# from demo/soc
bun ../../index.ts plugin wishbone run   # SV + packed C / Excel / uvm_reg
./sim/verilator/run.sh              # basic_smoke (cascade MMIO + grant CSR)
./sim/verilator/run.sh --regfile    # wishbone-regfile MMIO (FIFO loopback + counters)
./sim/verilator/run.sh --sd         # sd_sha256 + sdspisim card image
./sim/verilator/run.sh --tb-mod     # aw-tb-mod dump tb_soc (--binary) + SV JTAG host
```

Toolchain: set `CROSS=` if needed (defaults probe `riscv32-wch-elf-`,
`riscv-none-embed-`, `riscv64-unknown-elf-`, `riscv32-unknown-elf-`).

The JTAG smoke writes SRAM `0x0000_8000`; firmware must not use that word.
Pass `+nojtag` to `sim/verilator/obj_dir/Vtb_soc_vl` to run the firmware alone
(bisect a failure between the two masters).

## SD notes (`--sd`)

- Card model: GPL-3 `sim/verilator/third_party/sdspisim/` (vendored ZipCPU
  `sdspisim`; MIT SoC leaf does not link it into RTL).
- Image: `sim/verilator/images/gen_zeros_sha_img.py` → `zeros_sha.img`
  (sector 0 = same 32 soft-pad words as the SRAM zeros KAT, big-endian on disk).
- `sdspi_regs.h` is MIT (constants mirrored from ZipCPU bench/driver; no GPL
  sources copied into firmware).
- After submodule checkout run `patches/apply.sh` (also invoked by
  `sim/verilator/run.sh`) so the FIFO pointer advances once per Classic beat.
