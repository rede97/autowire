// Agent onboarding text. Keep in sync when behavior changes; do not invent a second prompt.
// Print: `bun index.ts help` or `autowire help [topic]`

export const HELP_TOPICS = [
  "agent",
  "status",
  "workspace",
  "analysis",
  "connect",
  "web",
  "dump",
  "cli",
  "deps",
  "dont",
] as const;

export type HelpTopic = (typeof HELP_TOPICS)[number];

const SECTIONS: Record<HelpTopic, string> = {
  agent: `\
Autowire — Agent onboarding

Read this before editing. This output is the working contract; do not invent a separate project prompt.
Slices: autowire help <topic>   topic = ${HELP_TOPICS.join(" | ")}

What it is
  Connectivity is one HTML + <script>. After the browser runs the script, the live DOM is the netlist.
  Hand the render result to autowire; it writes RTL, then DV.

  Early autowire is a Web front-end library (aw.js custom elements + local page).
  Isolation and debug go through Playwright (headless + Playwright MCP).
  Once page cases and goldens exist, they constrain a fully headless cli.
  Do not build a connection-specific MCP.

Why
  Author input    nested HTML, static tags + <script>
  Render          real browser runs aw.js (Custom Elements)
  Debug / isolate Playwright headless on the local page; Agent uses Playwright MCP
  Safety          browser sandbox + 127.0.0.1; page must not write the workspace
  Dump            POST render → autowire Web API → write workspace RTL → DV
  Who writes script  either human or Agent
  Headless CLI    later; must pass existing Web / Playwright tests and goldens

  No parallel connection IR, no emacs process, no connection-specific MCP tool table.

You can do now
  1. Read this help; follow the dont rules.
  2. Use deps for leaf RTL hierarchy (RtlIndex / hdxml).
  3. Author connect HTML per docs/connect-html.md (even if aw.js is not landed yet).
  4. Until web / dump / cli land: do not pretend render or dump works; build library + tests first.

After web lands (connect flow)
  1. Start in the workspace: autowire web [html]
  2. Wait for first paint (aw.js defined, scripts finished).
  3. Attach Playwright MCP headless Chromium: navigate / snapshot / evaluate.
     Inspect the live DOM (accessible names), not the source HTML text.
  4. To dump: POST same-origin /api/dump from the page or Playwright.
     Browser does not write disk; autowire checks workspace paths and writes .sv; DV checks files.
  5. Machines without a browser wait for cli; cli must pass existing Web cases first—do not build cli first.

Pipeline
  autowire.toml (.f + svh / macros)
      →  hdxml → RtlIndex (read-only)
      →  HTML (aw-content + aw-submods)
      →  elaboration → aw-render (params top-down; template; wires bottom-up)
      →  POST /api/dump (read aw-render)
      →  autowire writes .sv
      →  DV
`,

  analysis: `\
autowire init / autowire analysis (landed)

  autowire init                 create default autowire.toml in CWD (refuses to overwrite)
  autowire analysis [--workspace dir|file] [--hdxml bin] [--sub-bars]

analysis loads autowire.toml (upward from CWD, or --workspace) and runs hdxml
analysis with mapped args (contract: docs/workspace-toml.md):
  [analysis.rtl] filelists / sources / walk_dirs / exclude_filenames -> -f / -s / -w / --exclude-filenames
  [analysis.rtl] incdirs -> -I;  [analysis] define_headers -> --define-headers
  [analysis.defines] NAME="v" -> -D NAME=v  (expanding macros only)
  [analysis] keep_raw = [...] -> --keep-raw (raw macros; empty-string convention removed)
  [analysis.index] dir -> --xml (default .autowire/hdxml under workspace root)
hdxml never reads the toml itself; autowire maps and passes everything.
Macro scope: toml/CLI defines are a uniform pre_defines seed for every file;
per-file \`define does not leak across files (each file preprocessed independently).
Paths in toml are relative to the workspace root (toml location).
No [rtl] sources configured -> error. Error files keep the index usable but
the hdxml exit code is passed through (CI can gate on it).
`,

  status: `\
Current status (code is truth; do not invent finished commands)

Landed
  autowire help [topic]     this text
  autowire deps <path>      RTL module dependency tree
                            path = RtlIndex dir (with index.xml)
                                 or RTL source dir (hdxml sidecar analysis first)
  autowire init / analysis  workspace autowire.toml → hdxml (docs/workspace-toml.md)
  hdxml sidecar             Rust; analysis → RtlIndex XML; read-only consumer
  Playwright env            headless Chromium installed; Playwright MCP via .mcp.json
                            (--headless --isolated; only 127.0.0.1/localhost origins)

Not landed (do in this order; do not skip)
  aw.js + constrained HTML custom elements
  autowire web [html]       local HTTP render page
  POST /api/dump            browser does not write disk; autowire writes workspace RTL
  Playwright cases / golden same HTML → same RTL
  autowire cli              fully headless; must be locked by the cases above

Parallel, does not block connect
  Register Table + Block/Cell (types are data; Excel is docs only)
  Leaf port tables from RtlIndex feed the connect page read-only
`,

  workspace: `\
Workspace config autowire.toml (landed: init / analysis; see help analysis)
Full constraints: docs/workspace-toml.md

One top-level config shared by deps / web / cli for the RTL universe:
  source entry .f (and walk/sources)
  macros: defines + define .svh (aligns with hdxml --define-headers)
  incdirs, dump RTL out dir, etc.

Dirs
  .autowire/          fixed generated temp dir (deletable; never hand-authored)
  .autowire/hdxml/    RtlIndex XML index lives here
  [dump] dir="gen"    dumped RTL output (product for DV; not under .autowire)

Macro policy (hdxml) — raw by default
  only explicitly-valued macros expand: -D NAME=VALUE / toml [analysis.defines] NAME="v"
  define-headers + keep_raw macros stay raw: sentinel __MACRO__DEFINE__NAME,
  \`ifdef still true; dump restores via strip_prefix; override order headers < -D < keep_raw
  toml: [analysis] keep_raw=[...] is the only raw channel (empty-string removed)
  undeclared macro = DefineNotFound error (strict; no auto-registration)

Boundaries
  toml = project config (feed hdxml / check definesFp)
  HTML = connectivity SoT (do not put wiring in toml)
  not a return of the old stune mods_info.toml cache

Hooks into elaboration
  toml fixes macros + filelist → RtlIndex
  → params top-down → wires bottom-up (see help connect / docs/connect-html.md)
`,

  connect: `\
HTML dialect (connectivity SoT) — draft

Full constraints and examples (must follow for later impl; not landed yet):
  docs/connect-html.md         (skeleton / pipeline)
  docs/connect-rules.md        (template / rewrite / inst_name / param rules summary)
  docs/connect-lifecycle.md    (advanced: scripts on render lifecycle; no aw-rewrite@fn)
  docs/examples/connect/
  docs/workspace-toml.md       (.f / macros; hooks into connect)

Two layers; do not mix
  aw-content (author)   module params/ports; aw-template; inst + base/overwrite
  aw-render (result)    localparams / instances / signals / export ports / connects
  aw-submods            nested aw-mod deps (recursive); separate from content containment

Printer / dump / golden only accept each aw-mod's aw-render, not content/templates source.
rewrite is Web-style: JS RegExp match + String.replace ($1 / $<name>) only — no fn=;
not emacs []/@ syntax. aw-template@inst_name defaults to passthrough \${id}.
aw-connect@to, aw-param@expr, and aw-template@inst_name: variable expressions only
(e.g. \${idx}, module params); do not use regex capture placeholders ($1 / $<name>) there.
Advanced / irregular logic: embed scripts on elaboration lifecycle
(docs/connect-lifecycle.md); do not put callbacks on aw-rewrite.

Skeleton
  <autowire>
    <aw-mod name="…">
      <aw-content>  aw-imports / aw-params / aw-localparams / aw-ports / aw-templates / aw-insts  </aw-content>
      <aw-submods>  nested aw-mod …  </aw-submods>
      <aw-render>   aw-params / aw-imports / aw-localparams / aw-ports / aw-signals / aw-insts  </aw-render>
    </aw-mod>
  </autowire>

aw-template (style-like; only rule container under aw-inst)
  define with name= in library; under inst only aw-template (no bare connect/rewrite)
  overwrite: same tag <aw-template base>…child rules…</aw-template> (apply after base)
  multi-template: sibling aw-templates expand in order; later wins (also allowed)
  aw-template@inst_name defaults to \${id}; aw-rewrite match+to only; templates do not dump
  aw-imports: package imports auto-inherited bottom-up when interfaces reference packages
  aw-port: dir=input/output/inout/interface; dir=interface requires interface= type, optional modport=
  aw-param → aw-localparams (Mod__Inst__Param); fold constants / inherited module params
            / matching module-internal localparams; do not fold expressions or macros

Elaboration
  1) params top-down (classify fold + uniquify localparam) + aw-template@inst_name
  2) template/rewrite (match+to)  3) wires bottom-up / width rewrite → aw-render
  optional lifecycle hooks: docs/connect-lifecycle.md
  Quick rules: docs/connect-rules.md; full: docs/connect-html.md
`,

  web: `\
autowire web (early main entry; not landed)

  autowire web [html]

Local HTTP for headed browsers and for Agents headless.
Layout and GET action contract: docs/web-ui.md.

Page: header (title + [Render] [Dump] [Reset]); left = dep tree (RtlIndex
hierarchy, blackbox marked) + db summary (files/modules/packages/definesFp);
right = selected module info (RtlIndex params/imports/ports/instances;
aw-render preview only after render). Left/right data is RtlIndex read-only.

Two modes:
  no GET params   load only; NO action runs; buttons are the only trigger (human)
  with GET params auto-run fixed chain select=MODULE -> render=1 -> dump=1
                  (dump implies render; order fixed regardless of param order)
  completion: #aw-status[data-state=done|error] + document.title suffix;
              idle when no params. Playwright joins: no-param = first paint,
              with-params = wait for #aw-status[data-state].

Endpoints: GET /api/rtlindex, GET /api/module?name=, POST /api/dump (only write).

Agent uses only Playwright MCP (navigate / snapshot / evaluate / click),
like any front-end. Do not add outline / apply / rewrite MCP for connect.

Startup may be: web first, then Playwright MCP; or one script starts both.
Isolation: separate browser context; local page only.
Safety: render in the browser; file writes only via autowire API.
`,

  dump: `\
Dump / write-back

Browser does not touch disk. Page or Playwright POSTs each aw-mod's aw-render
to same-origin /api/dump (instances / aw-connect / export aw-port / aw-signals /
aw-localparams — not aw-content source).
autowire checks workspace paths then writes RTL. Correctness is DV on files, not by banning dump.

web and future cli must share the same write path.
Until landed, do not treat hand-rolled "fake dump" side scripts as the official path.
`,

  cli: `\
autowire cli (later; do not build now)

  autowire cli phy.html --dump gen/

After Web / Playwright tests and goldens are stable, build fully headless CLI.
Same aw.js extract logic (in-process or headless browser).

Cases constrain the backend: cli must pass existing Web tests (same HTML → same RTL).
Building cli before tests is not allowed.

deps and other RtlIndex queries may hang off cli, separate from connect render.
`,

  deps: `\
autowire deps — RTL module dependency tree (landed)

  bun index.ts deps <path>
  bun index.ts deps <path> --top <name> --depth <n>
  bun index.ts deps <rtl-dir> -I <incdir> --hdxml <bin>

<path>
  RtlIndex dir (with index.xml): read directly
  else treat as RTL source dir; run hdxml sidecar into .autowire/hdxml

hdxml lookup order
  --hdxml > $HDXML_BIN > repo hdxml/target/{release,debug}/hdxml > PATH

Output
  summary line: tool / files / modules / tops; error files in red
  one tree per top: top cyan, normal green, blackbox yellow, cycle red

Connect page reads port tables only; deps must not rewrite RTL.
`,

  dont: `\
Do not

  XML / one-file-per-level connectivity as SoT
  connection-specific MCP (outline, apply, rewrite, …)
  mcp / run / repl as the main entry
  browser writing the workspace directly
  build cli before Web cases
  two wiring semantics (Web and cli must share aw.js + goldens)
  copy a per-chip connect prompt (edit this help instead)
  make README a second contract without updating help
  put docs back under hdxml/docs/ (keep docs/)
  put connectivity into autowire.toml (toml is project config only)
`,
};

function topicsIndex(): string {
  return [
    "autowire help [topic]",
    "",
    "  agent     onboarding (default; full text when no topic)",
    "  status    landed / not landed",
    "  workspace top-level autowire.toml (.f / macros)",
    "  analysis  init + run hdxml with autowire.toml",
    "  connect   HTML dialect (author template vs render)",
    "  web       local page + Playwright",
    "  dump      write-back RTL",
    "  cli       later headless (tests first)",
    "  deps      RtlIndex dependency tree",
    "  dont      forbidden items",
    "",
  ].join("\n");
}

export function renderHelp(topic?: string): string {
  if (topic === "topics") return topicsIndex();
  if (!topic) {
    return HELP_TOPICS.map((t) => SECTIONS[t].trimEnd()).join("\n\n");
  }
  if ((HELP_TOPICS as readonly string[]).includes(topic)) {
    return SECTIONS[topic as HelpTopic].trimEnd() + "\n";
  }
  throw new Error(`unknown help topic: ${topic}\n\n${topicsIndex()}`);
}
