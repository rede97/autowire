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
  leavesLoaded: false,
  phase: new Map,
  dirty: new Set,
  svText: "",
  htmlText: "",
  renderError: "",
  svError: "",
  rtlModule: null
};
function showGenerated(text) {
  const box = $("#aw-generated");
  box.hidden = false;
  box.textContent = text;
}
var minimal = document.documentElement.dataset.ui === "min";
var obsMute = 0;
function holdObs() {
  obsMute++;
}
function releaseObs() {
  queueMicrotask(() => {
    obsMute = Math.max(0, obsMute - 1);
  });
}
function watchInputs() {
  const obs = new MutationObserver((recs) => {
    if (obsMute > 0)
      return;
    for (const rec of recs) {
      const node = rec.target.nodeType === Node.ELEMENT_NODE ? rec.target : rec.target.parentElement;
      const unit = node?.closest("[data-unit]")?.getAttribute("data-unit");
      if (unit)
        state.dirty.add(unit);
    }
  });
  const opts = {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true
  };
  obs.observe($("#aw-source"), opts);
}
function parkOtherUnits(id) {
  const parked = [];
  for (const pane of ["#aw-source", "#aw-live"]) {
    const root = document.querySelector(pane);
    if (!root)
      continue;
    for (const el of [...root.children]) {
      if (!(el instanceof HTMLElement) || !el.dataset.unit)
        continue;
      if (pane === "#aw-live" && el.dataset.unit === id)
        continue;
      parked.push({ node: el, parent: root, next: el.nextSibling });
      el.remove();
    }
  }
  return () => {
    for (const item of parked.reverse())
      item.parent.insertBefore(item.node, item.next);
  };
}
function withCurrentUnit(id, fn) {
  holdObs();
  const restore = parkOtherUnits(id);
  try {
    return fn();
  } finally {
    restore();
    releaseObs();
  }
}
function setAuthorTab(which) {
  const src = document.querySelector("#author-source");
  const proc = document.querySelector("#author-processed");
  const rtl = document.querySelector("#author-rtl");
  if (!src || !proc)
    return;
  src.hidden = which !== "source";
  proc.hidden = which !== "processed";
  if (rtl)
    rtl.hidden = which !== "rtl";
  document.querySelector("#atab-source")?.setAttribute("aria-selected", String(which === "source"));
  document.querySelector("#atab-proc")?.setAttribute("aria-selected", String(which === "processed"));
  document.querySelector("#atab-rtl")?.setAttribute("aria-selected", String(which === "rtl"));
}
function setSideTab(which) {
  const rtl = document.querySelector("#pane-rtlindex");
  const connect = document.querySelector("#pane-connect");
  if (!rtl || !connect)
    return;
  rtl.hidden = which !== "rtl";
  connect.hidden = which !== "connect";
  document.querySelector("#tab-rtl")?.setAttribute("aria-selected", String(which === "rtl"));
  document.querySelector("#tab-connect")?.setAttribute("aria-selected", String(which === "connect"));
}
function refreshView(realId) {
  const view = document.querySelector(realId === "#aw-source" ? "#aw-source-view" : "#aw-live-view");
  const real = document.querySelector(realId);
  if (!view || !real)
    return;
  const open = new Set;
  for (const d of view.querySelectorAll("details:not([open])")) {
    const key = d.getAttribute("data-path");
    if (key)
      open.add(key);
  }
  view.replaceChildren();
  let n = 0;
  const walk = (node, host, path) => {
    for (const child of [...node.children]) {
      if (child.hasAttribute("data-unit")) {
        walk(child, host, path);
        continue;
      }
      const key = `${path}/${n++}`;
      host.appendChild(viewNode(child, key, open));
    }
  };
  walk(real, view, realId);
}
function viewNode(el, path, closed) {
  const tag = el.tagName.toLowerCase();
  const kids = [...el.children];
  if (kids.length === 0)
    return leafRow(el, tag);
  const box = document.createElement("details");
  box.open = !closed.has(path);
  box.dataset.path = path;
  const summary = document.createElement("summary");
  fillTag(summary, el, tag, true);
  box.appendChild(summary);
  if (tag === "script") {
    const body = document.createElement("span");
    body.className = "script-body";
    body.textContent = (el.textContent ?? "").replace(/^\n/, "").replace(/\s+$/, "");
    box.appendChild(body);
  }
  const rules = tag === "aw-template";
  const body = rules ? document.createElement("div") : box;
  if (rules) {
    body.className = "rules";
    box.appendChild(body);
  }
  let n = 0;
  for (const child of kids)
    body.appendChild(viewNode(child, `${path}/${n++}`, closed));
  return box;
}
function leafRow(el, tag) {
  if (tag === "aw-connect" || tag === "aw-rewrite" || tag === "aw-param" || tag === "aw-localparam") {
    const row = document.createElement("div");
    row.className = "leaf";
    for (const text of ruleCols(el, tag)) {
      const col = document.createElement("span");
      col.className = "col";
      col.textContent = text;
      row.appendChild(col);
    }
    return row;
  }
  const row = document.createElement("div");
  row.className = "leaf";
  fillTag(row, el, tag, false);
  if (tag === "script" && (el.textContent ?? "").trim()) {
    const body = document.createElement("span");
    body.className = "script-body";
    body.textContent = (el.textContent ?? "").replace(/^\n/, "").replace(/\s+$/, "");
    const wrap = document.createElement("div");
    wrap.appendChild(row);
    wrap.appendChild(body);
    return wrap;
  }
  return row;
}
function fillTag(host, el, tag, container) {
  const open = document.createElement("span");
  open.className = "tg";
  open.textContent = `<${tag}`;
  host.appendChild(open);
  for (const attr of el.attributes) {
    host.appendChild(document.createTextNode(" "));
    const name = document.createElement("span");
    name.className = "an";
    name.textContent = attr.name;
    host.appendChild(name);
    const eq = document.createElement("span");
    eq.className = "punct";
    eq.textContent = "=";
    host.appendChild(eq);
    const value = document.createElement("span");
    value.className = "av";
    value.textContent = `"${attr.value}"`;
    host.appendChild(value);
  }
  const end = document.createElement("span");
  end.className = "tg";
  end.textContent = container || (el.textContent ?? "").trim() ? ">" : " />";
  host.appendChild(end);
  if (!container)
    return;
  const ellipsis = document.createElement("span");
  ellipsis.className = "ellipsis";
  ellipsis.textContent = "...";
  host.appendChild(ellipsis);
  const close = document.createElement("span");
  close.className = "close";
  close.textContent = `</${tag}>`;
  host.appendChild(close);
}
function ruleCols(el, tag) {
  const a = (name) => el.getAttribute(name) ?? "";
  const extra = [
    a("packed") && `packed=${a("packed")}`,
    a("unpacked") && `unpacked=${a("unpacked")}`,
    a("width") && `width=${a("width")}`,
    a("part") && `part=${a("part")}`,
    a("nettype") && a("nettype")
  ].filter(Boolean).join("  ");
  if (tag === "aw-connect")
    return [
      a("type") || "net",
      `.${a("port")}`,
      a("to") || (a("type") === "open" ? "(open)" : ""),
      extra
    ];
  if (tag === "aw-rewrite")
    return [
      "rewrite",
      a("match"),
      a("to") || (a("type") === "open" ? "(open)" : ""),
      extra
    ];
  return [
    tag === "aw-localparam" ? "localparam" : "param",
    a("name"),
    a("expr"),
    extra
  ];
}
var SV_DIRS = new Set(["input", "output", "inout"]);
var SV_KW = new Set([
  "module",
  "endmodule",
  "logic",
  "wire",
  "reg",
  "assign",
  "parameter",
  "localparam",
  "interface",
  "modport",
  "import",
  "package",
  "endpackage",
  "generate",
  "endgenerate",
  "begin",
  "end",
  "if",
  "else",
  "for",
  "always",
  "always_ff",
  "always_comb",
  "always_latch",
  "posedge",
  "negedge",
  "or"
]);
function paintTokens(text, host, re, cls) {
  host.replaceChildren();
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last)
      host.appendChild(document.createTextNode(text.slice(last, i)));
    const tok = m[0];
    const span = document.createElement("span");
    const name = cls(tok);
    if (name)
      span.className = name;
    span.textContent = tok;
    host.appendChild(span);
    last = i + tok.length;
  }
  if (last < text.length)
    host.appendChild(document.createTextNode(text.slice(last)));
}
function highlightSv(text, host) {
  paintTokens(text, host, /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b\d+'[bodhBODH][0-9a-fA-FxXzZ_]+|\b\d+\b|\b[A-Za-z_][A-Za-z0-9_$]*\b/g, (tok) => {
    if (tok.startsWith("//") || tok.startsWith("/*"))
      return "sv-cmt";
    if (tok.startsWith('"') || tok.startsWith("'"))
      return "sv-str";
    if (SV_DIRS.has(tok))
      return "sv-dir";
    if (SV_KW.has(tok))
      return "sv-kw";
    if (/^\d/.test(tok))
      return "sv-num";
    return "";
  });
}
function highlightXml(text, host) {
  paintTokens(text, host, /<!--[\s\S]*?-->|<\/?[A-Za-z][\w:-]*|\/?>|[A-Za-z_:][\w:.-]*="[^"]*"/g, (tok) => {
    if (tok.startsWith("<!--"))
      return "xml-cmt";
    if (tok.includes("="))
      return "xml-attr";
    return "xml-tag";
  });
}
function paintResult() {
  const gen = $("#aw-generated");
  const list = document.querySelector("#error-list");
  const tabs = document.querySelector("#result-tabs");
  if (!tabs) {
    const err = state.renderError || state.svError;
    if (err) {
      if (list) {
        list.hidden = false;
        list.textContent = err;
      }
      gen.hidden = true;
    } else {
      if (list) {
        list.hidden = true;
        list.textContent = "";
      }
      gen.hidden = false;
      gen.textContent = state.svText || state.htmlText;
    }
    return;
  }
  const render = document.querySelector("#rtab-render")?.getAttribute("aria-selected") === "true";
  const err = render ? state.renderError : state.svError;
  if (err) {
    if (list) {
      list.hidden = false;
      list.textContent = err;
    }
    gen.hidden = true;
    return;
  }
  if (list) {
    list.hidden = true;
    list.textContent = "";
  }
  gen.hidden = false;
  if (render)
    highlightXml(state.htmlText, gen);
  else
    highlightSv(state.svText, gen);
}
function setResultTab(which) {
  document.querySelector("#rtab-render")?.setAttribute("aria-selected", String(which === "render"));
  document.querySelector("#rtab-sv")?.setAttribute("aria-selected", String(which === "sv"));
  paintResult();
}
function namesInErrors(errors) {
  const out = new Set;
  for (const e of errors) {
    for (const m of e.matchAll(/"([^"]+)"/g)) {
      const n = m[1] ?? "";
      if (n.length >= 2 && !/^\d+$/.test(n))
        out.add(n);
    }
  }
  return [...out];
}
function markProcessed(names) {
  const view = document.querySelector("#aw-live-view");
  if (!view)
    return;
  for (const el of view.querySelectorAll(".err"))
    el.classList.remove("err");
  if (names.length === 0)
    return;
  const want = new Set(names);
  for (const row of view.querySelectorAll(".leaf, details")) {
    const text = row.querySelector(":scope > summary, :scope")?.textContent ?? "";
    if ([...want].some((n) => text.includes(n)))
      row.classList.add("err");
  }
}
function snapshotOf(id) {
  const entry = state.docs.get(id);
  if (!entry?.doc)
    return "";
  return AW.serializeSnapshot(entry.doc);
}
function showErrors(errors) {
  state.renderError = errors.join(`
`);
  markProcessed(namesInErrors(errors));
  setAuthorTab("processed");
  const tabs = document.querySelector("#result-tabs");
  if (tabs) {
    tabs.removeAttribute("hidden");
    setResultTab("render");
  } else
    paintResult();
}
function showSvError(message) {
  state.svError = message;
  const tabs = document.querySelector("#result-tabs");
  if (tabs) {
    tabs.removeAttribute("hidden");
    setResultTab("sv");
  } else
    paintResult();
}
function showResult(sv, html) {
  if (sv !== null)
    state.svText = sv;
  if (html !== null)
    state.htmlText = html;
  if (sv !== null)
    state.svError = "";
  if (html !== null)
    state.renderError = "";
  markProcessed([]);
  const tabs = document.querySelector("#result-tabs");
  if (tabs) {
    tabs.removeAttribute("hidden");
    setResultTab(state.svText ? "sv" : "render");
    return;
  }
  paintResult();
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
  const text = state.svText;
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
  "check: static author-face rules; does not run scripts",
  "elaborate: classic scripts, then on-init / on-template, then freeze aw-render (does not write the input back)",
  "before-dump: snapshot of the frozen render; requires elaborate in this session",
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
  if (step === "check") {
    const res = await runCheck(id);
    const text = [...res.errors, ...res.warnings].join(`
`) || "check ok";
    if (res.errors.length === 0) {
      state.phase.set(id, "check");
      showResult("", snapshotOf(id));
      setAuthorTab("processed");
    } else
      showErrors(res.errors);
    return text;
  }
  if (step === "elaborate") {
    const res = await runRender(id);
    if (res.errors.length > 0)
      throw new Error(res.errors[0]);
    state.phase.set(id, "elaborate");
    showResult("", snapshotOf(id));
    setAuthorTab("processed");
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
function isClassicScript(script) {
  const type = (script.getAttribute("type") ?? "").trim().toLowerCase();
  return type === "" || type === "text/javascript" || type === "application/javascript";
}
async function runClassicScripts(root, unitHtml) {
  const scripts = [...root.querySelectorAll("script")];
  for (const script of scripts) {
    const type = (script.getAttribute("type") ?? "").trim().toLowerCase();
    if (type === "module")
      throw new Error('author script must be a classic <script> (type="module" is not allowed)');
    if (!isClassicScript(script))
      continue;
    const srcAttr = script.getAttribute("src");
    const inline = script.textContent ?? "";
    if (!srcAttr && !inline.trim())
      continue;
    const el = document.createElement("script");
    el.dataset.awInjected = "1";
    if (srcAttr) {
      const base = new URL(unitHtml, `${location.origin}/raw/`);
      el.src = new URL(srcAttr, base).href;
      await new Promise((resolve, reject) => {
        el.addEventListener("load", () => resolve());
        el.addEventListener("error", () => reject(new Error(`script failed to load ${srcAttr}`)));
        document.body.appendChild(el);
      });
    } else {
      el.textContent = inline;
      document.body.appendChild(el);
    }
    el.remove();
  }
}
async function compileUnit(entry, id, runScripts) {
  holdObs();
  try {
    if (entry.doc !== entry.source)
      entry.doc.remove();
    const container = document.createElement("div");
    container.dataset.unit = id;
    for (const child of [...entry.source.children])
      container.appendChild(child.cloneNode(true));
    $("#aw-live").appendChild(container);
    entry.doc = container;
    entry.container = container;
    entry.rendered = false;
    if (runScripts)
      await runClassicScripts(container, unitOf(id)?.html ?? "");
    state.dirty.delete(id);
    refreshView("#aw-live");
  } finally {
    releaseObs();
  }
}
async function loadUnit(id) {
  const cached = state.docs.get(id);
  if (cached)
    return cached;
  holdObs();
  try {
    const res = await fetch(`/api/author?id=${encodeURIComponent(id)}`);
    if (!res.ok)
      throw new Error((await res.json()).error);
    const html = await res.text();
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const root = parsed.querySelector("autowire");
    if (!root)
      throw new Error(`unit "${id}": author HTML has no <autowire> root`);
    const source = document.createElement("div");
    source.dataset.unit = id;
    for (const child of [...parsed.body.children]) {
      const tag = child.tagName.toLowerCase();
      if (tag === "script" || tag === "autowire")
        source.appendChild(document.importNode(child, true));
    }
    $("#aw-source").appendChild(source);
    refreshView("#aw-source");
    const entry = {
      source,
      doc: document.createElement("div"),
      container: source,
      rendered: false
    };
    state.docs.set(id, entry);
    await compileUnit(entry, id, false);
    return entry;
  } finally {
    releaseObs();
  }
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
    for (const p of mod.querySelectorAll(":scope > ports > port")) {
      const dir = p.getAttribute("dir") ?? "input";
      ports.push({
        name: p.getAttribute("name"),
        dir,
        packed: p.getAttribute("packed"),
        unpacked: p.getAttribute("unpacked"),
        nettype: p.getAttribute("nettype")
      });
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
        unpacked: p.getAttribute("unpacked"),
        nettype: p.getAttribute("nettype")
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
  await loadUnit(id);
  const wrappers = new Map;
  const missing = [];
  for (const dep of unit.deps) {
    const r = await depWrappers(dep);
    if (r.missing)
      missing.push(r.missing);
    for (const f of r.facts ?? [])
      wrappers.set(f.name ?? "", f);
  }
  if (!state.leavesLoaded) {
    const res = await fetch("/api/leaves");
    if (res.ok) {
      const data = await res.json();
      for (const mod of data.modules) {
        if (mod.name)
          state.leafCache.set(mod.name, mod);
      }
    }
    state.leavesLoaded = true;
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
async function runCheck(id) {
  const entry = await loadUnit(id);
  const { errors: ctxErrors, ctx } = await buildCtx(id);
  const res = AW.check(entry.source, ctx);
  return { errors: [...ctxErrors, ...res.errors], warnings: res.warnings };
}
async function runRender(id) {
  const entry = await loadUnit(id);
  await compileUnit(entry, id, true);
  setAuthorTab("processed");
  const { errors: ctxErrors, ctx } = await buildCtx(id);
  if (ctxErrors.length > 0)
    return { errors: ctxErrors, warnings: [] };
  const res = withCurrentUnit(id, () => AW.elaborate(entry.doc, ctx));
  if (res.errors.length === 0)
    entry.rendered = true;
  refreshView("#aw-live");
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
  showResult(sv, files.map((f) => f.text).join(`
`));
  setAuthorTab("processed");
  return { files: files.map((f) => f.text), sv };
}
async function runBeforeDumpOnly(id) {
  const entry = state.docs.get(id);
  if (!entry?.rendered)
    throw new Error(`session: "${id}" is not elaborated`);
  const text = AW.serializeSnapshot(entry.doc);
  showGenerated(text);
  return { files: [text] };
}
function setBtnState(which, s) {
  document.querySelector(`#btn-${which}`)?.setAttribute("data-state", s);
}
function resetBtnStates() {
  for (const b of ["check", "elaborate", "run"])
    setBtnState(b, "idle");
}
async function runChain({
  select,
  check,
  elaborate,
  run
}) {
  setStatus("running", "running…");
  resetBtnStates();
  try {
    if (select)
      await selectModule(select);
    const id = state.current;
    if (!id)
      throw new Error("no unit selected");
    const summary = [];
    if (run) {
      setBtnState("check", "running");
      try {
        const res = await runView(id);
        setBtnState("check", "done");
        setBtnState("elaborate", "done");
        setBtnState("run", "done");
        summary.push(`check: ok; elaborate: ok; source: ${res.files.length} unit(s) as .sv in view`);
      } catch (e) {
        const msg = e.message;
        if (msg.startsWith("check failed")) {
          setBtnState("check", "error");
          showErrors([msg]);
        } else if (msg.startsWith("render failed")) {
          setBtnState("check", "done");
          setBtnState("elaborate", "error");
          showErrors([msg]);
        } else {
          setBtnState("check", "done");
          setBtnState("elaborate", "done");
          setBtnState("run", "error");
          showSvError(msg);
        }
        throw e;
      }
    } else {
      if (check || elaborate) {
        setBtnState("check", "running");
        const res = await runCheck(id);
        summary.push(res.errors.length > 0 ? `check: ${res.errors.length} error(s)` : `check: ok${res.warnings.length > 0 ? ` (${res.warnings.length} warning(s))` : ""}`);
        if (res.errors.length > 0) {
          setBtnState("check", "error");
          showErrors(res.errors);
          throw new Error(res.errors[0]);
        }
        setBtnState("check", "done");
        showResult("", snapshotOf(id));
        setAuthorTab("processed");
        if (res.warnings.length > 0)
          console.warn("[autowire check warnings]", res.warnings);
      }
      if (elaborate) {
        setBtnState("elaborate", "running");
        const res = await runRender(id);
        if (res.errors.length > 0) {
          setBtnState("elaborate", "error");
          showErrors(res.errors);
          throw new Error(res.errors[0]);
        }
        setBtnState("elaborate", "done");
        summary.push("elaborate: ok");
        showResult("", snapshotOf(id));
        setAuthorTab("processed");
        refreshRightIfRendered();
      }
    }
    setStatus("done", summary.join("; ") || "done");
  } catch (e) {
    setStatus("error", e.message);
  }
}
async function buildSummary() {
  const db = document.querySelector("#db-summary");
  if (!db)
    return;
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
  } catch (e) {
    db.textContent = e.message;
  }
}
async function buildRtlList() {
  const list = document.querySelector("#rtl-list");
  if (!list)
    return;
  let rows = [];
  try {
    const data = await fetchJson("/api/modules");
    rows = [
      ...data.modules.map((m) => ({ name: m.name, kind: "module" })),
      ...data.packages.map((m) => ({ name: m.name, kind: "package" }))
    ];
  } catch (e) {
    list.textContent = e.message;
    return;
  }
  const paint = (q) => {
    list.replaceChildren();
    const needle = q.trim().toLowerCase();
    for (const row of rows) {
      if (needle && !row.name.toLowerCase().includes(needle))
        continue;
      const div = document.createElement("div");
      div.textContent = row.name;
      div.dataset.mod = row.name;
      if (row.kind === "package")
        div.className = "pkg";
      div.addEventListener("click", () => {
        selectModule(row.name);
      });
      list.appendChild(div);
    }
  };
  paint("");
  document.querySelector("#rtl-search")?.addEventListener("input", (e) => {
    paint(e.target.value);
  });
}
function buildUnitList() {
  const list = document.querySelector("#unit-list");
  if (!list)
    return;
  list.replaceChildren();
  for (const u of state.units) {
    const a = document.createElement("a");
    a.href = `/?unit=${encodeURIComponent(u.id)}`;
    a.textContent = u.id;
    if (u.id === state.current)
      a.setAttribute("aria-current", "true");
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = ` ${u.kind ?? "connect"}`;
    a.appendChild(kind);
    list.appendChild(a);
  }
}
async function selectModule(name) {
  state.rtlModule = name;
  const rtlPane = document.querySelector("#aw-rtl");
  if (rtlPane) {
    setAuthorTab("rtl");
    await renderRtlDetail(name, rtlPane);
    return;
  }
  const title = document.querySelector("#right-title");
  const body = document.querySelector("#right-body");
  if (!title || !body)
    return;
  title.textContent = name;
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
async function renderRtlDetail(name, host) {
  host.replaceChildren();
  host.classList.add("aw-tree");
  const title = document.createElement("div");
  title.className = "rtl-title";
  title.textContent = name;
  host.appendChild(title);
  const res = await fetch(`/api/module?name=${encodeURIComponent(name)}`);
  if (!res.ok) {
    const err = document.createElement("div");
    err.textContent = (await res.json()).error ?? "unknown module";
    host.appendChild(err);
    return;
  }
  const leaf = await res.json();
  host.appendChild(rtlSection("params", leaf.params ?? [], [
    "name",
    "kind",
    "dataType",
    "defaultText"
  ]));
  host.appendChild(rtlSection("imports", leaf.imports ?? [], ["package", "symbol"]));
  host.appendChild(rtlSection("ports", leaf.ports ?? [], [
    "name",
    "dir",
    "dataType",
    "packed",
    "unpacked"
  ]));
  if (leaf.instances && leaf.instances.length > 0)
    host.appendChild(rtlSection("instances", leaf.instances, ["id", "mod", "module"]));
}
function rtlSection(title, rows, cols) {
  const sec = document.createElement("details");
  sec.open = true;
  const head = document.createElement("summary");
  const mk = document.createElement("span");
  mk.className = "mk";
  mk.textContent = String(rows.length);
  head.appendChild(mk);
  head.appendChild(document.createTextNode(title));
  sec.appendChild(head);
  const table = document.createElement("table");
  const hr = document.createElement("tr");
  for (const c of cols) {
    const th = document.createElement("th");
    th.textContent = c;
    hr.appendChild(th);
  }
  table.appendChild(hr);
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const c of cols) {
      const td = document.createElement("td");
      td.textContent = String(row[c] ?? "");
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  sec.appendChild(table);
  return sec;
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
  const title = document.querySelector("#right-title");
  if (title?.textContent && title.textContent !== "(no module selected)")
    selectModule(title.textContent);
}
async function resetAll() {
  holdObs();
  try {
    state.docs.clear();
    state.phase.clear();
    state.dirty.clear();
    state.svText = "";
    state.htmlText = "";
    state.renderError = "";
    state.svError = "";
    state.rtlModule = null;
    $("#aw-live").innerHTML = "";
    $("#aw-source").innerHTML = "";
    const gen = $("#aw-generated");
    gen.hidden = false;
    gen.textContent = "";
    const list = document.querySelector("#error-list");
    if (list) {
      list.hidden = true;
      list.textContent = "";
    }
    document.querySelector("#result-tabs")?.setAttribute("hidden", "");
    const rtl = document.querySelector("#aw-rtl");
    if (rtl)
      rtl.replaceChildren();
    resetBtnStates();
    setAuthorTab("source");
    if (!state.current)
      throw new Error("no unit selected");
    await loadUnit(state.current);
    setStatus("idle", "idle");
  } finally {
    releaseObs();
  }
}
async function init() {
  const meta = await fetchJson("/api/units");
  state.units = meta.units;
  state.workspace = meta.workspace;
  if (meta.style)
    state.style = meta.style;
  $("#ws-name").textContent = meta.workspace.split("/").pop() ?? "";
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
  $("#unit-name").textContent = state.current;
  buildUnitList();
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
  document.querySelector("#tab-rtl")?.addEventListener("click", () => setSideTab("rtl"));
  document.querySelector("#tab-connect")?.addEventListener("click", () => setSideTab("connect"));
  document.querySelector("#atab-source")?.addEventListener("click", () => setAuthorTab("source"));
  document.querySelector("#atab-proc")?.addEventListener("click", () => setAuthorTab("processed"));
  document.querySelector("#atab-rtl")?.addEventListener("click", () => setAuthorTab("rtl"));
  document.querySelector("#rtab-render")?.addEventListener("click", () => setResultTab("render"));
  document.querySelector("#rtab-sv")?.addEventListener("click", () => setResultTab("sv"));
  watchInputs();
  await buildSummary();
  if (!minimal)
    await buildRtlList();
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
