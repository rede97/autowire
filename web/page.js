// src/web/page.ts
import * as AWruntime from "/aw.js";

// src/core/printer.ts
function isObj(v) {
  return typeof v === "object" && v !== null;
}
function str(v) {
  return typeof v === "string" ? v : "";
}
function arr(v) {
  if (Array.isArray(v))
    return v;
  return v === undefined || v === null ? [] : [v];
}
function parseParams(v) {
  const out = [];
  for (const p of arr(isObj(v) ? v["aw-param"] : undefined)) {
    if (!isObj(p))
      continue;
    out.push({ name: str(p["@name"]), value: str(p["@value"]) });
  }
  return out;
}
function parseMod(v, tag = "aw-mod") {
  if (!isObj(v))
    return null;
  const render = isObj(v["aw-render"]) ? v["aw-render"] : {};
  const ports = [];
  const portsEl = isObj(render["aw-ports"]) ? render["aw-ports"] : undefined;
  for (const p of arr(portsEl?.["aw-port"])) {
    if (!isObj(p))
      continue;
    ports.push({
      name: str(p["@name"]),
      dir: str(p["@dir"]) || "input",
      packed: str(p["@packed"]),
      unpacked: str(p["@unpacked"]),
      nettype: str(p["@nettype"]),
      interface: str(p["@interface"]),
      modport: str(p["@modport"])
    });
  }
  const signals = [];
  const sigEl = isObj(render["aw-signals"]) ? render["aw-signals"] : undefined;
  for (const s of arr(sigEl?.["aw-signal"])) {
    if (!isObj(s))
      continue;
    signals.push({
      name: str(s["@name"]),
      packed: str(s["@packed"]),
      unpacked: str(s["@unpacked"]),
      nettype: str(s["@nettype"])
    });
  }
  const imports = [];
  const impEl = isObj(render["aw-imports"]) ? render["aw-imports"] : undefined;
  for (const i of arr(impEl?.["aw-import"])) {
    if (!isObj(i))
      continue;
    imports.push({
      package: str(i["@package"]),
      symbol: str(i["@symbol"]) || "*"
    });
  }
  const localparams = [];
  const lpEl = isObj(render["aw-localparams"]) ? render["aw-localparams"] : undefined;
  for (const lp of arr(lpEl?.["aw-localparam"])) {
    if (!isObj(lp))
      continue;
    localparams.push({
      name: str(lp["@name"]),
      value: str(lp["@value"]),
      folded: str(lp["@folded"]) === "true",
      forInst: str(lp["@for-inst"]),
      forParam: str(lp["@for-param"])
    });
  }
  const insts = [];
  const instEl = isObj(render["aw-insts"]) ? render["aw-insts"] : undefined;
  for (const inst of arr(instEl?.["aw-inst"])) {
    if (!isObj(inst))
      continue;
    const connects = [];
    for (const c of arr(inst["aw-connect"])) {
      if (!isObj(c))
        continue;
      connects.push({
        port: str(c["@port"]),
        to: str(c["@to"]),
        part: str(c["@part"]),
        type: str(c["@type"]),
        dir: str(c["@dir"]),
        portPacked: str(c["@port-packed"]),
        portUnpacked: str(c["@port-unpacked"])
      });
    }
    insts.push({
      id: str(inst["@id"]),
      mod: str(inst["@mod"]),
      params: parseParams(inst),
      connects
    });
  }
  const children = [];
  for (const sm of arr(v["aw-mod"])) {
    const parsed = parseMod(sm, "aw-mod");
    if (parsed)
      children.push(parsed);
  }
  return {
    name: str(v["@name"]),
    params: parseParams(render["aw-params"]),
    imports,
    localparams,
    ports,
    signals,
    insts,
    children,
    isTb: tag === "aw-tb-mod" || str(render["@tb"]) === "1",
    bodyPreInclude: splitInc(str(v["@body-pre-include"]) || str(render["@body-pre-include"])),
    bodyPostInclude: splitInc(str(v["@body-post-include"]) || str(render["@body-post-include"]))
  };
}
function splitInc(s) {
  return s.split(/\s+/).filter(Boolean);
}
function domToObj(el) {
  const out = {};
  for (const attr of el.attributes)
    out[`@${attr.name}`] = attr.value;
  for (const child of el.children) {
    const v = domToObj(child);
    const prev = out[child.localName];
    if (prev === undefined)
      out[child.localName] = v;
    else if (Array.isArray(prev))
      prev.push(v);
    else
      out[child.localName] = [prev, v];
  }
  return out;
}
function parseSnapshot(text) {
  let doc;
  if (typeof Bun !== "undefined") {
    doc = Bun.XML.parse(text);
  } else {
    const rootEl = new DOMParser().parseFromString(text, "text/xml").querySelector("autowire");
    doc = rootEl ? { autowire: domToObj(rootEl) } : {};
  }
  const root = isObj(doc) ? doc.autowire : undefined;
  if (!isObj(root))
    throw new Error("snapshot: missing <autowire> root");
  const mods = [];
  for (const m of arr(root["aw-mod"])) {
    const parsed = parseMod(m, "aw-mod");
    if (parsed)
      mods.push(parsed);
  }
  for (const m of arr(root["aw-tb-mod"])) {
    const parsed = parseMod(m, "aw-tb-mod");
    if (parsed)
      mods.push(parsed);
  }
  return mods;
}
function flattenModules(mods) {
  const out = [];
  for (const m of mods) {
    out.push(m);
    out.push(...flattenModules(m.children));
  }
  return out;
}
function packedSv(packed) {
  if (!packed)
    return "";
  return packed.startsWith("[") ? packed : `[${packed}]`;
}
function signalDecl(nettype, packed, unpacked, name) {
  const t = nettype === "logic" ? "logic" : "wire";
  const pd = packedSv(packed);
  const ud = unpacked ? ` ${unpacked.startsWith("[") ? unpacked : `[${unpacked}]`}` : "";
  return `${t}${pd ? ` ${pd}` : ""} ${name}${ud};`;
}
function printSv(m, unitId, style = {}) {
  const lines = [];
  const sot = m.isTb ? "sim HTML" : "connect HTML";
  lines.push(`// Generated by autowire dump (unit "${unitId}"). Do not edit: SoT is the ${sot}.`);
  if (m.isTb) {
    if (m.params.length > 0) {
      const paramNamePad = style.paramAlign ? Math.max(...m.params.map((p) => p.name.length), 0) : 0;
      lines.push(`module ${m.name} #(`);
      for (const [i, p] of m.params.entries()) {
        const nm = paramNamePad ? p.name.padEnd(paramNamePad) : p.name;
        lines.push(`	parameter ${nm} = ${p.value}${i < m.params.length - 1 ? "," : ""}`);
      }
      lines.push(");");
    } else {
      lines.push(`module ${m.name};`);
    }
    for (const inc of m.bodyPreInclude ?? [])
      lines.push(`\`include "${inc}"`);
    for (const imp of m.imports)
      lines.push(`	import ${imp.package}::${imp.symbol};`);
    if (m.imports.length > 0)
      lines.push("");
    for (const lp of m.localparams)
      lines.push(`	localparam ${lp.name} = ${lp.value};`);
    if (m.localparams.length > 0)
      lines.push("");
    const sigDecls = m.signals;
    const sigTypePad = style.signalAlign && sigDecls.length > 0 ? 5 : 0;
    const sigPackPad = style.signalAlign ? Math.max(...sigDecls.map((s) => packedSv(s.packed).length), 0) : 0;
    for (const s of sigDecls) {
      const nt = s.nettype === "wire" ? "wire" : "logic";
      if (!style.signalAlign) {
        lines.push(`	${signalDecl(nt, s.packed, s.unpacked, s.name)}`);
        continue;
      }
      const pd = packedSv(s.packed);
      const ud = s.unpacked ? ` ${s.unpacked.startsWith("[") ? s.unpacked : `[${s.unpacked}]`}` : "";
      const packCol = sigPackPad > 0 ? ` ${pd.padEnd(sigPackPad)}` : "";
      lines.push(`	${nt.padEnd(sigTypePad)}${packCol} ${s.name}${ud};`);
    }
    if (sigDecls.length > 0)
      lines.push("");
    lines.push(...printInsts(m, style));
    for (const inc of m.bodyPostInclude ?? [])
      lines.push(`\`include "${inc}"`);
    lines.push("endmodule");
    lines.push("");
    return lines.join(`
`);
  }
  const paramNamePad = style.paramAlign ? Math.max(...m.params.map((p) => p.name.length), 0) : 0;
  const params = m.params.map((p) => `parameter ${paramNamePad ? p.name.padEnd(paramNamePad) : p.name} = ${p.value}`);
  const plainPorts = m.ports.filter((p) => p.dir !== "interface");
  const dirPad = style.portAlign ? Math.max(...plainPorts.map((p) => p.dir.length), 0) : 0;
  const typePad = style.portAlign && plainPorts.length > 0 ? 5 : 0;
  const packPad = style.portAlign ? Math.max(...plainPorts.map((p) => packedSv(p.packed).length), 0) : 0;
  const portText = m.ports.map((p) => {
    if (p.dir === "interface") {
      const mp = p.modport ? `.${p.modport}` : "";
      return `${p.interface}${mp} ${p.name}`;
    }
    const t = p.nettype === "logic" ? "logic" : "wire";
    const pd = packedSv(p.packed);
    const ud = p.unpacked ? ` ${p.unpacked.startsWith("[") ? p.unpacked : `[${p.unpacked}]`}` : "";
    if (!style.portAlign)
      return `${p.dir} ${t}${pd ? ` ${pd}` : ""} ${p.name}${ud}`;
    const packCol = packPad > 0 ? ` ${pd.padEnd(packPad)}` : "";
    return `${p.dir.padEnd(dirPad)} ${t.padEnd(typePad)}${packCol} ${p.name}${ud}`;
  });
  const header = params.length > 0 ? `module ${m.name} #(` : `module ${m.name} (`;
  lines.push(header);
  const paramLines = params.map((p, i) => `	${p}${i < params.length - 1 ? "," : ""}`);
  lines.push(...paramLines);
  if (params.length > 0)
    lines.push(") (");
  for (const [i, p] of portText.entries()) {
    lines.push(`	${p}${i < portText.length - 1 ? "," : ""}`);
  }
  lines.push(");");
  for (const imp of m.imports)
    lines.push(`	import ${imp.package}::${imp.symbol};`);
  if (m.imports.length > 0)
    lines.push("");
  for (const lp of m.localparams)
    lines.push(`	localparam ${lp.name} = ${lp.value};`);
  if (m.localparams.length > 0)
    lines.push("");
  const portNames = new Set(m.ports.map((p) => p.name));
  const sigDecls = m.signals.filter((s) => !portNames.has(s.name));
  const sigTypePad = style.signalAlign && sigDecls.length > 0 ? 5 : 0;
  const sigPackPad = style.signalAlign ? Math.max(...sigDecls.map((s) => packedSv(s.packed).length), 0) : 0;
  let printedSignals = 0;
  for (const s of sigDecls) {
    printedSignals++;
    if (!style.signalAlign) {
      lines.push(`	${signalDecl(s.nettype, s.packed, s.unpacked, s.name)}`);
      continue;
    }
    const t = s.nettype === "logic" ? "logic" : "wire";
    const pd = packedSv(s.packed);
    const ud = s.unpacked ? ` ${s.unpacked.startsWith("[") ? s.unpacked : `[${s.unpacked}]`}` : "";
    const packCol = sigPackPad > 0 ? ` ${pd.padEnd(sigPackPad)}` : "";
    lines.push(`	${t.padEnd(sigTypePad)}${packCol} ${s.name}${ud};`);
  }
  if (printedSignals > 0)
    lines.push("");
  lines.push(...printInsts(m, style));
  lines.push("endmodule");
  lines.push("");
  return lines.join(`
`);
}
function printInsts(m, style) {
  const constNames = new Set([
    ...m.params.map((p) => p.name),
    ...m.localparams.map((l) => l.name)
  ]);
  const rows = m.insts.map((inst) => inst.connects.map((c) => ({
    port: c.port,
    rhs: connectRhs(c, constNames),
    dir: style.instPortDir ? dirMark(c.dir, style.instPortDirFormat) : "",
    width: style.instPortWidth ? widthMark(c.portPacked, c.portUnpacked) : ""
  })));
  const dirPad = Math.max(0, ...rows.flat().map((r) => r.width ? r.dir.length : 0));
  const aligned = [
    ...style.instPortAlign ? rows.flat().map((r) => ({ name: r.port, value: r.rhs })) : [],
    ...style.instParamAlign ? m.insts.flatMap((inst) => inst.params.map((p) => ({ name: p.name, value: p.value }))) : []
  ];
  const namePad = Math.max(0, ...aligned.map((c) => c.name.length));
  const valuePad = Math.max(0, ...aligned.map((c) => c.value.length));
  const portPad = style.instPortAlign ? namePad : 0;
  const rhsPad = style.instPortAlign ? valuePad : 0;
  const paramPad = style.instParamAlign ? namePad : 0;
  const paramValuePad = style.instParamAlign ? valuePad : 0;
  const lines = [];
  for (const [k, inst] of m.insts.entries()) {
    if (inst.params.length > 0) {
      lines.push(`	${inst.mod} #(`);
      for (const [i, p] of inst.params.entries()) {
        lines.push(`		.${p.name.padEnd(paramPad)}(${p.value.padEnd(paramValuePad)})${i < inst.params.length - 1 ? "," : ""}`);
      }
      lines.push(`	) ${inst.id} (`);
    } else {
      lines.push(`	${inst.mod} ${inst.id} (`);
    }
    const conns = rows[k] ?? [];
    for (const [i, r] of conns.entries()) {
      const last = i === conns.length - 1;
      const row = `		.${r.port.padEnd(portPad)}(${r.rhs.padEnd(rhsPad)})${last ? "" : ","}`;
      const mark = r.width ? `${r.dir ? `${r.dir.padEnd(dirPad)} ` : ""}${r.width}` : r.dir;
      lines.push(mark ? `${row}${last ? " " : ""} // ${mark}` : row);
    }
    lines.push("\t);");
  }
  if (m.insts.length > 0)
    lines.push("");
  return lines;
}
var DIR_MARKS = {
  full: { input: "input", output: "output", inout: "inout" },
  short: { input: "i", output: "o", inout: "io" }
};
function widthMark(packed, unpacked) {
  const p = packed ? packedSv(packed) : "";
  const bits = /^\[\s*(\d+)\s*:\s*\1\s*\]$/.test(p) ? "" : p;
  return unpacked ? `${bits};${packedSv(unpacked)}` : bits;
}
function dirMark(dir, format = "full") {
  return DIR_MARKS[format][dir] ?? "";
}
function connectRhs(c, constNames) {
  if (c.type === "open")
    return "";
  if (c.type === "raw")
    return c.to;
  const netForm = /^[A-Za-z_][A-Za-z0-9_]*$/.test(c.to) && !constNames.has(c.to);
  return netForm ? `${c.to}${c.part ? `[${c.part.replace(/^\[|\]$/g, "")}]` : ""}` : c.to;
}

