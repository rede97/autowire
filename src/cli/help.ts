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
	"docs",
] as const;

export type HelpTopic = (typeof HELP_TOPICS)[number];

const SECTIONS: Record<HelpTopic, string> = {
	agent: `\
Autowire — Agent contract

This topic is the working contract; do not invent a separate project prompt.
Other topics are command/dialect reference: autowire help topics

What it is
  Connectivity is one HTML + <script>. After the browser runs the script, the live DOM is the netlist.
  connect run writes .sv from that netlist. The page shows the same text and does not write.
  Early path: aw.js + connect web; debug via Playwright MCP (browser, isolated).
  Settled path: autowire connect run — happy-dom runs the same HTML + module scripts,
  then the same check → elaborate → before-dump pipeline. Playwright stays for debug.
  MCP vs tools: tools own check and connect run; MCPs must not be a live netlist engine.
  Playwright MCP drives the page. Saving is the browser download or the driver storing
  #aw-generated locally. Direct HTML-node edit is parked (docs/mcp/workspace.md).
  RtlIndex lookup is analysis search / info / deps.

Pipeline
  autowire.toml (.f + svh / macros)
      →  analysis run → hdxml → RtlIndex (read-only)
      →  HTML aw-content (+ aw-submods)
      →  connect check (author HTML legality + deps; no write; not aw-render)
      →  elaboration → aw-render
      →  connect run writes .sv → DV

You can do now
  1. Follow help dont; use help status for landed vs not landed.
  2. autowire init / analysis run for workspace + RtlIndex.
  3. Author connect HTML per docs/connect/html.md.
  4. autowire connect web [unit]; wait for first paint.
  5. Playwright MCP: navigate / snapshot / evaluate / click — inspect live DOM, not source HTML.
     Do not add a node-edit MCP. Search the index with analysis search / info / deps.
  6. connect check reports author-face errors and warnings. It does not write.
  7. connect run writes .sv from aw-render. The browser session does not write.
     Same module scripts and aw-render as the page. Unchanged files are skipped.

Rules of engagement
  Edit this help (src/cli/help.ts) when behavior changes; format constraints live in docs/.
  Bun only (bun / bun test / bunx). Do not invent finished commands — help status is truth.
  Windows: MSYS2 UCRT64 toolchain, ucrt64/bin on PATH, LF checkout (docs/dev/windows-msys2.md).
  Production package is parked (docs/dev/release.md): do not add an installer
    or switch dev/CI debug to Lightpanda. Dev/CI stays Playwright + Chromium.
  Connect authoring (docs/connect/html.md §3.5.5): same-name → identity (omit);
    rename batch → one aw-rewrite RegExp — never list identity ports one-by-one.
`,

	status: `\
Status (code is truth; do not invent finished commands)

Landed
  autowire help [topic]
  autowire init / analysis run   workspace autowire.toml → hdxml
  autowire analysis deps|search|info   read the RtlIndex; no write
  hdxml sidecar             analysis → RtlIndex XML
  aw.js                     engine: src/core/aw.ts → build:web → web/aw.js (generated; guarded)
  autowire connect web [unit]  static session; buttons; no workspace write
  autowire connect check [unit] author-face legality + deps (no write)
  autowire connect run [unit]   happy-dom: scripts → elaborate → write .sv (no browser)
  Playwright env            headless Chromium; MCP via .mcp.json (127.0.0.1 only)
  Page session              window.aw.session: before-instances, check, elaborate,
                            before-dump, run, save, help. Source stays in #aw-generated.
                            Save is a browser download. The page does not write files.
  aw-tb-mod / [sim.<id>]    TB top + type=raw + body includes; connect run → sim_dir
  plugin wishbone run       Type A: regfile + bus → plugins_dir/wishbone/ (docs/cli.md)

Not landed (parked; do not implement until a later ask)
  Production package        three sibling binaries: autowire, hdxml, lightpanda
                            (docs/dev/release.md). Parked. Dev/CI stays Playwright.
  Workspace HTML edit       no node-edit MCP. This stage: the agent drives the
                            browser, then saves locally. Direct HTML-node edit is
                            not required (docs/mcp/workspace.md).
  Plugin type B             expand custom tags into core aw-*. Parked. No aw-*
                            plugin tags in use. Type A wishbone run is landed.
  Wishbone open items       extra arbiter policies, crossbar, SlaveBus downlink,
                            posted async FIFO, CDC constraints, real DFT TAP.
                            Parked (docs/plugins/wishbone-bus.md §8). Tag domains
                            (ShadowDomain / TagFrom*) are landed.
  Multiple autowire.toml    one file per workspace. Nested copies and dep closure
                            are not needed (docs/workspace/toml.md §6).

Parallel (does not block connect)
  Plugin registry (docs/plugins/): type A = generate → plugins_dir → analysis/RtlIndex leaf
    (hash incremental; no plugin-private port API);
    type B = expand custom aw-* tags like submods; parked, no such tags in use;
  Wishbone — landed (docs/plugins/wishbone-regfile.md + wishbone-bus.md);
    one plugin id wishbone (wishbone-regfile / wishbone-bus are not command aliases);
    two DSL types stay: RegfileDef vs BusDef (no merged IR);
    draft API + samples: docs/examples/regfile/regfile.ts;
    toml [wishbone.<source>] ts= (one file may export either or both; optional exports=);
    [plugins.wishbone] packed software (SoT exports only; no reverse to TS):
    export= Excel (field sheets + MAP_<bus> address map;
    field .note() continues that Description cell after a newline;
    regfile .note() is the header Description comment;
    trunk columns; leaf offset; no empty A / ADDRWIDTH), c= C dir (layout .h + <bus>_map.h + wishbone.h umbrella),
    uvm= uvm_reg dir (ral_<SHEET>.sv + ral_block_* + ral_wishbone.sv) and RALF <bus>.ralf
    (one block per bus; TagFromAddr splits that level into one instance per copy;
    a pass-through child is not split again; broadcast windows are addresses);
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
    demo: top soc_wb = interconnect (cpu + JTAG dbg master behind demo_tap USER);
    two SlaveBus(sd_sha) channels (ch0/ch1);
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
    RWE o_<domain>_sel (lowest set bit, address tag only) + i_<domain>_mux_sel
    (inner_shadow_mux sideband index; not o_<domain>_sel) + optional ext_<field>_ready;
    tag domains (docs/plugins/wishbone-bus.md §2.1, landed):
      hoist ShadowDomain(name, copies, width) to its own shared export;
      Bus tags= declares TGA order + source — bare name = pass through from
      uplink, TagFromAddr/TagFromPin/TagFromReg = produced at this level;
      one source per domain per path;
      Bus addrWidth is required (the allocated address space, no default 32);
      a child addrWidth may not exceed its parent, nor the bits the parent
      window actually forwards;
      one TagFromAddr per decoder, sitting directly above the slave windows
      and not past addrWidth-1 (bits above the tag and inside addrWidth are
      discarded; decode keeps only the low bits; no hole, no re-pack);
      a second tag belongs on the next decoder; extra tags are ordered high
      bit first and are not stable; TagFromAddr bits are stripped from slave
      decode (one window covers all aliases) and must not overlap any window;
      SlaveBus tag derives from the child bus, never hand-written;
    Access RC = ReadConst (reset= baked readback);
    wide-field split: comments/desc name[hi:lo] of [W-1:0] (index 0 = LSB);
    named slaves {slave}_i_wb_*/o_wb_* (identity-match regfile); NM<=1 → decoder;
    NM>1 → interconnect (arbiter: rb_grant_en 0=fixed lowest-index /
    1=round-robin after last grant); masters named {m}_o_wb_*/{m}_i_wb_{dat,ack};
    demo/soc: smoke FABRIC.rb_grant_en (reset 0) drives each channel rb_grant_en;
    basic_smoke checks cascade SHA MMIO + grant CSR; --sd is channel DMA+SHA;
    demo/soc sot/wb_bus_soc.ts → soc_wb_interconnect + soc_wb_system (+ JTAG TDR / wb_cdc);
    demo sim: Verilator only (sim/verilator/run.sh; --tb-mod runs the aw-tb-mod
    dump tb_soc); external JTAG smoke runs concurrently with the firmware;
    sot/wb_bus_sd_sha.ts → sd_sha_interconnect + sd_sha_system (mixed slave PIPE);
    ADR=byte; fabric addr_width parametrized;
    TGA: Bus tagWidth? / Slave tag? → {m}_o_wb_tga in, {slave}_i_wb_tga out;
    slave PIPE: Slave(..., { pipe: N }) instantiates wb_cfg_pipe (posted write /
    blocking read; PIPE=0 combo; TGA ports always on the module, omitted at
    instance when Slave has no tag);
    master PIPE: Master(..., { pipe: N }) default 0; N>0 inserts wb_cfg_pipe
    in front of the arbiter (decoder: in front of decode); the arbiter holds
    the grant from the pipe s_cyc so a posted write keeps the bus until it drains;
    decode: localparam SLOT_<SLAVE> indexes slot_sel (no bare slot_sel[6]);
    SlaveRegion(name, desc, base, Size(bytes), { pipe?, tag?, broadcast?,
    broadcastBy? }): string window by span; broadcast emits broadcast_<name> and
    has no WB data port; broadcast and broadcastBy are mutually exclusive;
    broadcastBy ORs that strobe into a region on WE only;
    subscribers of one broadcast must share pipe depth;
    raw Slave cannot broadcast; ACK waits for every selected subscriber;
    Slave(name, desc, base, mask, ...) is a raw port (no overlap check);
    SlaveRegfile is SlaveRegion sugar: Size(layout span) + leaf; optional size=;
    SlaveBus is SlaveRegion sugar: Size(child span) + child BusDef; optional size=;
    child must declare Master("uplink") (cascade face);
    Bus rejects overlapping Region/Regfile/SlaveBus windows; raw Slave is excluded;
    tag defaults to leaf tga_width; TGA must match; id defaults to RegfileDef.name;
    Type-A wrapper <bus>_system instantiates interconnect + attached *_regfile
    (sidebands promoted; WB internalized; HTML aw-inst soc_wb_system / sd_sha_system);
    uplink master ports become i_wb_* / o_wb_* on the child wrapper;
    master faces (docs/plugins/wishbone-master.md): Master(name, desc, { apb | jtag | cdc,
    timeout? }); bridge in the source clock → wb_cdc (4-phase req/ack, non-posted) → fabric;
    fabric RTL unchanged, all bridge logic inside <bus>_system ({m}_fab_* nets);
    wb_cdc ERR on fabric reset / timeout / drain (never hangs); APB PPROT mismatch → PSLVERR;
    JTAG = TDR client of the DFT-owned chip TAP / SIB (no private TAP): shift {op,adr,dat},
    capture {st,adr,rdat}; launch + poll (st 1 busy / 2 err sticky, nop clears); {m}_en gate;
    emits wb_sync_cell / wb_cdc / wb_apb2wb / wb_jtag_tdr.sv + <bus>_system.icl/.pdl;
    cascade face (uplink) cannot be bridged; duplicate master names rejected
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
  [plugins.wishbone]    packed software: export= Excel (field sheets + one sheet per bus tree);
                        c= C dir (layout + <bus>_map.h + wishbone.h; TagFromAddr aliases
                        and broadcast windows); uvm= uvm_reg dir plus <bus>.ralf
  [dump]                product dirs (docs §4.0; legacy dir= still accepted with warn):
                        connect_dir="gen/connect"  DE wrappers
                        sim_dir="gen/sim"          DV TB tops
                        plugins_dir="gen/plugins"  type-A plugins; subdirs per plugin id
                        dir="gen"                  deprecated single sink (compat warn)
                        demo/soc dump → rtl/gen/{connect,sim,plugins}
  [style] param_inline      true (default) inline simple overrides | false: fold all to Mod__Inst__Param
  [style] port_align        declaration port columns: dir / type / packed, names left-aligned (default false)
  [style] param_align       declaration parameter = column (default false)
  [style] inst_port_align   instantiation .port ( and ) columns, file-wide (default false)
  [style] inst_param_align  instantiation .PARAM ( and ) columns, file-wide (default false);
                            with inst_port_align too, ports + params share one column pair
  [style] inst_port_dir     append // input|output|inout to instance port-map rows (default false)
  [style] inst_port_dir_format  "full" (input/output/inout, default) | "short" (i/o/io)
  [style] inst_port_width   append the port width after the direction: // input [31:0];
                            multi-dim packed as-is ([3:0][7:0]); unpacked after ';'
                            ([7:0];[0:15], ;[0:3]); 1-bit ports show none (default false)
  [style] signal_align      internal signal columns: nettype / packed, names left-aligned (default false)
  [style] localparam_upper  uppercase generated Mod__Inst__Param names (default false)

Dirs
  .autowire/          generated temp (deletable; never hand-authored)
  .autowire/hdxml/    RtlIndex XML — web loads ONLY via GET /api/rtlindex|/api/module
  .autowire/connect/  per-unit snapshot: <id>.xml only (abstract module info,
                      hdxml-style, no timestamps/hashes) — connect run + cross-unit deps
                      via GET /api/connect?id=; never author SoT; no html snapshot

Load rules (docs/workspace/toml.md §4.2 / docs/workspace/web-ui.md §5)
  leaf ports: hdxml only (missing/stale definesFp → error when needed)
  cross-unit: require dep unit snapshot under connect/ (or elaborate deps first)
  browser never reads workspace files directly; connect run never reloads author html=

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
autowire init / analysis (docs/cli.md)

  autowire init
  autowire analysis run [--workspace dir|file] [--hdxml bin] [--sub-bars] [--force]
  autowire analysis deps [module] [--depth n]
  autowire analysis search [--module|--port|--package|--enum] [--regex] <pattern>
  autowire analysis info <module>

init: create default autowire.toml in CWD (refuses to overwrite).
analysis run: load toml (upward from CWD, or --workspace) and run hdxml with mapped args
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
--force: analysis is incremental by default — unchanged files are reused from the
  RtlIndex dir. --force maps to hdxml --refresh (full re-parse, rewrites the cache).

analysis deps: print dependency trees from the existing index. Omit module for every
  tree. It does not parse RTL; missing index → error (run analysis run first).
analysis search: one kind at a time. Default kind is module. Pattern is a fuzzy
  substring unless --regex. Each hit prints the name, the index XML, and the RTL file.
  --enum searches localparam names inside packages.
analysis info: exact module name. Prints params and ports plus the XML and RTL paths.
  Unknown name is an error; it does not fall back to fuzzy search.
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
  before-dump read-only; type-A plugin wishbone run stays outside this pipeline (docs/plugins/).
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
autowire connect web

  autowire connect web [unit]

Static page on 127.0.0.1. The session does not write the workspace.
Buttons: Check, Elaborate, Run, Save, Reset. Generated source is visible in #aw-generated.
Save downloads that text in the browser. MCP calls window.aw.session(step):
  before-instances, check, elaborate, before-dump, run, save, help.
None of those steps write a file. connect run writes .sv.

GET (read-only)
  /api/rtlindex, /api/module?name=, /api/author?id=, /api/connect?id=
`,

	check: `\
autowire connect check

  autowire connect check [unit]

Validate author-face connect HTML (aw-content + aw-submods) and dependency graphs.
Does NOT inspect aw-render as SoT. Does NOT write .sv. Does NOT require a browser.
Full checklist: docs/connect/check.md.

Must check (author-face + RtlIndex/deps context)
  dialect constraints on aw-content (docs/connect/html.md / docs/connect/rules.md)
  type=/to legality (docs/connect/to-rules.md) without needing expand results
  toml deps: missing cross-unit ref = error; unknown id / cycle / self-dep = error
  unused dep = warning (does not fail check)

Not check's job
  printing .sv (connect run)
  editing author HTML

connect run depends on this check and refuses to write when it fails.
Check green is not a substitute for reading the written RTL.
`,

	dump: `\
Write-back is connect run, not a web POST.

  autowire connect run [unit]

Reads aw-render after check and elaborate. Writes .sv and, for connect units,
the <id>.xml snapshot. The web session does not call this and does not write.
`,

	cli: `\
autowire connect run (happy-dom, no browser)

  autowire connect run [unit] [--force]

Runs the settled-design pipeline and writes .sv. Unchanged files are skipped.
--force rewrites them. The same flag on analysis run and plugin wishbone run
forces those outputs too.
  HTML module scripts (aw.on) → before-instances → check → elaborate
  → before-dump → write .sv

Module scripts must be type="module" and use only DOM / aw.*.
happy-dom and Chromium must produce the same snapshot for the same HTML.
Playwright remains the debug path. No browser is required to write RTL.
`,

	deps: `\
autowire analysis deps

  autowire analysis deps [module] [--depth n] [--workspace dir|file]

Reads the workspace RtlIndex. Omit module to print every dependency tree.
A module name prints only that tree. Missing index → error; run analysis run first.
Does not parse RTL and does not write files.
`,

	dont: `\
Do not

  connectivity SoT in XML / one-file-per-level files (RtlIndex XML is an index, not connectivity)
  blur tools vs MCP: no MCP that mutates connect and returns live netlist/RTL in-process
    (old outline/apply/rewrite all-in-one). Allowed: Playwright MCP (debug) and Workspace MCP
    (author-file edit + RtlIndex query; docs/mcp/) — generate still via web/cli tools only
  browser writing the workspace directly
  build a second RTL writer in the browser (connect run writes .sv; the page only shows it)
  two wiring semantics (the page and connect run must share aw.js)
  copy a per-chip connect prompt (edit help agent / src/cli/help.ts instead)
  make README a second contract without updating help
  put wiring into autowire.toml ([connect.<id>] allows only html= + deps= — no top, no wiring)
  patch aw-render after it is filled (lifecycle: only before-instances + on-template may write; before-dump is read-only)
  rely on document-order "forward" sibling refs inside aw-submods (use aw-mod@deps; visible set accumulates down the path)
  treat connect run as the only validation (use connect check on aw-content + deps)
  generate regfile/cfgbus from connect aw-submods custom tags (use: plugin wishbone run; docs/plugins/)
  treat Excel / C headers / uvm_reg as register SoT, or reverse-generate TS from them
  treat Workspace MCP html_write as elaborate (must still run web check/render/dump for netlist)
  list same-name ports one-by-one in aw-connect (identity omits them; rename → one aw-rewrite RegExp)
  ship Playwright or Chromium in the production package (docs/dev/release.md: autowire + hdxml + lightpanda)
  link lightpanda into the autowire binary
  ship the repo source as the production entry (use out/autowire.js or out/autowire)
  docs unpack over a tree you did not mean to replace (it writes docs/ and demo/)
`,

	docs: `\
autowire docs unpack

  autowire docs unpack <dir>

The release script contains the full docs/ tree and every demo/, gzip-compressed.
This command writes that tree under <dir> so an agent can read the contract and
the examples. Dev builds read the repo instead of the bundle.

  <dir>/docs/...
  <dir>/demo/soc/...
  <dir>/demo/hbm/...

Existing files at those paths are replaced. The bundle skips .autowire, firmware
build/, and Verilator obj_dir. See docs/dev/release.md section 1.1.
`,
};

/** Default `autowire help` — command index + one-line Agent pointer. */
function commandIndex(): string {
	return [
		"Autowire — commands",
		"",
		"  help [topic]              topic reference (see help topics)",
		"  init                      create default autowire.toml in CWD",
		"  analysis run              hdxml from autowire.toml       → help analysis",
		"  analysis deps [module]    RTL dependency trees           → help deps",
		"  analysis search <pattern> fuzzy or regex index search    → help analysis",
		"  analysis info <module>    params and ports               → help analysis",
		"  connect run [unit]       happy-dom check then write .sv  → help cli",
		"  connect check [unit]     author-face rules, no write    → help check",
		"  connect web [unit]       static session page            → help web",
		"  plugin wishbone run      generate regfiles and buses    → help status",
		"  docs unpack <dir>        write bundled docs/ and demo/  → help docs",
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
		"  cli        happy-dom render",
		"  deps       dependency tree",
		"  dont       forbidden items",
		"  docs       unpack bundled docs and demos",
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
