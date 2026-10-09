# Autowire

HTML plus `<script>` is the connectivity source. After the script runs, the live DOM is the netlist. `connect run` writes `.sv` from `aw-render`. The page shows the same text and does not write the workspace. Product overview: [`README.md`](README.md). Constraints: [`docs/`](docs/README.md).

Start with `bun index.ts help agent`. Do not invent a command that `help status` does not list as landed. Behavior changes MUST update `help/<topic>.txt` and the matching doc. `src/cli/help.ts` only loads those files.

**Reference — top priority.** Project best practices live in [`docs/`](docs/README.md) (contracts and constraints) and [`demo/`](demo/) (runnable examples). Before changing behavior, read the relevant `docs/` and `demo/` files first; they are the authoritative reference, not guesswork. (Same rule in `help agent`.)

## Tools

Three processes, never linked into one binary. Details: [`docs/dev/release.md`](docs/dev/release.md). The 0.9.1 release CI on `main` (`.github/workflows/release.yml`) publishes `hdxml` (Linux x64 glibc 2.17, macOS arm64/x64) and single-file `autowire.js`; obscura, the installer, and the compiled `out/autowire` are still parked.

| Tool | Owns | Does not | Help |
|---|---|---|---|
| autowire | Workspace CLI: analysis, connect, `plugin wishbone run`. `connect run` writes `.sv` with happy-dom, no browser. Tests use `bun index.ts`. Production is `out/autowire.js` (one Bun script: deps, page assets, zstd of `docs/` and the runnable demo sources — `demo/*/ip/` is trimmed to the filelist closure, patches pre-applied, sot imports rewritten to `.autowire/dsl/`) or `out/autowire` (that script plus the Bun runtime). Unpack with `docs unpack <dir>`. See [`docs/dev/release.md`](docs/dev/release.md) section 1.1 | RTL parse; a bundled browser; shipping `index.ts` or `node_modules` | Dev/CI: `bun index.ts help`, `help topics`, `help docs`. Production: `autowire help` or `bun autowire.js help`|
| hdxml | Read-only RTL analysis to RtlIndex XML. No subcommands. `analysis run` maps `autowire.toml` onto its flags | Connect, print `.sv`, Wishbone | [`docs/hdxml/cli.md`](docs/hdxml/cli.md). Scoped rules: [`hdxml/AGENTS.md`](hdxml/AGENTS.md) |
| Playwright + Chromium | Dev and CI page tests and debug (`test/e2e-web.test.ts`, `.mcp.json`) | Production package; writing `.sv` | Page contract: [`docs/workspace/web-ui.md`](docs/workspace/web-ui.md) |
| obscura | Production debug browser only (`mcp`, `serve`; CDP, CentOS 7-compatible build). Same HTML as happy-dom | Dev/CI today; writing `.sv`. Do not switch `.mcp.json` to it until the package exists | [`docs/dev/release.md`](docs/dev/release.md) sections 1-2; CDP pattern: [`docs/skills/cdp-debug.md`](docs/skills/cdp-debug.md) |

[analysis] filelists carry hand RTL and `plugins_dir` leaves only; `connect run` outputs (connect_dir wrappers, sim_dir TB) are simulation inputs, not analysis inputs — keep them in a separate simulation filelist combined with the analysis one (demo/soc: `rtl/gen.f`, `-f rtl/soc.f -f rtl/gen.f`). `analysis run` rejects connect_dir / sim_dir entries; for a plugins_dir leaf that is not on disk yet it stops and names `plugin wishbone run` instead of passing hdxml's missing-file error through. Usual order: `plugin wishbone run` → `analysis run` → `connect run` (connect_dir, sim_dir, and `.autowire/connect` snapshots; deps first). A hand-RTL-only filelist, or a full demo unpack that already contains `rtl/gen`, can `analysis run` first; re-run `plugin wishbone run` when the TypeScript SoT changed. `connect check` does not write. Checking a unit before its deps have a snapshot fails with "snapshot missing". Standalone `autowire.js` does not embed hdxml: `--hdxml`, `[analysis] hdxml_bin`, `$HDXML_BIN`, then PATH. If `docs unpack` has no demo a doc cites, that demo was trimmed; use the contracts and the demos that unpacked. Open `connect web` and drive it with Playwright only to inspect the live page. The page does not write files.

Any CDP-speaking headless browser can drive the page (Playwright is only the client). Pattern + helpers: [`docs/skills/cdp-debug.md`](docs/skills/cdp-debug.md), `scripts/cdp-helper.ts`, or `help cdp`.

## Commands

