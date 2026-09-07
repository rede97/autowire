// Command and topic help. Keep in sync when behavior changes; do not invent a second prompt.
// Print: `bun index.ts help` | `bun index.ts help agent` | `autowire help <topic>`

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
Autowire — Agent contract

This topic is the working contract; do not invent a separate project prompt.
Other topics are command/dialect reference: autowire help topics

What it is
  Connectivity is one HTML + <script>. After the browser runs the script, the live DOM is the netlist.
  Hand the render result to autowire; it writes RTL, then DV.
  Early path: aw.js + local web page; debug via Playwright (headless + Playwright MCP).
  Later: headless cli, locked by Web / Playwright goldens. No connection-specific MCP.

Pipeline
  autowire.toml (.f + svh / macros)
      →  hdxml → RtlIndex (read-only)
      →  HTML (aw-content + aw-submods)
      →  elaboration → aw-render
      →  POST /api/dump (every related aw-render)
      →  autowire writes .sv → DV

You can do now
  1. Follow help dont; use help status for landed vs not landed.
  2. autowire init / analysis / deps for workspace + RtlIndex.
  3. Author connect HTML per docs/connect-html.md (even if aw.js is not landed).
  4. Until web / dump / cli land: do not pretend render or dump works.

After web lands
  1. autowire web [html]; wait for first paint (or #aw-status when GET params auto-run).
  2. Playwright MCP: navigate / snapshot / evaluate / click — inspect live DOM, not source HTML.
  3. Dump via same-origin POST /api/dump; browser must not write the workspace.
  4. Do not build cli before Web cases and goldens exist.

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
  Playwright env            headless Chromium; MCP via .mcp.json (127.0.0.1 only)

Not landed (do in this order; do not skip)
  aw.js + constrained HTML custom elements
  autowire web [html]
  POST /api/dump
  Playwright cases / golden
  autowire cli

Parallel (does not block connect)
  Register Table + Block/Cell
  Leaf port tables from RtlIndex (read-only on the connect page)
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

Dirs
  .autowire/          generated temp (deletable; never hand-authored)
  .autowire/hdxml/    RtlIndex XML
  .autowire/connect/  elaborated aw-render snapshots (dump/cli input; not author HTML)

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
  autowire analysis [--workspace dir|file] [--hdxml bin] [--sub-bars]

init: create default autowire.toml in CWD (refuses to overwrite).
analysis: load toml (upward from CWD, or --workspace) and run hdxml with mapped args
(docs/workspace-toml.md):
  [analysis.rtl] filelists / sources / walk_dirs / exclude_filenames
      → -f / -s / -w / --exclude-filenames
  [analysis.defines] NAME="v" → -D NAME=v
  [analysis] keep_raw = [...] → --keep-raw
  [analysis.index] dir → --xml (default .autowire/hdxml)
  [hdxml] bin → binary path only (not an hdxml arg; must exist if set)

hdxml binary lookup: --hdxml > toml [hdxml] bin > $HDXML_BIN
  > repo hdxml/target/{release,debug} > PATH
hdxml never reads toml; autowire maps everything.
Paths in toml are relative to the workspace root (toml location).
No [analysis.rtl] sources configured → error.
Error files keep the index usable; hdxml exit code is passed through.
`,

	connect: `\
Connect HTML dialect (draft; not landed as aw.js)

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
aw-connect@to / aw-param@expr / aw-template@inst_name: variable expressions only (no $1).
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
autowire web (not landed)

  autowire web [html]

Local HTTP page for headed browsers and headless Chromium.
Layout / GET action contract: docs/web-ui.md.

Page: header [Render] [Dump] [Reset]; left = dep tree + db summary;
right = selected module (RtlIndex read-only; aw-render preview after render).

GET
  no params     load only; buttons trigger actions (human)
  with params   auto-run select=MODULE → render=1 → dump=1
                (dump implies render; order fixed)
  done signal   #aw-status[data-state=done|error]

Endpoints: GET /api/rtlindex, GET /api/module?name=, POST /api/dump (only write path).
Isolation: 127.0.0.1 / localhost only. File writes only via autowire API.
Agent workflow: help agent.
`,

	dump: `\
Dump / write-back (not landed; pairs with autowire web)

  POST same-origin /api/dump

Browser does not touch disk. Body = every related aw-mod aw-render
(nested submods + multi-HTML units per [connect.<id>] deps): instances / aw-connect /
export aw-port / aw-signals / aw-localparams / aw-imports — not aw-content.
Server should persist snapshots under .autowire/connect/ then emit SV; dump must not
re-load author HTML as the netlist.
SV import from aw-imports at module head, deduped.
autowire checks workspace paths then writes RTL; DV checks files.

web and future cli must share this write path.
Do not treat hand-rolled fake-dump scripts as the official path.
`,

	cli: `\
autowire cli (later; do not build now)

  autowire cli phy.html --dump gen/

Build only after Web / Playwright tests and goldens are stable.
Same aw.js extract logic (in-process or headless browser).
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
  connection-specific MCP (outline, apply, rewrite, …)
  browser writing the workspace directly
  build cli before Web cases
  two wiring semantics (Web and cli must share aw.js + goldens)
  copy a per-chip connect prompt (edit help agent / src/help.ts instead)
  make README a second contract without updating help
  put wiring into autowire.toml ([connect.<id>] allows only html= + deps= — no top, no wiring)
  patch aw-render after it is filled (lifecycle: only before-instances + on-template may write; before-dump is read-only)
  rely on document-order "forward" sibling refs inside aw-submods (use aw-mod@deps; visible set accumulates down the path)
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
		"  web [html]                local render page (not landed) → help web | dump",
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
