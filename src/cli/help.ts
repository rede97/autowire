// Command and topic help. Keep in sync when behavior changes; do not invent a second prompt.
// Print: `bun index.ts help` | `bun index.ts help agent` | `autowire help <topic>`

export const HELP_TOPICS = [
	"agent",
	"status",
	"workspace",
	"analysis",
	"connect",
	"web",
	"check",
	"dump",
	"cli",
	"deps",
	"dont",
] as const;

export type HelpTopic = (typeof HELP_TOPICS)[number];

const SECTIONS: Record<HelpTopic, string> = {
	agent: `\
Autowire — Agent contract

This topic is the working contract; do not invent a separate project prompt.
Other topics are command/dialect reference: autowire help topics

What it is
  Connectivity is one HTML + <script>. After the browser runs the script, the live DOM is the netlist.
  Hand the render result to autowire; it writes RTL, then DV.
  Early path: aw.js + local web page; debug via Playwright MCP (browser, isolated).
  Later: headless cli, locked by Web / Playwright goldens.
  MCP vs tools: tools own generate/check/render/dump; MCPs must not be a live netlist engine.
  Two MCP paths (docs/mcp/): Playwright = runtime debug; Workspace = author HTML + RtlIndex
  (edit/search/analysis) — not landed; generating still requires explicit Web tool path.

Pipeline
  autowire.toml (.f + svh / macros)
      →  hdxml → RtlIndex (read-only)
      →  HTML aw-content (+ aw-submods)
      →  check (author HTML legality + deps; no write; not aw-render)
      →  elaboration → aw-render
      →  POST /api/dump (every related aw-render)
      →  autowire writes .sv → DV

You can do now
  1. Follow help dont; use help status for landed vs not landed.
  2. autowire init / analysis / deps for workspace + RtlIndex.
  3. Author connect HTML per docs/connect-html.md.
  4. autowire web [unit]; wait for first paint (or #aw-status when GET params auto-run).
  2. Playwright MCP: navigate / snapshot / evaluate / click — inspect live DOM, not source HTML.
     Workspace MCP (docs/mcp/workspace.md, not landed): node-level author HTML edit + RtlIndex
     search; does not elaborate; call web for check/render/dump when results are needed.
  3. Run check on aw-content (legality + deps) separately from render/dump; dump should refuse unclean check.
  4. Dump via same-origin POST /api/dump (reads aw-render); browser must not write the workspace.
  5. Do not build cli before Web cases and goldens exist.

Rules of engagement
  Edit this help (src/help.ts) when behavior changes; format constraints live in docs/.
  Bun only (bun / bun test / bunx). Do not invent finished commands — help status is truth.
`,

	status: `\
Status (code is truth; do not invent finished commands)

Landed
  autowire help [topic]
  autowire init / analysis   workspace autowire.toml → hdxml
  autowire deps <path>      RTL module dependency tree
  hdxml sidecar             analysis → RtlIndex XML
  aw.js                     engine: src/core/aw.ts → build:web → web/aw.js (generated; guarded)
  autowire web [unit]       local page (127.0.0.1); buttons + GET ?check/?render/?dump/?select
  autowire check [unit]     author-face legality + deps (no write)
  POST /api/check|/api/dump validate-only / only RTL write path; snapshots → .autowire/connect/
  Playwright cases/golden   src/e2e-web.test.ts + test/golden/*.sv (headless Chromium)
  Playwright env            headless Chromium; MCP via .mcp.json (127.0.0.1 only)

Not landed
  autowire cli              build only after Web cases/goldens prove stable
  Workspace MCP             author HTML node edit + RtlIndex search (docs/mcp/workspace.md)

Parallel (does not block connect)
  Plugin registry (docs/plugins/): custom tags; generator vs elaborate kinds
  Wishbone regfile leaf (docs/plugins/wishbone-regfile.md)
  Wishbone IP-local cfg tree: bridge/arb/decoder + slice pipe (docs/plugins/wishbone-bus.md);
    default topology=tree not matrix; SoC interconnect stays with commercial EDA;
    firmware = memory window + DMA later (classic block-cycle writes; not thousands of Cells)

  Register Table + Block/Cell (data); Excel is documentation only
  Leaf port tables from RtlIndex (read-only on the connect page)
  Do not treat connect aw-submods as a code-gen hook — generators emit SV then aw-inst
`,

	workspace: `\
autowire.toml — workspace config

Full constraints: docs/workspace-toml.md
Commands: autowire init | autowire analysis  (see help analysis)

Shared by deps / web / cli for the RTL universe:
  [hdxml] bin="…"       hdxml binary path (unset: --hdxml > $HDXML_BIN > repo target > PATH)
  [analysis.*]  .f / sources / walk / incdirs / defines / keep_raw / index dir
  [connect.<id>]        named HTML unit: html= + optional deps= (DAG; no wiring)
  [dump] dir="gen"      dumped RTL output (not under .autowire)
  [style] param         inline (default) | localparam (Mod__Inst__Param folding)

Dirs
  .autowire/          generated temp (deletable; never hand-authored)
  .autowire/hdxml/    RtlIndex XML — web loads ONLY via GET /api/rtlindex|/api/module
  .autowire/connect/  per-unit snapshot: <id>.xml only (abstract module info,
                      hdxml-style, no timestamps/hashes) — dump + cross-unit deps
                      via GET /api/connect?id=; never author SoT; no html snapshot

Load rules (docs/workspace-toml.md §4.2 / docs/web-ui.md §5)
  leaf ports: hdxml only (missing/stale definesFp → error when needed)
  cross-unit: require dep unit snapshot under connect/ (or elaborate deps first)
  browser never reads workspace files directly; dump never reloads author html=

Macro policy (hdxml)
  expanding: -D / [analysis.defines] NAME="v"
  keep_raw: [analysis] keep_raw=[...] only (empty-string removed)
  undeclared macro = DefineNotFound (strict)

Boundaries
  toml = project config; HTML = connectivity SoT (no wiring in toml)
  connect deps: missing ref = error; unused dep = warn (at elaborate); cycle = error; DAG enables parallel elaborate
`,

	analysis: `\
autowire init / analysis (landed)

  autowire init
  autowire analysis [--workspace dir|file] [--hdxml bin] [--sub-bars] [--refresh]

init: create default autowire.toml in CWD (refuses to overwrite).
analysis: load toml (upward from CWD, or --workspace) and run hdxml with mapped args
(docs/workspace-toml.md):
  [analysis.rtl] filelists / sources / walk_dirs / exclude_filenames
      → -f / -s / -w / --exclude-filenames
  [analysis.defines] NAME="v" → -D NAME=v
  [analysis] keep_raw = [...] → --keep-raw
  [analysis.index] dir → -o/--output-dir (default .autowire/hdxml)
  [hdxml] bin → binary path only (not an hdxml arg; must exist if set)

hdxml binary lookup: --hdxml > toml [hdxml] bin > $HDXML_BIN
  > repo hdxml/target/{release,debug} > PATH
hdxml never reads toml; autowire maps everything.
Paths in toml are relative to the workspace root (toml location).
No [analysis.rtl] sources configured → error.
Error files keep the index usable; hdxml exit code is passed through.
--refresh: analysis is incremental by default — unchanged files are reused from the
  RtlIndex dir (mtime fast path, content-hash arbiter; \`include closure tracked;
  defines/incdirs/tool change → full re-parse). --refresh forces a full re-parse
  and rewrites the cache.
`,

	connect: `\
Connect HTML dialect (landed: web/aw.js)

Constraints:
  docs/connect-html.md
  docs/connect-rules.md
  docs/connect-lifecycle.md
  docs/examples/connect/
  docs/workspace-toml.md   ([connect.<id>] html + deps DAG;
                           missing cross-unit ref = error; unused dep = warn at elaborate)

Two layers; do not mix
  aw-content   imports / params / localparams / ports; aw-template; inst + overwrite
  aw-render    imports / localparams / instances / signals / export ports / connects
  aw-submods   nested aw-mod; sibling refs only via aw-mod@deps (path-accumulated visible set)

Dump / golden only accept aw-render (every related mod; nested + multi-HTML).
aw-rewrite: RegExp match + String.replace ($1 / $<name>) + \${…}; match+to only.
aw-connect@to: net (default) | const | open — const/open must declare type=; docs/connect-to-rules.md;
  aw-param@expr / aw-template@inst_name: variable expressions only (no $1).
aw-connect / aw-rewrite: optional packed (default auto from port; multi-dim RtlIndex form),
  unpacked, width (1-D packed shorthand), part (bit select), nettype (wire|logic; default wire);
  to is net name only — no [] suffix. See docs/connect-html.md §3.5.1–3.5.2;
  multidim example: docs/examples/connect/04-author-multidim.html.
Lifecycle scripts: docs/connect-lifecycle.md —
  before-instances (mutate aw-content) → on-template (per-inst expand) → aw-render frozen;
  before-dump read-only (no patching render).
Templates are per-aw-mod only. Connected nets → aw-signals; unconnected may auto-export ports.
aw-imports → SV import at module head (deduped).

Skeleton
  <autowire>
    <aw-mod name="…">
      <aw-content>  aw-imports / aw-params / aw-localparams / aw-ports / aw-templates / aw-insts  </aw-content>
      <aw-submods>  nested aw-mod (optional deps="sibling_a sibling_b") …  </aw-submods>
      <aw-render>   aw-params / aw-imports / aw-localparams / aw-ports / aw-signals / aw-insts  </aw-render>
    </aw-mod>
  </autowire>

aw-template: only rule container under aw-inst; overwrite / multi-template later wins.
aw-template@inst_name defaults to \${id}.
aw-port: dir=input|output|inout|interface; interface requires interface=, optional modport=.
aw-param → Mod__Inst__Param; fold constants / inherited params / internal localparams;
           do not fold expressions or macros.

Elaboration: before-instances → params → on-template → wires → frozen aw-render → before-dump.
`,

	web: `\
autowire web (landed)

  autowire web [html]

Local HTTP page for headed browsers and headless Chromium.
Layout / GET action contract: docs/web-ui.md.

Page: header must expose [Render] [Check] [Dump] [Reset] for humans;
  left = dep tree + db summary;
  right = selected module (RtlIndex read-only; aw-render preview after render).
  [Check] validates aw-content (author), NOT aw-render; Check has no prerequisite.
  [Render] depends on Check (auto-runs Check first; abort render on check errors).
  [Dump] depends on Render (thus Check); dump reads aw-render only.

GET (same actions / same prereqs; docs/web-ui.md §3)
  no action params   load only; use header buttons
  ?check=1           validate aw-content + deps only (no render, no .sv)
  ?render=1          check → render (render depends on check)
  ?dump=1            check → render → dump
  ?select=MOD&…      select then the requested actions; order: check → render → dump
  done signal        #aw-status[data-state=done|error]

Endpoints: GET /api/rtlindex, GET /api/module?name=  (.autowire/hdxml),
  GET /api/connect?id= (.autowire/connect <id>.xml snapshots; not author HTML),
  POST /api/check (validate only), POST /api/dump (only RTL write path; may refresh connect/).
Isolation: 127.0.0.1 / localhost only. File writes only via autowire API.
Agent workflow: help agent.
`,

	check: `\
autowire check (landed; separate from dump / render)

  autowire check [html|workspace]
  POST same-origin /api/check

Validate author-face connect HTML (aw-content + aw-submods) and dependency graphs.
Does NOT inspect aw-render as SoT. Does NOT write .sv / gen/. Does NOT require render.

Must check
  dialect constraints on aw-content (docs/connect-html.md / connect-rules.md)
  [connect.<id>] toml deps: missing ref = error; unused = warn; cycle = error
  aw-mod@deps + path-accumulated visible set (same discipline; refs seen in content)

Not check's job
  aw-render dumpability (no leftover template/rewrite) — dump gate after render

Web header [Check] / GET ?check=1 / POST /api/check / cli --check share the same checker.
Render depends on Check (auto-check before elaborate). Dump depends on Render.
See docs/web-ui.md §3.1 and docs/architecture.md.
`,

	dump: `\
Dump / write-back (landed; pairs with autowire web)

  POST same-origin /api/dump

Browser does not touch disk. Body = every related aw-mod aw-render
(nested submods + multi-HTML units per [connect.<id>] deps): instances / aw-connect /
export aw-port / aw-signals / aw-localparams / aw-imports — not aw-content.
Server persists the <id>.xml abstract-module snapshot under .autowire/connect/
then emits SV; dump must not re-load author HTML as the netlist.
SV import from aw-imports at module head, deduped.
autowire checks workspace paths then writes RTL; DV checks files.
Dump is not a substitute for check — content check (aw-content) before render/write.
Dump requires render (render already required check); refuse on check or unclean-render errors.

web and future cli must share this write path.
Do not treat hand-rolled fake-dump scripts as the official path.
`,

	cli: `\
autowire cli (later; do not build now)

  autowire cli phy.html --check
  autowire cli phy.html --dump gen/

Build only after Web / Playwright tests and goldens are stable.
Same aw.js extract logic (in-process or headless browser).
--check validates only; --dump writes RTL and should imply --check.
cli must pass existing Web tests (same HTML → same RTL).
Building cli before tests is not allowed.
`,

	deps: `\
autowire deps (landed)

  bun index.ts deps <path>
  bun index.ts deps <path> --top <name> --depth <n>
  bun index.ts deps <rtl-dir> -I <incdir> --hdxml <bin>

<path>
  RtlIndex dir (with index.xml): read directly
  else RTL source dir → hdxml sidecar into .autowire/hdxml

hdxml lookup: --hdxml > $HDXML_BIN > repo hdxml/target/{release,debug}/hdxml > PATH

Output
  summary: tool / files / modules / tops; error files in red
  trees: top cyan, normal green, blackbox yellow, cycle red

deps must not rewrite RTL; connect page reads port tables read-only.
`,

	dont: `\
Do not

  connectivity SoT in XML / one-file-per-level files (RtlIndex XML is an index, not connectivity)
  blur tools vs MCP: no MCP that mutates connect and returns live netlist/RTL in-process
    (old outline/apply/rewrite all-in-one). Allowed: Playwright MCP (debug) and Workspace MCP
    (author-file edit + RtlIndex query; docs/mcp/) — generate still via web/cli tools only
  browser writing the workspace directly
  build cli before Web cases
  two wiring semantics (Web and cli must share aw.js + goldens)
  copy a per-chip connect prompt (edit help agent / src/help.ts instead)
  make README a second contract without updating help
  put wiring into autowire.toml ([connect.<id>] allows only html= + deps= — no top, no wiring)
  patch aw-render after it is filled (lifecycle: only before-instances + on-template may write; before-dump is read-only)
  rely on document-order "forward" sibling refs inside aw-submods (use aw-mod@deps; visible set accumulates down the path)
  treat dump as the only validation (use autowire check on aw-content + deps; dump reads aw-render)
  require render before check (wrong direction: Render depends on Check; Check does not depend on Render)
  skip check before render or dump (?render=1 / [Render] must auto-run Check first)
  generate regfile/cfgbus from connect aw-submods custom tags (register a generator plugin; docs/plugins/)
  treat Workspace MCP html_write as elaborate (must still run web check/render/dump for netlist)
`,
};

