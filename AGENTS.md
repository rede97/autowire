# Autowire

HTML plus `<script>` is the connectivity source. After the script runs, the live DOM is the netlist. `connect run` writes `.sv` from `aw-render`. The page shows the same text and does not write the workspace. Product overview: [`README.md`](README.md). Constraints: [`docs/`](docs/README.md).

Start with `bun index.ts help agent`. Do not invent a command that `help status` does not list as landed. Behavior changes MUST update `help/<topic>.txt` and the matching doc. `src/cli/help.ts` only loads those files.

**Reference — top priority.** Project best practices live in [`docs/`](docs/README.md) (contracts and constraints) and [`demo/`](demo/) (runnable examples). Before changing behavior, read the relevant `docs/` and `demo/` files first; they are the authoritative reference, not guesswork. (Same rule in `help agent`.)

## Tools

Three processes, never linked into one binary. Details: [`docs/dev/release.md`](docs/dev/release.md). The release workflow (`.github/workflows/release.yml`) runs only on a pushed `v*` tag and publishes `hdxml` (Linux x64 glibc 2.17, macOS arm64/x64) and single-file `autowire.js`; obscura, the installer, and the compiled `out/autowire` are still parked.

| Tool | Owns | Does not | Help |
|---|---|---|---|
| autowire | Workspace CLI: analysis, connect, `plugin wishbone run`. `connect run` writes `.sv` with happy-dom, no browser. Tests use `bun index.ts`. Production is `out/autowire.js` (one Bun script: deps, page assets, zstd of `docs/` and the runnable demo sources — `demo/*/ip/` is trimmed to the filelist closure, patches pre-applied, sot imports rewritten to `.autowire/dsl/`) or `out/autowire` (that script plus the Bun runtime). Unpack with `docs unpack <dir>`. See [`docs/dev/release.md`](docs/dev/release.md) section 1.1 | RTL parse; a bundled browser; shipping `index.ts` or `node_modules` | Dev/CI: `bun index.ts help`, `help topics`, `help docs`. Production: `autowire help` or `bun autowire.js help`|
| hdxml | Read-only RTL analysis to RtlIndex XML. **Separate project** [`rede97/hdxml`](https://github.com/rede97/hdxml), its own version and release; this repo pins one version in `hdxml-version.txt` and `bun run fetch:hdxml` downloads it into `.cache/hdxml/<version>/` (no build) | Connect, print `.sv`, Wishbone | [`docs/hdxml/cli.md`](docs/hdxml/cli.md). Scoped rules: [hdxml `AGENTS.md`](https://github.com/rede97/hdxml/blob/main/AGENTS.md) |
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
bun index.ts plugin fsm run
bun index.ts dtsim run|regr|plan|list|groups|results|env
bun run lint
bun run build:web
bun run build:js
bun run build:bin
```

Commands above are the dev and test entry (`index.ts`). Do not tell a production user to run `index.ts`. Production is `out/autowire` or `bun out/autowire.js` with the same subcommands. `build:bin` writes both; the page bundle is inside the file.

`connect check` reports rules and does not write. `connect run` is the only writer of `.sv` and connect snapshots. `connect web` is a static session. `plugin wishbone run` is the plugin's own run; it does not call connect. Default writes are incremental; `--force` rewrites. Wishbone Excel is always rewritten.

`dtsim` is the simulation runner ([`docs/dtsim/README.md`](docs/dtsim/README.md), `help dtsim`). A project (RTL design dir) keeps its testbench in `dt/`, the TypeScript config in `dt/config/dtsim.config.ts` (selected by `[dtsim] config` in `autowire.toml`), and outputs in `dt/simout/`. The simulator compiles in the compile dir and simulates in the seed dir, so filelist entries name sources as `$WORKSPACE/...` (dtsim sets it to the project root; `autowire analysis` expands it too). Cluster launchers write `bsub_*` / `srun_*` submit wrappers beside the run scripts. `ln -s autowire.js dtsim` (or a link to `out/autowire`) runs the same subcommands without the `autowire dtsim` prefix. `demo/dtsim` runs on the fake tools in `demo/dtsim/dt/bin`, which `test/dtsim/` also uses.

Driving dtsim as an agent: `dtsim list`, `groups`, `plan <group>` read the config without running. `dtsim run <case> --plain` and `dtsim regr <group> --plain` print one line per step; exit 0 means every seed is `PASS` or `PASS WITH ERRORS`. On a failure read `error.txt` in the failing compile or seed dir first (status, phase, grader rows, log excerpt), then the log it names. `run_compile` / `run_sim` in those dirs rerun one step by hand. `results --dir <dir>` (or the `dresults` script in a regression dir) re-reads statuses; `--recheck` re-grades with the current grader. The status comes from the grader reading `sim.log`, never the tool exit code. `Workspace({ tools: [...] })` may list several simulators: dtsim picks the first available by each tool's `probe`; a config factory orders or filters `tools` to force one, outputs then go to `dt/simout/<tool>/`, Case `tools` limits where a case runs and `byTool.<tool>` holds per-simulator options. `top` (default `tb_top`), `wave`, `waveDepth` and `waveScope` are Workspace defaults that cases inherit and override; a CLI `--wave` exists only when the config registers it (`Workspace([{ name: "WAVE", flags: "--wave" }], () => ({ wave: process.env.WAVE === "1", ... }))`). Coverage is the same kind of option (`cov`, `covMetrics`; only VCS collects it); dtsim never merges it and ends with a Coverage table naming each database and the `run_cov_merge` / `run_cov_merge_all` scripts (plus `bsub_`/`srun_` wrappers).

## Sources of truth

- Author HTML: `[connect.<id>]` / `[sim.<id>]` `html=` in `autowire.toml`. One toml per workspace. `deps` are direct edges only.
- Wishbone SoT: TypeScript `Regfile(...)` / `Bus(...)`. Excel, C, and `uvm_reg` are exports, not sources.
- FSM SoT: `.mjs` `@FsmGroup` class (`[fsm.<id>] mjs=`, `help fsm`, `docs/state/async-fsm.md`). `plugin fsm run` writes `plugins_dir/fsm/`; the source is parsed, never executed.
- Simulation SoT: `dt/config/*.ts` (`Workspace`, `Case`, `Group`, grader, tool, launcher, hooks). `dt/config/.dtsim/dsl/` is rewritten from the embedded DSL on every dtsim load; import from it, do not edit it.
- Leaf ports: RtlIndex under `.autowire/hdxml/`. Do not reparse RTL in the page.
- Printer input: `aw-render` only. Do not treat `aw-content` as the netlist.

Generated and MUST NOT be hand-edited: `out/web/aw.js`, `out/web/page.js` (`bun run build:web`; not tracked), `rtl/gen/`, `plugins_dir/`, `fw/gen/`, `dv/ral/`, `.autowire/`, `dt/simout/`, `dt/config/.dtsim/`, and `src/dtsim/dsl/embedded.generated.ts` (`bun scripts/gen-dtsim-dsl.ts` after editing any file under `src/dtsim/dsl/`). A wrong generated file is fixed by changing the SoT (Wishbone TypeScript or connect HTML) and re-running the writer. `demo/soc/ip/sdspi` stays at upstream `dfb16c8`; its FIFO patch is applied only for a smoke (the dtsim `preCompile` hook) and then discarded.

## Constraints

- Comments, errors, and CLI text MUST be English. Chinese is allowed in `docs/`. `test/lang-guard.test.ts` fails on CJK in TypeScript.
- `bun run lint` (`biome check .` and `tsc --noEmit`) MUST be clean before a commit.
- Windows toolchain is MSYS2 UCRT64. PATH gets `C:\msys64\ucrt64\bin` only. Git Bash is not that shell. Line endings are LF. See [`docs/dev/windows-msys2.md`](docs/dev/windows-msys2.md).
- `.svh` MUST NOT appear in a filelist. Macros come from `` `include `` or `define_headers`.
- The page and its GET APIs MUST NOT write the workspace. Saving is a browser download or the driver storing `#aw-generated`.
- Do not implement parked work: the installer and the production-browser (obscura) .mcp.json switch, HTML node-edit MCP, plugin type B, extra Wishbone policies in `docs/plugins/wishbone-bus.md` section 8, or a second `autowire.toml`. Dev and CI stay on Playwright Chromium. The two autowire artifacts in section 1.1 are already specified.

hdxml is its own repo (`rede97/hdxml`, own `AGENTS.md`); this repo only pins `hdxml-version.txt`. Demo smoke details: [`docs/skills/autowire-soc-integration.md`](docs/skills/autowire-soc-integration.md). Run these from `demo/soc` after `plugin wishbone run` when the Wishbone SoT changed. The scripts are thin wrappers over `dtsim` (one `dt/config/dtsim.config.ts` with Verilator first and VCS second; `dt/vcs/run.sh` sets `SIM_TOOL=vcs`); outputs land in `dt/simout/verilator/` and `dt/simout/vcs/`.

Verilator (`dt/verilator/run.sh`; `verilator` on PATH; `--timing` needs a C++ compiler with `-fcoroutines`, GCC 10+):

- `./dt/verilator/run.sh` — case `basic_smoke`: `fw/basic_smoke` (cascade MMIO, smoke CSR, external JTAG)
- `./dt/verilator/run.sh --regfile` — case `regfile_smoke`: wishbone-regfile MMIO (FIFO / counter / access)
- `./dt/verilator/run.sh --sd` — case `sd_sha256`: `fw/sd_sha256` + card image (channel DMA)
- `./dt/verilator/run.sh --tb-mod` — case `tb_mod`: dumped `rtl/gen/sim/soc_tb.sv` (module `tb_top`; `--binary --timing`)
- `./dt/verilator/run.sh --sv-reg` — case `sv_reg_smoke`: `sv_reg` package + localparam only (no firmware, no bus RTL)
- `bun ../../index.ts dtsim regr` — all five

VCS (`dt/vcs/run.sh`, only when `vcs` is on PATH; pure SV `tb_top`, no C++ harness): `./dt/vcs/run.sh basic_smoke` and `./dt/vcs/run.sh regfile_smoke`. Do not run `--sd` under VCS (`sdspisim` is C++). demo/hbm: `./dt/vcs/run.sh [test ...]` (VCS + UVM-1.2); VCS O-2018.09 needs g++ < 10 for its UVM DPI, so on a host whose PATH g++ is newer run `VCS_GCC_DIR=/usr/bin ./dt/vcs/run.sh`.

`bun test` Verilator cases (skipped when `verilator` or `make` is missing; both use `--timing`): `wishbone-regfile smoke features` → `W1C hardware set survives a zero-lane write`; `wishbone master bridges` → `verilator: APB / JTAG / async WB masters through wb_cdc`.
