# demo/soc firmware (C)

C firmware for SoC smoke / DV. Built with an RV32IMC toolchain and loaded into
the SPI flash model via `$readmemh` / `+firmware=…`.

**Primary runner: Verilator** (`sim/verilator/run.sh`). iverilog is not required.

## Layout

| Path | Role |
|------|------|
| `common/` | `soc_map.h` (aliases bus map + mmio helpers), `sdspi_regs.h`, `link.ld`, `crt0.S`, `makehex.py` |
| `gen/wishbone/` | Packed generated C (`smoke.h`, `sha256.h`, `soc_wb_map.h`, `wishbone.h`) and Excel `wishbone.xlsx` from `[plugins.wishbone]`; **git-tracked showcase** (regenerate in place, do not delete) |
| `basic_smoke/` | SRAM zeros SHA + flash `@0x0100_1000` KAT SHA + dual DMA SRAM KAT under RR |
| `regfile_smoke/` | Wishbone-regfile MMIO smoke (RC/RO/RW/RWW counter/RWE FIFO loopback/…) |
| `sd_sha256/` | SD0 init + CMD17 → DMA0 (FIFO A, no `src_inc`) → SHA256_0 |

Flash XIP reset PC = `0x0100_0000`. SRAM = `0x0000_0000`..`0x0000_FFFF`
(stack top `0x0001_0000`). KAT payload lives at flash offset `0x1000`
(CPU `0x0100_1000`), same vector as legacy `sim/gen_firmware.py`.

## Build / run

```bash
# from demo/soc
bun ../../index.ts plugin generate wishbone   # SV + packed C / Excel / uvm_reg
./sim/verilator/run.sh              # basic_smoke (SRAM + flash KAT + dual DMA RR)
./sim/verilator/run.sh --regfile    # wishbone-regfile MMIO (FIFO loopback + counters)
./sim/verilator/run.sh --sd         # sd_sha256 + sdspisim card image
```

Toolchain: set `CROSS=` if needed (defaults probe `riscv32-wch-elf-`,
`riscv-none-embed-`, `riscv64-unknown-elf-`, `riscv32-unknown-elf-`).

Legacy Python KAT + iverilog scripts (`sim/gen_firmware.py`, `sim/run_smoke.sh`)
remain for archaeology; not part of the required smoke path.
`sim/run_fw_zeros.sh` is a legacy alias that forwards to Verilator `basic_smoke`.

## SD notes (`--sd`)

- Card model: GPL-3 `sim/verilator/third_party/sdspisim/` (vendored ZipCPU
  `sdspisim`; MIT SoC leaf does not link it into RTL).
- Image: `sim/verilator/images/gen_zeros_sha_img.py` → `zeros_sha.img`
  (sector 0 = same 32 soft-pad words as the SRAM zeros KAT, big-endian on disk).
- `sdspi_regs.h` is MIT (constants mirrored from ZipCPU bench/driver; no GPL
  sources copied into firmware).
- After submodule checkout run `patches/apply.sh` (also invoked by
  `sim/verilator/run.sh`) so the FIFO pointer advances once per Classic beat.
