# sdspisim (vendored)

Copied from ZipCPU `sdspi` (`bench/cpp/sdspisim.{h,cpp}`).

**License: GPL-3.0** (see file headers). Keep this tree isolated from the MIT
SoC leaf RTL / firmware; only the Verilator C++ harness links it.

Upstream: `demo/soc/ip/sdspi/bench/cpp/`.

## Local deltas (vs upstream copy)

- Initialize `m_busy = false` in the constructor (was uninitialized).
- When CS is high, return MISO pull-up `1` (upstream returns `0`).
- CMD17 `fread` uses byte-oriented `fread(ptr, 1, len, fp)` so the length
  is the byte count, not the nmemb return value.
