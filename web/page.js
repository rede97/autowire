// src/web/page.ts
import * as AWruntime from "/aw.js";
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
function saveGenerated() {
  const text = $("#aw-generated")?.textContent ?? "";
  if (!text) {
    setStatus("error", "save: run first; nothing generated");
    throw new Error("save: run first; nothing generated");
  }
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${state.current ?? "autowire"}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  setStatus("done", "save: browser download");
  return text;
}
var SESSION_HELP = [
  "before-instances: run author scripts on the current unit",
  "check: rule report; requires before-instances in this session",
  "elaborate: freeze aw-render; requires a clean check in this session",
  "before-dump: read-only hook; requires elaborate in this session",
  "run: the whole chain; same result as connect run, no file write",
  "save: return #aw-generated and start a browser download; no workspace path",
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
    return res.files.join(`
`);
  }
  if (step === "save") {
    return saveGenerated();
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
    files.push(AW.serializeSnapshot(entry.doc));
  }
  showGenerated(files.join(`
`));
  return { files };
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
  $("#btn-save").addEventListener("click", () => {
    try {
      saveGenerated();
    } catch {}
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
await init();
