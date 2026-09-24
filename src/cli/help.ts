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
  3. Author connect HTML per docs/connect/html.md.
  4. autowire web [unit]; wait for first paint (or #aw-status when GET params auto-run).
  2. Playwright MCP: navigate / snapshot / evaluate / click — inspect live DOM, not source HTML.
     Workspace MCP (docs/mcp/workspace.md, not landed): node-level author HTML edit + RtlIndex
     search; does not elaborate; call web for check/render/dump when results are needed.
  3. Run check on aw-content (legality + deps) separately from render/dump; dump should refuse unclean check.
  4. Dump via same-origin POST /api/dump (reads aw-render); browser must not write the workspace.
  5. Do not build cli before Web cases and goldens exist.

Rules of engagement
  Edit this help (src/cli/help.ts) when behavior changes; format constraints live in docs/.
  Bun only (bun / bun test / bunx). Do not invent finished commands — help status is truth.
  Connect authoring (docs/connect/html.md §3.5.5): same-name → identity (omit);
    rename batch → one aw-rewrite RegExp — never list identity ports one-by-one.
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
  aw-tb-mod / [sim.<id>]    TB top + type=raw + body includes; dump → sim_dir

Not landed
  autowire cli              build only after Web cases/goldens prove stable
  Workspace MCP             author HTML node edit + RtlIndex search (docs/mcp/workspace.md)

Parallel (does not block connect)
  Plugin registry (docs/plugins/): type A = generate → plugins_dir → analysis/RtlIndex leaf
    (hash incremental; no plugin-private port API);
    type B = expand → core aw-* like submods (childRenders); then check → elaborate;
    orchestration: expand/before-instances before check (docs/connect/lifecycle.md §3.1)
  Wishbone — implementing now (docs/plugins/wishbone-regfile.md + wishbone-bus.md);
    one plugin id wishbone (aliases wishbone-regfile / wishbone-bus warn + same generate);
    two DSL types stay: RegfileDef vs BusDef (no merged IR);
    draft API + samples: docs/examples/regfile/regfile.ts;
    toml [wishbone.<source>] ts= (one file may export either or both; optional exports=);
    [plugins.wishbone] packed software (SoT exports only; no reverse to TS):
    export= Excel (field sheets + MAP_<bus> address map; trunk columns; leaf offset;
    no empty A / ADDRWIDTH), c= C dir (layout .h + <bus>_map.h + wishbone.h umbrella),
    uvm= uvm_reg dir (ral_<SHEET>.sv + ral_block_* + ral_wishbone.sv; not .ralf);
    git-tracked showcase fw/gen/wishbone (do not delete);
    generate: listed + attached-leaf SV, then fabric/wrapper; RTL → plugins_dir/wishbone/;
    demo/soc: one sha256_regfile RTL, one hang per sd_sha channel via SlaveRegfile;
    C sha256.h; smoke identity-match (id = RegfileDef.name);
    firmware uses generated cell unions; soc_map.h aliases software map macros;
    SoT = TypeScript exports; no HTML field tree;
    attached leaves are inside the bus Type-A wrapper (no HTML *_regfile inst);
    string slaves (SRAM/UART) stay aw-inst (prefer SlaveRegion+Size);
    SlaveBus is SlaveRegion sugar: hang a child BusDef as a window; child RTL
    once, N instances; child Master("uplink") remaps to i_wb_* / o_wb_* on
    <bus>_system; parent forwards window-offset ADR (adr & ~mask);
    demo: top soc_wb is a CPU decoder; two SlaveBus(sd_sha) channels (ch0/ch1);
    HTML sot/connect/sd_sha_ch.html wraps sd+dma+sha256wb; DMA SRC is relative;
    channel DMA cannot reach parent SRAM/flash (no downlink);
    no awx-regfile;
    sheet empty = name (C/UVM/Excel stem); shared sheet = one header if two names
    share layout; same sheet + different layout → generate error;
    toml ts= not html=;
    C/UVM/Excel field-layout emit: per-cell struct+bitfield / uvm_reg /
    trunk sheet; shadow as comments; Excel documents leaf cell offset;
    address map + TGA/shadow tag packed in the same Excel / C / uvm_reg set;
    DAT=32 ADR=byte; write posted at fabric slave PIPE / read blocks to leaf;
    RWE read_write_block default false (posted fabric: true risks bus lock);
    WB ports {name}_i_wb_*/{name}_o_wb_*; sideband Access prefixes (ro_/rg_/ext_/p_rg_/c_rg_);
    SEL byte-masked writes (RW/RWW RMW, W1C/W1P masked); RWE ext_<field>_wstrb;
    W1C c_rg_<field>_set hw set (set wins); RWW same-cycle SW > HW;
    RWE o_<shadow>_sel (lowest set bit) + optional ext_<field>_ready;
    Access RC = ReadConst (reset= baked readback);
    wide-field split: comments/desc name[hi:lo] of [W-1:0] (index 0 = LSB);
    named slaves {slave}_i_wb_*/o_wb_* (identity-match regfile); NM<=1 → decoder;
    NM>1 → interconnect (arbiter: rb_grant_en 0=fixed lowest-index /
    1=round-robin after last grant); masters named {m}_o_wb_*/{m}_i_wb_{dat,ack};
    demo/soc: smoke FABRIC.rb_grant_en (reset 0) drives each channel rb_grant_en;
    basic_smoke checks cascade SHA MMIO + grant CSR; --sd is channel DMA+SHA;
    demo/soc sot/wb_bus_soc.ts → soc_wb_decoder + soc_wb_system;
    sot/wb_bus_sd_sha.ts → sd_sha_interconnect + sd_sha_system (mixed slave PIPE);
    ADR=byte; fabric addr_width parametrized;
    TGA: Bus tagWidth? / Slave tag? → {m}_o_wb_tga in, {slave}_i_wb_tga out;
    slave PIPE: Slave(..., { pipe: N }) instantiates wb_cfg_pipe (posted write /
    blocking read; PIPE=0 combo; TGA ports always on the module, omitted at
    instance when Slave has no tag);
    master PIPE is parent-defined, not on this bus;
    decode: localparam SLOT_<SLAVE> indexes slot_sel (no bare slot_sel[6]);
    SlaveRegion(name, desc, base, Size(bytes), { pipe?, tag? }): string window by
    span; decode mask = pow2 ceil(Size); (base & mask) === base;
    Slave(name, desc, base, mask, ...) is a raw port (no overlap check);
    SlaveRegfile is SlaveRegion sugar: Size(layout span) + leaf; optional size=;
    SlaveBus is SlaveRegion sugar: Size(child span) + child BusDef; optional size=;
    child must declare Master("uplink") (cascade face);
    Bus rejects overlapping Region/Regfile/SlaveBus windows; raw Slave is excluded;
    tag defaults to leaf tga_width; TGA must match; id defaults to RegfileDef.name;
    Type-A wrapper <bus>_system instantiates interconnect + attached *_regfile
    (sidebands promoted; WB internalized; HTML aw-inst soc_wb_system / sd_sha_system);
    uplink master ports become i_wb_* / o_wb_* on the child wrapper
  Register Table + Block/Cell (data); Excel is documentation only
  Leaf port tables from RtlIndex (read-only on the connect page)
  Do not treat connect aw-submods as a code-gen hook — generators emit SV then aw-inst
`,

	workspace: `\
autowire.toml — workspace config

Full constraints: docs/workspace/toml.md
Commands: autowire init | autowire analysis  (see help analysis)

Shared by deps / web / cli for the RTL universe:
  [hdxml] bin="…"       hdxml binary path (unset: --hdxml > $HDXML_BIN > repo target > PATH)
  [analysis.*]  .f / sources / walk / incdirs / defines / keep_raw / index dir
  Author SoT            one tree (demo: sot/): connect HTML under sot/connect/;
                        wishbone ts= as wb_reg_*.ts / wb_bus_*.ts;
                        sim HTML stays under sim/ (DE vs DV)
  [connect.<id>]        DE unit: html= + optional deps= (DAG; aw-mod root; → connect_dir)
  [sim.<id>]            DV TB unit: html= under sim/; aw-tb-mod root; deps may list
                        connect ids; dump → sim_dir (no .autowire/connect XML)
  [wishbone.<source>]   wishbone SoT file: ts=; optional exports=[]; omit = all
                        RegfileDef and/or BusDef exports (types stay separate)
  [plugins.wishbone]    packed software: export= Excel (field sheets + MAP_*);
                        c= C dir (layout + map + wishbone.h); uvm= uvm_reg dir
  [dump]                product dirs (docs §4.0; legacy dir= still accepted with warn):
                        connect_dir="gen/connect"  DE wrappers
                        sim_dir="gen/sim"          DV TB tops
                        plugins_dir="gen/plugins"  type-A plugins; subdirs per plugin id
                        dir="gen"                  deprecated single sink (compat warn)
                        demo/soc dump → rtl/gen/{connect,sim,plugins}
  [style] param_inline      true (default) inline simple overrides | false: fold all to Mod__Inst__Param
  [style] port_align        declaration port columns: dir / type / packed, names left-aligned (default false)
  [style] param_align       declaration parameter = column (default false)
  [style] inst_port_align   instantiation .port ( column alignment (default false)
  [style] inst_param_align  instantiation .PARAM ( column alignment (default false)
  [style] signal_align      internal signal columns: nettype / packed, names left-aligned (default false)
  [style] localparam_upper  uppercase generated Mod__Inst__Param names (default false)

Dirs
  .autowire/          generated temp (deletable; never hand-authored)
  .autowire/hdxml/    RtlIndex XML — web loads ONLY via GET /api/rtlindex|/api/module
  .autowire/connect/  per-unit snapshot: <id>.xml only (abstract module info,
                      hdxml-style, no timestamps/hashes) — dump + cross-unit deps
                      via GET /api/connect?id=; never author SoT; no html snapshot
  .autowire/save/     debug drop: POST /api/save persists live DOM <id>.html
                      (edited aw-content + aw-render) — temp, never author SoT

Load rules (docs/workspace/toml.md §4.2 / docs/workspace/web-ui.md §5)
  leaf ports: hdxml only (missing/stale definesFp → error when needed)
  cross-unit: require dep unit snapshot under connect/ (or elaborate deps first)
  browser never reads workspace files directly; dump never reloads author html=

Macro policy (hdxml)
  expanding: -D / [analysis.defines] NAME="v"
  keep_raw: [analysis] keep_raw=[...] only (empty-string removed)
  undeclared macro = DefineNotFound (strict)

Boundaries
  toml = project config; HTML = connectivity SoT (no wiring in toml)
  DE vs DV: [connect.*] vs [sim.*] — separate HTML trees; never one file for both
  connect deps: missing ref = error; unused dep = warn (at elaborate); cycle = error; DAG enables parallel elaborate
`,

	analysis: `\
autowire init / analysis (landed)

  autowire init
  autowire analysis [--workspace dir|file] [--hdxml bin] [--sub-bars] [--refresh]

init: create default autowire.toml in CWD (refuses to overwrite).
analysis: load toml (upward from CWD, or --workspace) and run hdxml with mapped args
(docs/workspace/toml.md):
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
  docs/connect/html.md
  docs/connect/rules.md
  docs/connect/to-rules.md
  docs/connect/check.md
  docs/connect/lifecycle.md
  docs/examples/connect/
  docs/workspace/toml.md   ([connect.<id>] html + deps DAG;
                           missing cross-unit ref = error; unused dep = warn at check)

Two layers; do not mix
  aw-content   imports / params / localparams / ports; aw-template; inst + overwrite
  aw-render    imports / localparams / instances / signals / export ports / connects
  aw-submods   nested aw-mod; sibling refs only via aw-mod@deps (path-accumulated visible set)

Dump / golden only accept aw-render (every related mod; nested + multi-HTML).
aw-rewrite: RegExp match + String.replace ($1 / $& / $<name>) + \${…}; match+to only.
aw-connect@to: net (default) | const | open — const/open must declare type=; docs/connect/to-rules.md;
  same-name → identity (omit; not a warning); rename → prefer one aw-rewrite RegExp ($1/$&);
  do not list identity ports one-by-one; open/rename to avoid short circuits;
  aw-param@expr / aw-template@inst_name: variable expressions only (no $1).
aw-connect / aw-rewrite: optional packed (default auto from port; multi-dim RtlIndex form),
  unpacked, width (1-D packed shorthand), part (bit select), nettype (wire|logic; default wire);
  to is net name only — no [] suffix. See docs/connect/html.md §3.5.1–3.5.2;
  multidim example: docs/examples/connect/04-author-multidim.html.
Lifecycle scripts: docs/connect/lifecycle.md —
  target order: [B expand] → before-instances → check → elaborate (on-template) → aw-render frozen;
  before-dump read-only; type-A plugin generate stays outside this pipeline (docs/plugins/).
Templates are per-aw-mod only. Connected nets → aw-signals; identity/export may auto-export ports.
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

Elaboration: before-instances → params → on-template → identity nets → wires → frozen aw-render → before-dump.
  (Author-face mutators run before check when orchestration is aligned; docs/connect/lifecycle.md §3.1.)
`,

	web: `\
autowire web (landed)

  autowire web [html]

Local HTTP page for headed browsers and headless Chromium.
Layout / GET action contract: docs/workspace/web-ui.md.

Page: header must expose [Render] [Check] [Dump] [Reset] for humans;
  left = dep tree + db summary;
  right = selected module (RtlIndex read-only; aw-render preview after render).
  [Check] validates aw-content (author), NOT aw-render; Check has no prerequisite.
  [Render] depends on Check (auto-runs Check first; abort render on check errors).
  [Dump] depends on Render (thus Check); dump reads aw-render only.

GET (same actions / same prereqs; docs/workspace/web-ui.md §3)
  no action params   load only; use header buttons
  ?check=1           validate aw-content + deps only (no render, no .sv)
  ?render=1          check → render (render depends on check)
  ?dump=1            check → render → dump
  ?select=MOD&…      select then the requested actions; order: check → render → dump
  done signal        #aw-status[data-state=done|error]

Endpoints: GET /api/rtlindex, GET /api/module?name=  (.autowire/hdxml),
  GET /api/connect?id= (.autowire/connect <id>.xml snapshots; not author HTML),
  POST /api/check (validate only), POST /api/dump (only RTL write path; may refresh connect/),
  POST /api/save (debug drop → .autowire/save/<id>.html; browser never writes author HTML).
Isolation: 127.0.0.1 / localhost only. File writes only via autowire API.
Agent workflow: help agent.
`,

	check: `\
autowire check (landed; separate from dump / render)

  autowire check [html|workspace]
  POST same-origin /api/check

Validate author-face connect HTML (aw-content + aw-submods) and dependency graphs.
Does NOT inspect aw-render as SoT. Does NOT write .sv / gen/. Does NOT require render.
Full checklist: docs/connect/check.md (what check vs elaborate vs dump own).

Must check (author-face + RtlIndex/deps context)
  dialect constraints on aw-content (docs/connect/html.md / docs/connect/rules.md)
  type=/to legality (docs/connect/to-rules.md) without needing expand results
  [connect.<id>] toml deps: missing ref = error; unused = warn; cycle = error
  aw-mod@deps + path-accumulated visible set (siblings do not inherit each other's deps)

Not check's job (elaborate / dump still gate)
  identity same-name wiring, short-circuit, const/open direction, dim merge
  aw-render dumpability (no leftover template/rewrite) — dump gate after render

Web header [Check] / GET ?check=1 / POST /api/check / cli --check share the same checker.
Render depends on Check (auto-check before elaborate). Dump depends on Render.
Check green is not dump-ready: elaborate errors still block write-back.
See docs/connect/check.md, docs/workspace/web-ui.md §3.1, docs/architecture.md.
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
Server re-runs check on the unit's author HTML before writing (422 on error);
module names must be plain SV identifiers (they become file names).
All /api/* refuse a foreign Host or cross-origin Origin; POST bodies must be
application/json (so other pages in the browser cannot drive a write).
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
  copy a per-chip connect prompt (edit help agent / src/cli/help.ts instead)
  make README a second contract without updating help
  put wiring into autowire.toml ([connect.<id>] allows only html= + deps= — no top, no wiring)
  patch aw-render after it is filled (lifecycle: only before-instances + on-template may write; before-dump is read-only)
  rely on document-order "forward" sibling refs inside aw-submods (use aw-mod@deps; visible set accumulates down the path)
  treat dump as the only validation (use autowire check on aw-content + deps; dump reads aw-render)
  require render before check (wrong direction: Render depends on Check; Check does not depend on Render)
  skip check before render or dump (?render=1 / [Render] must auto-run Check first)
  generate regfile/cfgbus from connect aw-submods custom tags (use: autowire plugin generate; docs/plugins/)
  treat Excel / C headers / uvm_reg as register SoT, or reverse-generate TS from them
  treat Workspace MCP html_write as elaborate (must still run web check/render/dump for netlist)
  list same-name ports one-by-one in aw-connect (identity omits them; rename → one aw-rewrite RegExp)
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
		"  plugin generate [id]      type-A generate → plugins_dir   → help status",
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
