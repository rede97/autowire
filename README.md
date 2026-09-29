# Autowire

[![CI](https://github.com/rede97/autowire/workflows/release/badge.svg)](https://github.com/rede97/autowire/actions/workflows/release.yml)
[![Release](https://img.shields.io/github/v/release/rede97/autowire)](https://github.com/rede97/autowire/releases/latest)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)

Connectivity description is **HTML + script**. A browser runs the script; the live DOM is the netlist. Autowire takes the rendered result and writes SystemVerilog, which flows on to DV.

## Why

**Fast.** RTL analysis is Rust + rayon (parallel, incremental: unchanged files are reused from the index cache — a warm re-index of the demo SoC is ~0.1s vs ~1.4s cold). The connect engine is profiled and tuned (engine pipeline −20% in the 2.2.8 pass; see [docs/dev/core-perf.md](docs/dev/core-perf.md)). Index reads can switch to a JSON mirror that parses ~2x faster than XML for large workspaces.

**Built for AI agents.** One file — `autowire.js` — plus the `hdxml` binary is the whole install. `autowire init` drops an `AGENTS-AUTOWIRE.md` contract into the workspace so any agent picks up the project conventions with zero prompt engineering; `autowire help agent` is the machine-readable entry point. The full docs and runnable demos ship inside the bundle (`autowire docs unpack`) — an agent can drive a large project end to end (index → generate → simulate) with a handful of CLI commands and no bespoke tooling.

**Agents: run `bun index.ts help agent` first (working contract — do not invent a project prompt). Command index: `bun index.ts help`. Behavior changes must update `help/<topic>.txt` in lockstep. Format constraints live in [`docs/`](docs/README.md).**

## Design

| Question | Answer |
|---|---|
| Author input | One nestable HTML file: static tags + `<script>` |
| Rendering | A real browser runs `aw.js` (Custom Elements) |
| Debug / isolation | Playwright opens the local page headless; agents drive it through CDP like any frontend |
| Safety | Browser sandbox + `127.0.0.1`; the page never writes to disk |
| Persisting | The CLI reads `aw-render` from the rendered DOM and writes workspace RTL |
| Who writes the script | Anyone (human or agent) |

No parallel connectivity IR, no emacs process, no connect-specific MCP tool table.

## Method

- **Docs before implementation**: a step that is not landed in `help status` does not get built, and nobody fakes render/dump behavior.
- **Use cases constrain the backend**: headless CLI paths must pass the same web/golden tests — same HTML in, same RTL out.
- **Single source of truth**: usage and rationale live in `help/<topic>.txt`; format and implementation constraints live in `docs/`; the two stay in sync.

## Pipeline

```text
autowire.toml (filelists + macros)
    →  hdxml → RtlIndex (read-only, XML or JSON)
    →  HTML (aw-content + aw-submods)
    →  elaboration → aw-render
    →  connect run (reads aw-render, writes .sv)
    →  DV
```

Components, write-back rules, isolation, and entry stages: [docs/architecture.md](docs/architecture.md). Workspace config: [docs/workspace/toml.md](docs/workspace/toml.md). Connect dialect: [docs/connect/html.md](docs/connect/html.md). Rules summary: [docs/connect/rules.md](docs/connect/rules.md).

## Tools

| Tool | Role |
|---|---|
| `autowire` | Workspace CLI: analysis, connect, `plugin wishbone run`. Ships as a single-file `autowire.js` (run with Bun) |
| `hdxml` | Read-only RTL analysis → RtlIndex (Rust binary; Linux x86_64 glibc 2.17 / CentOS 7+, macOS arm64/x64, Windows x64) |
| Browser | Page rendering and debug; `connect run` uses happy-dom, no browser needed |

Release archives land on the GitHub Releases page, driven by the top entry of `CHANGELOG.md`.

## Quick start

```bash
bun autowire.js init mychip          # autowire.toml + AGENTS-AUTOWIRE.md + .autowire/hdxml/
# edit autowire.toml: point filelists at your RTL
bun autowire.js analysis run         # hdxml → RtlIndex (.autowire/hdxml)
bun autowire.js connect run          # render connect HTML, write .sv
bun autowire.js connect web          # inspect the live page (read-only)
```

Runnable examples: [`demo/soc`](demo/soc) (picorv32 SoC, Wishbone fabric, VCS + Verilator smoke) and [`demo/hbm`](demo/hbm) (16-channel fabric, UVM regression).

## Non-goals

- Connectivity as XML or one file per level as SoT (the RtlIndex is a read-only index, not the connectivity SoT)
- Connect-specific MCP tools (`outline`, `apply`, `rewrite`, …)
- The browser writing the workspace directly
- Two wiring semantics (web and CLI share one `aw.js` and one golden)
- Copying a connectivity prompt into every chip project (edit `help/agent.txt` instead)
- Wiring details inside `autowire.toml` (its `[connect]` section is only a list of HTML paths)

## License

[GPL-3.0](LICENSE)
