# Autowire

[![CI](https://github.com/rede97/autowire/workflows/release/badge.svg)](https://github.com/rede97/autowire/actions/workflows/release.yml)
[![Release](https://img.shields.io/github/v/release/rede97/autowire)](https://github.com/rede97/autowire/releases/latest)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)

Autowire is a chip-integration toolkit for humans and AI agents. One CLI covers four jobs:

| Job | Command | Source of truth | Output |
|---|---|---|---|
| RTL index | `analysis run` | filelists in `autowire.toml` | RtlIndex under `.autowire/hdxml/` (read-only) |
| Connectivity | `connect run` | HTML + `<script>` | wrapper and testbench `.sv` |
| Registers and buses | `plugin wishbone run` | TypeScript `Regfile(...)` / `Bus(...)` | regfile + bus SV, C headers, `uvm_reg`, Excel |
| Simulation | `dtsim run` / `dtsim regr` | TypeScript `dt/config/dtsim.config.ts` | `dt/simout/` logs, statuses, regression results |

Connectivity is **HTML + script**. A browser (or happy-dom in the CLI) runs the script; the live DOM is the netlist. `connect run` reads the rendered `aw-render` and writes SystemVerilog. The page shows the same text and never writes the workspace.

## Why

**Fast.** RTL analysis is Rust + rayon and incremental: a warm re-index of the demo SoC takes about 0.1 s against 1.4 s cold. The connect engine is profiled ([docs/dev/core-perf.md](docs/dev/core-perf.md)). dtsim grades a 300 MB log in under 2 s by streaming it in a worker.

**Built for AI agents.** The install is one file, `autowire.js`, plus the `hdxml` binary. `autowire init` writes an `AGENTS-AUTOWIRE.md` contract into the workspace, and `autowire help agent` is the entry point. The full docs and runnable demos ship inside the bundle (`autowire docs unpack <dir>`), so an agent can go from index to generated RTL to a graded regression with a handful of CLI commands.

**One source per thing.** Generated files (`rtl/gen/`, `fw/gen/`, `dv/ral/`, `.autowire/`, `dt/simout/`) are never edited by hand. A wrong output is fixed in its SoT and the writer is re-run.

## Install

Download `autowire.js` and the `hdxml` archive for your platform from the [latest release](https://github.com/rede97/autowire/releases/latest). `autowire.js` runs on [Bun](https://bun.sh).

```bash
bun autowire.js --version
bun autowire.js help              # command index
bun autowire.js help agent        # working contract for agents
bun autowire.js update            # latest release + an AI upgrade prompt (writes nothing)
```

`hdxml` is looked up in this order: `--hdxml`, `[analysis] hdxml_bin` in `autowire.toml`, `$HDXML_BIN`, then `PATH`. hdxml is its own project: [`rede97/hdxml`](https://github.com/rede97/hdxml).

## Quick start: connectivity

```bash
bun autowire.js init mychip          # autowire.toml + AGENTS-AUTOWIRE.md + .autowire/{hdxml,dsl}
# edit autowire.toml: point the filelists at your RTL
bun autowire.js plugin wishbone run  # regfiles + buses from TypeScript (when you have them)
bun autowire.js analysis run         # hdxml → RtlIndex
bun autowire.js connect check        # author-face rules, no write
bun autowire.js connect run          # render the connect HTML, write .sv (deps first)
bun autowire.js connect web          # inspect the live page (read-only)
```

Analysis filelists carry hand RTL and `plugins_dir` leaves only. `connect run` outputs are simulation inputs and belong in a separate filelist.

## Quick start: simulation (dtsim)

A project (the RTL design dir) keeps its testbench in `dt/` and the config in `dt/config/`:

```text
<project>/
  dt/
    config/dtsim.config.ts   Workspace(...) with cases, groups, grader, tool, launcher, hooks
    config/.dtsim/dsl/       DSL copy, rewritten on every run (generated)
    simout/                  outputs (generated, git-ignored)
```

```ts
// dt/config/cases/smoke.ts: export only top-level cases
import { Case } from "../.dtsim/dsl/index.ts";

export const smoke = Case("smoke", { defines: ["SMOKE"], simArgs: ["+quick"] });
smoke.SubCase("long", { simArgs: ["+long"] }); // id: smoke.long
```

```ts
// dt/config/dtsim.config.ts
import { DefaultGrader, Group, VcsTool, Workspace } from "./.dtsim/dsl/index.ts";
import { smoke } from "./cases/smoke.ts";

export default Workspace({
	tools: [VcsTool({ ntbOpts: "uvm-1.2" })], // several: --tool picks one
	filelist: "file.lst", // entries relative to <project>/
	grader: DefaultGrader({ pass: ["TEST PASSED"] }),
	groups: [Group("nightly", [smoke, "smoke.**"])],
	cases: ["./cases/smoke.ts"],
});
```

```bash
ln -s autowire.js dtsim               # or call `bun autowire.js dtsim <cmd>`
./dtsim list                          # case trees
./dtsim plan nightly                  # compile groups, defines, seeds; no run
./dtsim run smoke                     # compile + simulate one case
./dtsim regr nightly --num-seeds 4    # shared compiles, parallel sims, Summary table
./dtsim run smoke --wave              # waveform dump (VCS fsdb, Verilator fst)
./dtsim results --dir dt/simout/regression
```

Backends are values (`VcsTool`, `VerilatorTool`, `defineTool`), and so are launchers (`LocalLauncher`, `LsfLauncher`, `SlurmLauncher`, `defineLauncher`). A grader decides each seed's status from `sim.log`, never from the exit code. Hooks are TypeScript callbacks for `preCompile`, `postCompile`, `preSim`, `postSim` and `onResult`. Children see only the environment variables the config passes through. Full reference: [docs/dtsim/README.md](docs/dtsim/README.md) and `help dtsim`.

## Pipeline

```text
autowire.toml (filelists + macros)
    →  plugin wishbone run  (TypeScript → regfile / bus SV)
    →  analysis run         (hdxml → RtlIndex, read-only)
    →  connect check / run  (HTML → aw-render → .sv, deps first)
    →  dtsim run / regr     (dt/config → compile, simulate, grade)
```

Components and write-back rules: [docs/architecture.md](docs/architecture.md). Workspace config: [docs/workspace/toml.md](docs/workspace/toml.md). Connect dialect: [docs/connect/html.md](docs/connect/html.md), rules summary [docs/connect/rules.md](docs/connect/rules.md). Wishbone: [docs/plugins/](docs/plugins/). Doc index: [docs/README.md](docs/README.md).

## Demos

| Demo | Shows |
|---|---|
| [`demo/soc`](demo/soc) | picorv32 SoC, Wishbone fabric, connect HTML, dtsim smokes on Verilator (`dt/verilator/run.sh`) and VCS (`dt/vcs/run.sh`) |
| [`demo/hbm`](demo/hbm) | 16-channel fabric, VCS + UVM-1.2 regression through dtsim (`dt/vcs/run.sh`) |
| [`demo/dtsim`](demo/dtsim) | every dtsim feature on fake tools (`run.sh`): derived cases, groups, graders and waives, all hook stages, LSF launcher |

## Tools

| Tool | Role |
|---|---|
| `autowire` | Workspace CLI: analysis, connect, `plugin wishbone run`, `dtsim`. Ships as single-file `autowire.js` (run with Bun) |
| `hdxml` | Read-only RTL analysis → RtlIndex (Rust; Linux x86_64 glibc 2.17 / CentOS 7+, macOS arm64/x64, Windows x64) |
| Browser | Page rendering and debug only; `connect run` uses happy-dom. Any CDP browser can drive the page ([docs/skills/cdp-debug.md](docs/skills/cdp-debug.md)) |

## Development

Bun only (`bun`, `bun test`, `bunx`). The dev entry is `bun index.ts <cmd>`; production is `autowire.js`. Windows uses the MSYS2 UCRT64 toolchain ([docs/dev/windows-msys2.md](docs/dev/windows-msys2.md)).

```bash
bun install
bun run fetch:hdxml      # pinned hdxml release into .cache/hdxml/
bun run lint             # biome + tsc
bun test
bun run build:js         # out/autowire.js
```

Behavior changes update `help/<topic>.txt` and the matching doc together. A pushed `v*` tag runs the release workflow; the version and notes come from the top entry of [CHANGELOG.md](CHANGELOG.md) ([docs/dev/release.md](docs/dev/release.md)). Agent rules for this repo: [AGENTS.md](AGENTS.md).

## Non-goals

- Connectivity as XML or one file per level as SoT (the RtlIndex is an index, not the connectivity SoT)
- Connect-specific MCP tools (`outline`, `apply`, `rewrite`, …)
- The browser writing the workspace directly
- Two wiring semantics (web and CLI share one `aw.js` and one golden)
- Wiring details inside `autowire.toml` (its `[connect]` section only lists HTML paths)
- Copying a project prompt into every chip project (edit `help/agent.txt` instead)

## License

[GPL-3.0](LICENSE)