/** Default `autowire help` — command index + one-line Agent pointer. */
function commandIndex(): string {
	return [
		"Autowire — commands",
		"",
		"  help [topic]              topic reference (see help topics)",
		"  init                      create default autowire.toml in CWD",
		"  analysis [options]        run hdxml from autowire.toml   → help analysis | workspace",
		"  deps <path> [options]     RTL module dependency tree     → help deps",
		"  web [unit]                local connect page → help web | check | dump",
		"  check [unit]              validate HTML + deps (no write) → help check",
		"  cli …                     headless later (not landed)    → help cli",
		"",
		"Also: help status | connect | dont",
		"Docs: docs/   (format constraints; keep in sync with help)",
		"",
		"Agents: run `bun index.ts help agent` — that is the working contract; do not invent a project prompt.",
		"",
	].join("\n");
}

function topicsIndex(): string {
	return [
		"autowire help [topic]",
		"",
		"  agent      Agent contract (read this before editing)",
		"  status     landed / not landed",
		"  workspace  autowire.toml",
		"  analysis   init + analysis",
		"  connect    HTML dialect",
		"  web        local page",
		"  check      validate HTML + deps",
		"  dump       write-back RTL",
		"  cli        later headless",
		"  deps       dependency tree",
		"  dont       forbidden items",
		"",
		"Default (no topic): command index.",
		"",
	].join("\n");
}

export function renderHelp(topic?: string): string {
	if (topic === "topics") return topicsIndex();
	if (!topic) return commandIndex();
	if ((HELP_TOPICS as readonly string[]).includes(topic)) {
		return `${SECTIONS[topic as HelpTopic].trimEnd()}\n`;
	}
	throw new Error(`unknown help topic: ${topic}\n\n${topicsIndex()}`);
}