// src/web/page.ts
var AW = AWruntime;
var win = window;
AW.installGlobal(window);
var $ = (sel) => {
  const el = document.querySelector(sel);
  if (!el)
    throw new Error(`page shell missing ${sel}`);
  return el;
};
var statusEl = $("#aw-status");
var state = {
  workspace: "",
  style: { paramInline: true },
  units: [],
  unitMods: new Map,
  current: null,
  docs: new Map,
  leafCache: new Map,
  phase: new Map
};
function showGenerated(text) {
  const box = $("#aw-generated");
  if (box)
    box.textContent = text;
}
function downloadText(text, filename) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
function saveSv() {
  const text = $("#aw-generated")?.textContent ?? "";
  if (!text) {
    setStatus("error", "save: run first; nothing generated");
    throw new Error("save: run first; nothing generated");
  }
  downloadText(text, `${state.current ?? "autowire"}.sv`);
  setStatus("done", "save: browser download (.sv)");
  return text;
}
function saveHtml() {
  const id = state.current;
  if (!id)
    throw new Error("no unit selected");
  const entry = state.docs.get(id);
  if (!entry)
    throw new Error(`save-html: unit "${id}" not loaded`);
  const clone = entry.container.cloneNode(true);
  for (const r of clone.querySelectorAll("aw-render"))
    r.textContent = "";
  const face = clone.querySelector(":scope > autowire");
  const text = `<!-- live author face of unit "${id}"; aw-render stripped; <script> lives in the author file -->
${face?.outerHTML ?? clone.innerHTML}
`;
  downloadText(text, `${id}.html`);
  setStatus("done", "save-html: browser download (author face, no aw-render)");
  return text;
}
var SESSION_HELP = [
  "before-instances: run author scripts on the current unit",
  "check: rule report; requires before-instances in this session",
  "elaborate: freeze aw-render; requires a clean check in this session",
  "before-dump: read-only hook; requires elaborate in this session",
  "run: the whole chain; same result as connect run, no file write; shows .sv",
  "save / save-sv: download the printed .sv text (browser download)",
  "save-html: download the live author HTML with aw-render stripped",
  "none of these steps write a file"
].join(`
`);
async function sessionStep(step) {
  const id = state.current;
  if (!id)
    throw new Error("no unit selected");
  const phase = state.phase.get(id) ?? "none";
  if (step === "help")
    return SESSION_HELP;
  if (step === "before-instances") {
    await loadUnit(id);
    state.phase.set(id, "before-instances");
    showGenerated($("#aw-live").textContent ?? "");
    return "before-instances";
  }
  if (step === "check") {
    if (phase === "none")
      throw new Error('session: run "before-instances" before "check"');
    const res = await runCheck(id);
    if (res.errors.length === 0)
      state.phase.set(id, "check");
    const text = [...res.errors, ...res.warnings].join(`
`) || "check ok";
    showGenerated(text);
    return text;
  }
  if (step === "elaborate") {
    if (phase !== "check" && phase !== "elaborate" && phase !== "before-dump")
      throw new Error('session: "elaborate" requires a clean check');
    const res = await runRender(id);
    if (res.errors.length > 0)
      throw new Error(res.errors[0]);
    state.phase.set(id, "elaborate");
    showGenerated($("#aw-live").textContent ?? "");
    return "elaborate";
  }
  if (step === "before-dump") {
    if (phase !== "elaborate" && phase !== "before-dump")
      throw new Error('session: "before-dump" requires elaborate');
    const res = await runBeforeDumpOnly(id);
    state.phase.set(id, "before-dump");
    return res.files.join(`
`);
  }
  if (step === "run") {
    const res = await runView(id);
    state.phase.set(id, "before-dump");
    return res.sv;
  }
  if (step === "save" || step === "save-sv") {
    return saveSv();
  }
  if (step === "save-html") {
    return saveHtml();
  }
  throw new Error(`unknown session step "${step}"`);
}
var pageAw = window;
if (pageAw.aw)
  pageAw.aw.session = sessionStep;