Use Bun only: `bun`, `bun test`, `bunx`. Do not use Node, npm, or npx equivalents.

```text
bun index.ts analysis run
bun index.ts analysis deps|search|info
bun index.ts connect check [unit]
bun index.ts connect run [unit]
bun index.ts connect web [unit]
bun index.ts plugin wishbone run
bun run lint
bun run build:web
bun run build:js
bun run build:bin
```

Commands above are the dev and test entry (`index.ts`). Do not tell a production user to run `index.ts`. Production is `out/autowire` or `bun out/autowire.js` with the same subcommands. `build:bin` writes both; the page bundle is inside the file.

`connect check` reports rules and does not write. `connect run` is the only writer of `.sv` and connect snapshots. `connect web` is a static session. `plugin wishbone run` is the plugin's own run; it does not call connect. Default writes are incremental; `--force` rewrites. Wishbone Excel is always rewritten.

## Sources of truth

- Author HTML: `[connect.<id>]` / `[sim.<id>]` `html=` in `autowire.toml`. One toml per workspace. `deps` are direct edges only.
- Wishbone SoT: TypeScript `Regfile(...)` / `Bus(...)`. Excel, C, and `uvm_reg` are exports, not sources.
- Leaf ports: RtlIndex under `.autowire/hdxml/`. Do not reparse RTL in the page.
- Printer input: `aw-render` only. Do not treat `aw-content` as the netlist.

Generated and MUST NOT be hand-edited: `out/web/aw.js`, `out/web/page.js` (`bun run build:web`; not tracked), `rtl/gen/`, `plugins_dir/`, `fw/gen/`, `dv/ral/`, and `.autowire/`. A wrong generated file is fixed by changing the SoT (Wishbone TypeScript or connect HTML) and re-running the writer. `demo/soc/ip/sdspi` stays at upstream `dfb16c8`; its FIFO patch is applied only for a smoke and then discarded.

## Constraints

- Comments, errors, and CLI text MUST be English. Chinese is allowed in `docs/`. `test/lang-guard.test.ts` fails on CJK in TypeScript.
- `bun run lint` (`biome check .` and `tsc --noEmit`) MUST be clean before a commit.
- Windows toolchain is MSYS2 UCRT64. PATH gets `C:\msys64\ucrt64\bin` only. Git Bash is not that shell. Line endings are LF. See [`docs/dev/windows-msys2.md`](docs/dev/windows-msys2.md).
- `.svh` MUST NOT appear in a filelist. Macros come from `` `include `` or `define_headers`.
- The page and its GET APIs MUST NOT write the workspace. Saving is a browser download or the driver storing `#aw-generated`.
- Do not implement parked work: the installer and the production-browser (obscura) .mcp.json switch, HTML node-edit MCP, plugin type B, extra Wishbone policies in `docs/plugins/wishbone-bus.md` section 8, or a second `autowire.toml`. Dev and CI stay on Playwright Chromium. The two autowire artifacts in section 1.1 are already specified.

`hdxml/` has its own [`AGENTS.md`](hdxml/AGENTS.md). Demo smoke details: [`docs/skills/autowire-soc-integration.md`](docs/skills/autowire-soc-integration.md). Run these from `demo/soc` after `plugin wishbone run` when the Wishbone SoT changed.

Verilator (`sim/verilator/run.sh`; `verilator` on PATH; `--timing` needs a C++ compiler with `-fcoroutines`, GCC 10+):

- `./sim/verilator/run.sh` — `fw/basic_smoke` (cascade MMIO, smoke CSR, external JTAG)
- `./sim/verilator/run.sh --regfile` — wishbone-regfile MMIO (FIFO / counter / access)
- `./sim/verilator/run.sh --sd` — `fw/sd_sha256` + card image (channel DMA)
- `./sim/verilator/run.sh --tb-mod` — dumped `rtl/gen/sim/tb_soc.sv` (`--binary --timing`)
- `./sim/verilator/sv_reg_smoke.sh` — `sv_reg` package + localparam only (no firmware, no bus RTL, no `--timing`)

VCS (`sim/vcs/run.sh`, only when `vcs` is on PATH; pure SV `tb_soc`, no C++ harness): `./sim/vcs/run.sh basic_smoke` and `./sim/vcs/run.sh regfile_smoke`. Do not run `--sd` under VCS (`sdspisim` is C++).

`bun test` Verilator cases (skipped when `verilator` or `make` is missing; both use `--timing`): `wishbone-regfile smoke features` → `W1C hardware set survives a zero-lane write`; `wishbone master bridges` → `verilator: APB / JTAG / async WB masters through wb_cdc`.
