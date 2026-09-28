# Autowire

HTML plus `<script>` is the connectivity source. After the script runs, the live DOM is the netlist. `connect run` writes `.sv` from `aw-render`. The page shows the same text and does not write the workspace. Product overview: [`README.md`](README.md). Constraints: [`docs/`](docs/README.md).

Start with `bun index.ts help agent`. Do not invent a command that `help status` does not list as landed. Behavior changes MUST update `src/cli/help.ts` and the matching doc.

## Tools

Three processes, never linked into one binary. Details: [`docs/dev/release.md`](docs/dev/release.md). The 0.9.1 release CI on `main` (`.github/workflows/release.yml`) publishes `hdxml` (Linux x64 glibc 2.17, macOS arm64/x64) and single-file `autowire.js`; obscura, the installer, and the compiled `out/autowire` are still parked.

| Tool | Owns | Does not | Help |
|---|---|---|---|
| autowire | Workspace CLI: analysis, connect, `plugin wishbone run`. `connect run` writes `.sv` with happy-dom, no browser. Tests use `bun index.ts`. Production is `out/autowire.js` (one Bun script: deps, page assets, gzip of `docs/` and every `demo/`) or `out/autowire` (that script plus the Bun runtime). Unpack with `docs unpack <dir>`. See [`docs/dev/release.md`](docs/dev/release.md) section 1.1 | RTL parse; a bundled browser; shipping `index.ts` or `node_modules` | Dev/CI: `bun index.ts help`, `help topics`, `help docs`. Production: `autowire help` or `bun autowire.js help` |
| hdxml | Read-only RTL analysis to RtlIndex XML. No subcommands. `analysis run` maps `autowire.toml` onto its flags | Connect, print `.sv`, Wishbone | [`docs/hdxml/cli.md`](docs/hdxml/cli.md). Scoped rules: [`hdxml/AGENTS.md`](hdxml/AGENTS.md) |
| Playwright + Chromium | Dev and CI page tests and debug (`test/e2e-web.test.ts`, `.mcp.json`) | Production package; writing `.sv` | Page contract: [`docs/workspace/web-ui.md`](docs/workspace/web-ui.md) |
| obscura | Production debug browser only (`mcp`, `serve`; CDP, CentOS 7-compatible build). Same HTML as happy-dom | Dev/CI today; writing `.sv`. Do not switch `.mcp.json` to it until the package exists | [`docs/dev/release.md`](docs/dev/release.md) sections 1-2; CDP pattern: [`docs/dev/cdp-debug.md`](docs/dev/cdp-debug.md) |

Usual path: `analysis run` (hdxml) -> `plugin wishbone run` when the TypeScript SoT changed -> `connect check` -> `connect run`. Open `connect web` and drive it with Playwright only to inspect the live page. The page does not write files.

Any CDP-speaking headless browser can drive the page (Playwright is only the client). Pattern + helpers: [`docs/dev/cdp-debug.md`](docs/dev/cdp-debug.md), `scripts/cdp-helper.ts`, or `help cdp`.

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

Generated and MUST NOT be hand-edited: `web/aw.js`, `web/page.js` (`bun run build:web`), `rtl/gen/`, `plugins_dir/`, and `fw/gen/`. `demo/soc/ip/sdspi` stays at upstream `dfb16c8`; its FIFO patch is applied only for a smoke and then discarded.

## Constraints

- Comments, errors, and CLI text MUST be English. Chinese is allowed in `docs/`. `test/lang-guard.test.ts` fails on CJK in TypeScript.
- `bun run lint` (`biome check .` and `tsc --noEmit`) MUST be clean before a commit.
- Windows toolchain is MSYS2 UCRT64. PATH gets `C:\msys64\ucrt64\bin` only. Git Bash is not that shell. Line endings are LF. See [`docs/dev/windows-msys2.md`](docs/dev/windows-msys2.md).
- `.svh` MUST NOT appear in a filelist. Macros come from `` `include `` or `define_headers`.
- The page and its GET APIs MUST NOT write the workspace. Saving is a browser download or the driver storing `#aw-generated`.
- Do not implement parked work: the installer and the production-browser (obscura) .mcp.json switch, HTML node-edit MCP, plugin type B, extra Wishbone policies in `docs/plugins/wishbone-bus.md` section 8, or a second `autowire.toml`. Dev and CI stay on Playwright Chromium. The two autowire artifacts in section 1.1 are already specified.

`hdxml/` has its own [`AGENTS.md`](hdxml/AGENTS.md). Demo smoke is `demo/soc/sim/verilator/run.sh` from `demo/soc` under UCRT64; see [`docs/skills/autowire-soc-integration.md`](docs/skills/autowire-soc-integration.md).