function setStatus(state_, text) {
  statusEl.dataset.state = state_;
  statusEl.textContent = text;
  const base = document.title.replace(/ \[(done|error)\]$/, "");
  if (state_ === "done" || state_ === "error")
    document.title = `${base} [${state_}]`;
  else
    document.title = base;
}
var unitOf = (id) => state.units.find((u) => u.id === id);
async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok)
    throw new Error(data.error ?? `${res.status} ${url}`);
  return data;
}
async function loadUnit(id) {
  const cached = state.docs.get(id);
  if (cached)
    return cached;
  const res = await fetch(`/api/author?id=${encodeURIComponent(id)}`);
  if (!res.ok)
    throw new Error((await res.json()).error);
  const html = await res.text();
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const root = parsed.querySelector("autowire");
  if (!root)
    throw new Error(`unit "${id}": author HTML has no <autowire> root`);
  const container = document.createElement("div");
  container.dataset.unit = id;
  const adopted = document.importNode(root, true);
  container.appendChild(adopted);
  $("#aw-live").appendChild(container);
  AW.beginUnitHooks(id);
  try {
    const pending = [];
    for (const s of parsed.querySelectorAll('script[type="module"]')) {
      const el = document.createElement("script");
      el.type = "module";
      const done = new Promise((res) => {
        const q = win.__awScriptDone ?? [];
        win.__awScriptDone = q;
        q.push(res);
      });
      pending.push(done);
      el.textContent = `${s.textContent}
;window.__awScriptDone?.shift()?.();`;
      document.body.appendChild(el);
    }
    await Promise.all(pending);
  } finally {
    AW.endUnitHooks();
  }
  const entry = { doc: container, container, rendered: false };
  state.docs.set(id, entry);
  return entry;
}
async function depWrappers(depId) {
  const session = state.docs.get(depId);
  if (session?.rendered)
    return { facts: renderFactsOf(session.container) };
  const res = await fetch(`/api/connect?id=${encodeURIComponent(depId)}`);
  if (res.status === 404)
    return { missing: depId, facts: [] };
  if (!res.ok)
    throw new Error((await res.json()).error);
  const xml = await res.text();
  const parsed = new DOMParser().parseFromString(xml, "text/xml");
  return { facts: xmlFactsOf(parsed) };
}
function xmlFactsOf(doc) {
  const facts = [];
  for (const mod of doc.querySelectorAll("connectUnit > module")) {
    const ports = [];
    for (const dir of ["input", "output", "inout", "interface"]) {
      for (const p of mod.querySelectorAll(`:scope > ports > ${dir}`)) {
        ports.push({
          name: p.getAttribute("name"),
          dir,
          packed: p.getAttribute("packed"),
          unpacked: p.getAttribute("unpacked")
        });
      }
    }
    const params = [];
    for (const pr of mod.querySelectorAll(":scope > params > param")) {
      params.push({
        name: pr.getAttribute("name"),
        value: pr.getAttribute("value")
      });
    }
    const imports = [];
    for (const im of mod.querySelectorAll(":scope > imports > import")) {
      imports.push({
        package: im.getAttribute("package"),
        symbol: im.getAttribute("symbol") ?? "*"
      });
    }
    facts.push({ name: mod.getAttribute("name"), params, ports, imports });
  }
  return facts;
}
function renderFactsOf(rootEl) {
  const facts = [];
  for (const mod of rootEl.querySelectorAll("autowire > aw-mod")) {
    const ports = [];
    for (const p of mod.querySelectorAll(":scope > aw-render > aw-ports > aw-port")) {
      ports.push({
        name: p.getAttribute("name"),
        dir: p.getAttribute("dir") ?? "input",
        packed: p.getAttribute("packed"),
        unpacked: p.getAttribute("unpacked")
      });
    }
    const params = [];
    for (const pr of mod.querySelectorAll(":scope > aw-render > aw-params > aw-param")) {
      params.push({
        name: pr.getAttribute("name"),
        value: pr.getAttribute("value")
      });
    }
    const imports = [];
    for (const im of mod.querySelectorAll(":scope > aw-render > aw-imports > aw-import")) {
      imports.push({
        package: im.getAttribute("package"),
        symbol: im.getAttribute("symbol") ?? "*"
      });
    }
    facts.push({ name: mod.getAttribute("name"), params, ports, imports });
  }
  return facts;
}
async function buildCtx(id) {
  const unit = unitOf(id);
  if (!unit)
    throw new Error(`unknown unit "${id}"`);
  const { doc } = await loadUnit(id);
  const wrappers = new Map;
  const missing = [];
  for (const dep of unit.deps) {
    const r = await depWrappers(dep);
    if (r.missing)
      missing.push(r.missing);
    for (const f of r.facts ?? [])
      wrappers.set(f.name ?? "", f);
  }
  const wanted = new Set;
  for (const inst of doc.querySelectorAll("aw-inst")) {
    const mod = inst.getAttribute("mod") ?? "";
    if (mod && !wrappers.has(mod) && state.unitMods.get(mod) !== id)
      wanted.add(mod);
  }
  for (const mod of wanted) {
    if (!state.leafCache.has(mod)) {
      const res = await fetch(`/api/module?name=${encodeURIComponent(mod)}`);
      state.leafCache.set(mod, res.ok ? await res.json() : null);
    }
  }
  const errors = missing.map((d) => `unit "${id}" deps: snapshot for "${d}" missing (connect run "${d}" first, or Run the parent so this session elaborates it)`);
  return {
    errors,
    ctx: {
      style: state.style,
      unitId: id,
      unitKind: unit.kind ?? "connect",
      unitDeps: unit.deps,
      unitMods: state.unitMods,
      leaf: (m) => state.leafCache.get(m) ?? null,
      wrapper: (m) => wrappers.get(m) ?? null
    }
  };
}
function ensureAuthorMutations(entry, id) {
  if (entry.hooksRan)
    return;
  entry.hooksRan = true;
  AW.runBeforeInstances(entry.doc, id);
}
async function runCheck(id) {
  const entry = await loadUnit(id);
  ensureAuthorMutations(entry, id);
  const { errors: ctxErrors, ctx } = await buildCtx(id);
  const res = AW.check(entry.doc, ctx);
  return { errors: [...ctxErrors, ...res.errors], warnings: res.warnings };
}
async function runRender(id) {
  const entry = await loadUnit(id);
  ensureAuthorMutations(entry, id);
  const { errors: ctxErrors, ctx } = await buildCtx(id);
  if (ctxErrors.length > 0)
    return { errors: ctxErrors, warnings: [] };
  const res = AW.elaborate(entry.doc, ctx);
  if (res.errors.length === 0)
    entry.rendered = true;
  return res;
}
async function runView(id) {
  if (!unitOf(id))
    throw new Error(`unknown unit "${id}"`);
  const chain = [];
  const visit = (uid) => {
    if (chain.includes(uid))
      return;
    for (const d of unitOf(uid)?.deps ?? [])
      visit(d);
    chain.push(uid);
  };
  visit(id);
  const files = [];
  for (const uid of chain) {
    const checkRes = await runCheck(uid);
    if (checkRes.errors.length > 0) {
      throw new Error(`check failed for "${uid}": ${checkRes.errors[0]}`);
    }
    const renderRes = await runRender(uid);
    if (renderRes.errors.length > 0) {
      throw new Error(`render failed for "${uid}": ${renderRes.errors[0]}`);
    }
    const entry = state.docs.get(uid);
    if (!entry)
      throw new Error(`unit "${uid}" not loaded`);
    AW.runBeforeDump(entry.doc, uid);
    files.push({
      uid,
      text: AW.serializeSnapshot(entry.doc)
    });
  }
  const chunks = [];
  for (const { uid, text } of files) {
    for (const m of flattenModules(parseSnapshot(text))) {
      chunks.push(`// --- ${uid}/${m.name}.sv ---
${printSv(m, uid, state.style)}`);
    }
  }
  const sv = chunks.join(`
`);
  showGenerated(sv);
  return { files: files.map((f) => f.text), sv };
}
async function runBeforeDumpOnly(id) {
  const entry = state.docs.get(id);
  if (!entry?.rendered)
    throw new Error(`session: "${id}" is not elaborated`);
  AW.runBeforeDump(entry.doc, id);
  const text = AW.serializeSnapshot(entry.doc);
  showGenerated(text);
  return { files: [text] };
}
async function runChain({
  select,
  check,
  elaborate,
  run
}) {
  setStatus("running", "running…");
  try {
    if (select)
      await selectModule(select);
    const id = state.current;
    if (!id)
      throw new Error("no unit selected");
    const summary = [];
    if (run) {
      const res = await runView(id);
      summary.push(`check: ok; elaborate: ok; source: ${res.files.length} snapshot(s) in view`);
    } else {
      if (check || elaborate) {
        const res = await runCheck(id);
        summary.push(res.errors.length > 0 ? `check: ${res.errors.length} error(s)` : `check: ok${res.warnings.length > 0 ? ` (${res.warnings.length} warning(s))` : ""}`);
        if (res.errors.length > 0)
          throw new Error(res.errors[0]);
        if (res.warnings.length > 0)
          console.warn("[autowire check warnings]", res.warnings);
      }
      if (elaborate) {
        const res = await runRender(id);
        if (res.errors.length > 0)
          throw new Error(res.errors[0]);
        summary.push("elaborate: ok");
        refreshRightIfRendered();
      }
    }
    setStatus("done", summary.join("; ") || "done");
  } catch (e) {
    setStatus("error", e.message);
  }
}
function hierNode(node) {
  const det = document.createElement("details");
  const sum = document.createElement("summary");
  const span = document.createElement("span");
  span.className = `mod-node${node.blackbox ? " blackbox" : ""}`;
  span.textContent = node.blackbox ? `${node.module} (blackbox)` : node.module;
  span.dataset.mod = node.module;
  sum.appendChild(span);
  if (node.cycle)
    sum.appendChild(document.createTextNode(" (cycle)"));
  det.appendChild(sum);
  for (const c of node.children ?? [])
    det.appendChild(hierNode(c));
  return det;
}
async function buildLeft() {
  const db = $("#db-summary");
  const tree = $("#dep-tree");
  try {
    const idx = await fetchJson("/api/rtlindex");
    db.innerHTML = "";
    const rows = [
      ["tool", idx.tool],
      ["files", idx.files],
      ["modules", idx.modules],
      ["errorFiles", idx.errorFiles.length],
      ["definesFp", `${idx.definesFp.slice(0, 12)}…`]
    ];
    const table = document.createElement("table");
    for (const [k, v] of rows) {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.textContent = k;
      const td = document.createElement("td");
      td.textContent = String(v);
      tr.append(th, td);
      table.appendChild(tr);
    }
    db.appendChild(table);
    tree.innerHTML = "";
    for (const top of idx.hierarchy)
      tree.appendChild(hierNode(top));
  } catch (e) {
    db.textContent = e.message;
  }
}
async function selectModule(name) {
  $("#right-title").textContent = name;
  const body = $("#right-body");
  body.innerHTML = "";
  for (const [, entry] of state.docs) {
    const mod = entry.container.querySelector(`aw-mod[name="${CSS.escape(name)}"]`);
    if (mod) {
      const render = mod.querySelector(":scope > aw-render");
      const pre = document.createElement("pre");
      pre.textContent = render ? serializeForView(render) : "(not rendered yet)";
      body.appendChild(pre);
      return;
    }
  }
  const res = await fetch(`/api/module?name=${encodeURIComponent(name)}`);
  if (!res.ok) {
    body.textContent = (await res.json()).error;
    return;
  }
  const leaf = await res.json();
  body.appendChild(tableOf("params", leaf.params, ["name", "kind", "dataType", "defaultText"]));
  body.appendChild(tableOf("ports", leaf.ports, [
    "name",
    "dir",
    "dataType",
    "packed",
    "unpacked"
  ]));
}
function serializeForView(render) {
  const lines = [];
  const walk = (el, depth) => {
    const attrs = [...el.attributes].map((a) => `${a.name}="${a.value}"`).join(" ");
    lines.push(`${"  ".repeat(depth)}<${el.tagName.toLowerCase()}${attrs ? ` ${attrs}` : ""}>`);
    for (const c of el.children)
      walk(c, depth + 1);
  };
  walk(render, 0);
  return lines.join(`
`);
}
function tableOf(title, rows, cols) {
  const wrap = document.createElement("div");
  const h = document.createElement("h3");
  h.textContent = title;
  wrap.appendChild(h);
  const table = document.createElement("table");
  const head = document.createElement("tr");
  for (const c of cols) {
    const th = document.createElement("th");
    th.textContent = c;
    head.appendChild(th);
  }
  table.appendChild(head);
  for (const row of rows ?? []) {
    const tr = document.createElement("tr");
    for (const c of cols) {
      const td = document.createElement("td");
      td.textContent = String(row[c] ?? "");
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  wrap.appendChild(table);
  return wrap;
}
function refreshRightIfRendered() {
  const title = $("#right-title").textContent;
  if (title && title !== "(no module selected)")
    selectModule(title);
}
async function resetAll() {
  for (const [id] of state.docs)
    AW.clearUnitHooks(id);
  state.docs.clear();
  state.phase.clear();
  $("#aw-live").innerHTML = "";
  showGenerated("");
  if (!state.current)
    throw new Error("no unit selected");
  await loadUnit(state.current);
  setStatus("idle", "idle");
}
async function init() {
  const meta = await fetchJson("/api/units");
  state.units = meta.units;
  state.workspace = meta.workspace;
  if (meta.style)
    state.style = meta.style;
  $("#ws-name").textContent = meta.workspace.split("/").pop() ?? "";
  const sel = $("#unit-select");
  for (const u of state.units) {
    const opt = document.createElement("option");
    opt.value = u.id;
    opt.textContent = u.deps.length > 0 ? `${u.id} (deps: ${u.deps.join(",")})` : u.id;
    sel.appendChild(opt);
  }
  for (const u of state.units) {
    const res = await fetch(`/api/author?id=${encodeURIComponent(u.id)}`);
    if (!res.ok)
      continue;
    const parsed = new DOMParser().parseFromString(await res.text(), "text/html");
    for (const m of parsed.querySelectorAll("autowire > aw-mod")) {
      const name = m.getAttribute("name");
      if (name)
        state.unitMods.set(name, u.id);
    }
  }
  const params = new URLSearchParams(location.search);
  const unitParam = params.get("unit");
  state.current = unitParam && unitOf(unitParam) ? unitParam : meta.defaultUnit ?? state.units[0]?.id ?? null;
  if (!state.current) {
    setStatus("error", "no connect units in autowire.toml");
    return;
  }
  sel.value = state.current;
  sel.addEventListener("change", async () => {
    state.current = sel.value;
    await resetAll();
  });
  $("#btn-check").addEventListener("click", () => runChain({ check: true }));
  $("#btn-elaborate").addEventListener("click", () => runChain({ elaborate: true }));
  $("#btn-run").addEventListener("click", () => runChain({ run: true }));
  $("#btn-save-sv").addEventListener("click", () => {
    try {
      saveSv();
    } catch {}
  });
  $("#btn-save-html").addEventListener("click", () => {
    try {
      saveHtml();
    } catch (e) {
      setStatus("error", e instanceof Error ? e.message : String(e));
    }
  });
  $("#btn-reset").addEventListener("click", () => resetAll());
  $("#dep-tree").addEventListener("click", (e) => {
    const mod = e.target?.dataset?.mod;
    if (mod)
      selectModule(mod);
  });
  await buildLeft();
  if (!state.current)
    throw new Error("no unit selected");
  await loadUnit(state.current);
  const actions = {
    select: params.get("select"),
    check: params.get("check") === "1",
    elaborate: params.get("elaborate") === "1" || params.get("render") === "1",
    run: params.get("run") === "1" || params.get("dump") === "1"
  };
  if (actions.select || actions.check || actions.elaborate || actions.run)
    await runChain(actions);
}
try {
  await init();
} catch (error) {
  setStatus("error", `init: ${error instanceof Error ? error.message : error}`);
  throw error;
}
