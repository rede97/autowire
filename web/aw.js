// src/core/aw.ts
function evalConst(expr) {
  const s = expr.trim();
  if (s === "" || /[A-Za-z_`$]/.test(s.replace(/\d+'[bodhBODH][0-9a-fA-FxXzZ?]+/g, "")))
    return null;
  let i = 0;
  const peek = () => s[i];
  const skip = () => {
    while (/\s/.test(s[i] ?? ""))
      i++;
  };
  const num = () => {
    skip();
    const m = /^(\d+'[bodhBODH][0-9a-fA-FxXzZ?]+|\d+)/.exec(s.slice(i));
    if (!m)
      return null;
    i += m[0].length;
    const based = /^(\d+)'([bodhBODH])([0-9a-fA-FxXzZ?]+)$/.exec(m[0]);
    if (!based)
      return Number(m[0]);
    const [, , baseCh, digits] = based;
    if (baseCh === undefined || digits === undefined)
      return null;
    const base = { b: 2, o: 8, d: 10, h: 16 }[baseCh.toLowerCase()];
    if (base === undefined)
      return null;
    return Number.parseInt(digits.replace(/[xXzZ?]/g, "0"), base);
  };
  const prim = () => {
    skip();
    if (peek() === "(") {
      i++;
      const v = addsub();
      skip();
      if (peek() !== ")")
        return null;
      i++;
      return v;
    }
    return num();
  };
  const mul = () => {
    let v = prim();
    if (v == null)
      return null;
    for (;; ) {
      skip();
      if (peek() === "*" || peek() === "/" || peek() === "%") {
        const op = s[i++];
        const r = prim();
        if (r == null)
          return null;
        v = op === "*" ? v * r : op === "/" ? Math.trunc(v / r) : v % r;
      } else
        return v;
    }
  };
  const addsub = () => {
    let v = mul();
    if (v == null)
      return null;
    for (;; ) {
      skip();
      if (peek() === "+" || peek() === "-") {
        const op = s[i++];
        const r = mul();
        if (r == null)
          return null;
        v = op === "+" ? v + r : v - r;
      } else
        return v;
    }
  };
  const v = addsub();
  skip();
  return i === s.length ? v : null;
}
function evalPart(part) {
  if (!part)
    return part;
  const segs = part.split(":").map((seg) => {
    const v = evalConst(seg);
    return v == null ? seg.trim() : String(v);
  });
  return segs.join(":");
}
var DIM_SYMBOL = /`?[A-Za-z_][A-Za-z0-9_]*/g;
function canonicalDims(t) {
  return t && !t.startsWith("[") ? `[${t}]` : t;
}
function foldDims(text, vals) {
  if (!text)
    return text;
  const evalSeg = (seg) => seg.split(":").map((p) => {
    const v = evalConst(p);
    return v == null ? p.trim() : String(v);
  }).join(":");
  let t = text;
  for (let i = 0;i < 4; i++) {
    const next = t.replace(DIM_SYMBOL, (s) => !s.startsWith("`") && vals.has(s) ? `(${vals.get(s)})` : s);
    if (next === t)
      break;
    t = next;
  }
  t = t.replace(/\[([^\]]+)\]/g, (_m, inner) => `[${evalSeg(inner)}]`);
  if (!t.includes("["))
    t = evalSeg(t);
  return t;
}
var CONTENT_GROUPS = [
  "aw-imports",
  "aw-params",
  "aw-localparams",
  "aw-ports",
  "aw-templates",
  "aw-insts"
];
var GROUP_CHILD = {
  "aw-imports": "aw-import",
  "aw-params": "aw-param",
  "aw-localparams": "aw-localparam",
  "aw-ports": "aw-port",
  "aw-templates": "aw-template",
  "aw-insts": "aw-inst"
};
var RENDER_GROUPS = [
  "aw-params",
  "aw-imports",
  "aw-localparams",
  "aw-ports",
  "aw-signals",
  "aw-insts"
];
var IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
var LITERAL = /^(\d+('[bodhBODH][0-9a-fA-F_xXzZ?]+)?|\d+("[^"]*")?|"[^"]*")$/;
function classifyTo(text, scope) {
  const t = text.trim();
  if (t === "")
    return null;
  if (IDENT.test(t)) {
    return scope && (scope.params.has(t) || scope.localparams.has(t)) ? "const" : "net";
  }
  if (/^[\d'{`]/.test(t))
    return "const";
  const ids = t.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  if (ids.length > 0 && scope && ids.every((s) => scope.params.has(s) || scope.localparams.has(s))) {
    return "const";
  }
  return null;
}
function children(el, tag) {
  const out = [];
  for (const c of el.children ?? []) {
    if ((c.tagName ?? "").toLowerCase() === tag)
      out.push(c);
  }
  return out;
}
function tagOf(el) {
  return (el.tagName ?? "").toLowerCase();
}
function isTbMod(el) {
  return tagOf(el) === "aw-tb-mod";
}
function topMods(root) {
  return [...children(root, "aw-mod"), ...children(root, "aw-tb-mod")];
}
function splitIncludes(raw) {
  return (raw ?? "").split(/\s+/).filter(Boolean);
}
function child(el, tag) {
  for (const c of el.children ?? []) {
    if ((c.tagName ?? "").toLowerCase() === tag)
      return c;
  }
  return null;
}
function all(el, tag) {
  return [...el.querySelectorAll(tag)];
}
function attr(el, name) {
  return el.getAttribute(name);
}
function authorModOf(facts) {
  return {
    name: facts.name ?? "",
    params: (facts.params ?? []).map((p) => ({
      name: p.name,
      value: p.value ?? p.defaultText ?? ""
    })),
    ports: (facts.ports ?? []).map((p) => ({
      name: p.name,
      dir: p.dir,
      packed: p.packed ?? null,
      unpacked: p.unpacked ?? null
    })),
    imports: (facts.imports ?? []).map((i) => ({
      package: i.package,
      symbol: i.symbol
    }))
  };
}
function modsLookup(ctx, known) {
  return (name) => {
    const facts = known.get(name) ?? ctx.leaf?.(name) ?? ctx.wrapper?.(name) ?? null;
    return facts ? authorModOf(facts) : null;
  };
}
function authorWindow(el) {
  const view = el.ownerDocument.defaultView;
  return view ?? null;
}
function resolveAuthorFn(el, attrName, res, where) {
  const name = attr(el, attrName);
  if (name == null)
    return null;
  if (!IDENT.test(name)) {
    res.errors.push(`${where}: "${name}" is not a function name`);
    return null;
  }
  const fn = authorWindow(el)?.[name];
  if (typeof fn !== "function") {
    res.errors.push(`${where}: "${name}" is not a function on window`);
    return null;
  }
  return fn;
}
function callAuthorFn(fn, host, args, res, where) {
  let result;
  try {
    result = fn.call(host, ...args);
  } catch (e) {
    res.errors.push(`${where} threw: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (result != null && typeof result.then === "function") {
    res.errors.push(`${where}: function must be synchronous`);
  }
}
function putAttrs(el, attrs) {
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false)
      continue;
    const name = key === "onTemplate" ? "on-template" : key;
    el.setAttribute(name, String(value));
  }
}
function ensureChild(parent, tag) {
  const found = child(parent, tag);
  if (found)
    return found;
  const el = parent.ownerDocument.createElement(tag);
  parent.appendChild(el);
  return el;
}
function ownTemplate(inst) {
  const templates = children(inst, "aw-template");
  const last = templates[templates.length - 1];
  if (last)
    return last;
  const el = inst.ownerDocument.createElement("aw-template");
  inst.appendChild(el);
  return el;
}
function requireTag(el, tags, what) {
  const tag = (el.tagName ?? "").toLowerCase();
  if (!tags.includes(tag))
    throw new Error(`${what}: expected <${tags.join("|")}>, got <${tag}>`);
}
function appendRule(inst, tag, attrs) {
  requireTag(inst, ["aw-inst"], `aw.${tag.slice(3)}`);
  const el = inst.ownerDocument.createElement(tag);
  putAttrs(el, attrs);
  ownTemplate(inst).appendChild(el);
  return el;
}
function inst(content, attrs = {}) {
  requireTag(content, ["aw-content"], "aw.inst");
  const el = content.ownerDocument.createElement("aw-inst");
  putAttrs(el, attrs);
  ensureChild(content, "aw-insts").appendChild(el);
  return el;
}
function connect(instEl, attrs = {}) {
  return appendRule(instEl, "aw-connect", attrs);
}
function rewrite(instEl, attrs = {}) {
  return appendRule(instEl, "aw-rewrite", attrs);
}
function param(host, attrs = {}) {
  const tag = (host.tagName ?? "").toLowerCase();
  const parent = tag === "aw-inst" ? ownTemplate(host) : tag === "aw-content" ? ensureChild(host, "aw-params") : null;
  if (!parent)
    throw new Error("aw.param: expected <aw-inst> or <aw-content>");
  const el = host.ownerDocument.createElement("aw-param");
  putAttrs(el, attrs);
  parent.appendChild(el);
  return el;
}
function port(content, attrs = {}) {
  requireTag(content, ["aw-content"], "aw.port");
  const el = content.ownerDocument.createElement("aw-port");
  putAttrs(el, attrs);
  ensureChild(content, "aw-ports").appendChild(el);
  return el;
}
function localparam(content, attrs = {}) {
  requireTag(content, ["aw-content"], "aw.localparam");
  const el = content.ownerDocument.createElement("aw-localparam");
  putAttrs(el, attrs);
  ensureChild(content, "aw-localparams").appendChild(el);
  return el;
}
var CAPTURE_RE = /\$\d|\$&|\$</;
function substVars(text, vars, res, where) {
  return text.replace(/\$\{([^}]*)\}/g, (_m, name) => {
    const key = name.trim();
    if (Object.hasOwn(vars, key))
      return String(vars[key]);
    res.errors.push(`${where}: unknown variable \${${key}}`);
    return "";
  });
}
function rejectCaptures(text, res, where) {
  if (CAPTURE_RE.test(text)) {
    res.errors.push(`${where}: regex captures ($1 / $& / $<name>) are only allowed in aw-rewrite@to`);
  }
}
function classifyExpr(expr, scope) {
  const text = expr.trim();
  if (text.includes("`"))
    return { folded: false, value: text };
  if (LITERAL.test(text))
    return { folded: true, value: text };
  if (IDENT.test(text)) {
    const lp = scope.localparams.get(text);
    if (lp?.folded)
      return { folded: true, value: lp.resolved ?? lp.value };
    return { folded: false, value: text };
  }
  return { folded: false, value: text };
}
function rewriteDims(text, instParams, uniqName, leafParams, res, where) {
  if (!text)
    return text;
  const once = (t) => t.replace(DIM_SYMBOL, (sym) => {
    if (sym.startsWith("`"))
      return sym;
    if (instParams.has(sym))
      return uniqName(instParams.get(sym));
    const leaf = leafParams.get(sym);
    if (leaf) {
      const def = leaf.defaultText ?? leaf.value ?? null;
      if (def == null) {
        res.errors.push(`${where}: port dimension references leaf param ${sym} with no default and no aw-param override`);
        return sym;
      }
      return `(${def})`;
    }
    return sym;
  });
  let t = text;
  for (let i = 0;i < 4; i++) {
    const next = once(t);
    if (next === t)
      break;
    t = next;
  }
  return t;
}
function moduleScope(content) {
  const params = new Map;
  for (const p of children(child(content, "aw-params") ?? content, "aw-param")) {
    const name = attr(p, "name");
    const expr = (attr(p, "expr") ?? "").trim();
    if (name)
      params.set(name, { value: expr, folded: false });
  }
  const localparams = new Map;
  for (const lp of children(child(content, "aw-localparams") ?? content, "aw-localparam")) {
    const name = attr(lp, "name");
    const expr = (attr(lp, "expr") ?? "").trim();
    if (name)
      localparams.set(name, {
        value: expr,
        folded: LITERAL.test(expr) && !expr.includes("`")
      });
  }
  const chase = (entry) => {
    const seen = new Set;
    let cur = entry;
    while (!cur.folded && IDENT.test(cur.value) && !seen.has(cur.value)) {
      seen.add(cur.value);
      const nxt = localparams.get(cur.value);
      if (!nxt)
        break;
      if (nxt.folded) {
        entry.resolved = nxt.resolved ?? nxt.value;
        entry.folded = true;
        break;
      }
      cur = nxt;
    }
  };
  for (const v of localparams.values())
    chase(v);
  return { params, localparams };
}
function templateLib(content) {
  const lib = new Map;
  const group = child(content, "aw-templates");
  if (!group)
    return lib;
  for (const t of children(group, "aw-template")) {
    const name = attr(t, "name");
    if (name)
      lib.set(name, t);
  }
  return lib;
}
function check(doc, ctx = {}) {
  const res = { errors: [], warnings: [] };
  const roots = all(doc, "autowire").filter((e) => !e.closest("aw-mod") && !e.closest("aw-tb-mod"));
  if (roots.length === 0)
    res.errors.push("document: missing <autowire> root");
  if (roots.length > 1)
    res.errors.push("document: more than one top-level <autowire> root");
  const root = roots[0];
  if (!root)
    return res;
  const tops = topMods(root);
  if (ctx.unitKind === "sim") {
    if (tops.length === 0)
      res.errors.push("document: [sim] unit requires a top-level <aw-tb-mod>");
    for (const mod of tops) {
      if (!isTbMod(mod))
        res.errors.push(`document: [sim] unit must use <aw-tb-mod>, found <${tagOf(mod)}>`);
    }
  } else if (ctx.unitKind === "connect") {
    for (const mod of tops) {
      if (isTbMod(mod))
        res.errors.push("document: [connect] unit must not contain <aw-tb-mod> (use [sim.<id>])");
    }
  }
  for (const mod of tops)
    checkMod(mod, ctx, res, [], new Set);
  checkUnitRefs(doc, ctx, res);
  return res;
}
function checkUnitRefs(doc, ctx, res) {
  if (!ctx.unitMods)
    return;
  const section = ctx.unitKind === "sim" ? "sim" : "connect";
  const deps = new Set(ctx.unitDeps ?? []);
  const used = new Set;
  for (const inst of all(doc, "aw-inst")) {
    const target = attr(inst, "mod") ?? "";
    const owner = ctx.unitMods?.get(target);
    if (owner && owner !== ctx.unitId) {
      used.add(owner);
      if (!deps.has(owner)) {
        res.errors.push(`aw-inst mod="${target}": defined by unit "${owner}" but not listed in [${section}.${ctx.unitId}] deps`);
      }
    }
  }
  for (const d of deps) {
    if (!used.has(d))
      res.warnings.push(`[${section}.${ctx.unitId}] deps: "${d}" declared but never referenced`);
  }
}
function checkMod(mod, ctx, res, path, visibleFromAbove) {
  const tb = isTbMod(mod);
  const name = attr(mod, "name");
  const here = [...path, name ?? "?"];
  const where = `${tb ? "aw-tb-mod" : "aw-mod"} ${here.join(".")}`;
  if (!name)
    res.errors.push(`${where}: missing name`);
  if (tb) {
    if (path.length > 0)
      res.errors.push(`${where}: aw-tb-mod must be the unit top (no nesting)`);
    if (attr(mod, "deps"))
      res.errors.push(`${where}: aw-tb-mod@deps is forbidden (use [sim.<id>] deps)`);
    if (child(mod, "aw-submods"))
      res.errors.push(`${where}: aw-tb-mod must not contain aw-submods`);
    const content0 = child(mod, "aw-content");
    if (content0) {
      const params = child(content0, "aw-params");
      if (params && [...params.children ?? []].length > 0)
        res.errors.push(`${where}: aw-tb-mod forbids aw-params (use aw-localparams)`);
      const ports = child(content0, "aw-ports");
      if (ports && [...ports.children ?? []].length > 0)
        res.errors.push(`${where}: aw-tb-mod forbids aw-ports (TB top has no ports)`);
    }
  } else {
    if (attr(mod, "body-pre-include") || attr(mod, "body-post-include"))
      res.errors.push(`${where}: body-*-include is only allowed on aw-tb-mod`);
  }
  const content = child(mod, "aw-content");
  const submods = child(mod, "aw-submods");
  if (!content)
    res.errors.push(`${where}: missing aw-content`);
  if (content)
    checkContent(content, ctx, res, here, mod, visibleFromAbove, tb);
  if (submods) {
    const sibs = children(submods, "aw-mod");
    const sibNames = new Set(sibs.map((s) => attr(s, "name")));
    const depsOf = new Map;
    for (const s of sibs) {
      const deps = (attr(s, "deps") ?? "").split(/[\s,]+/).filter(Boolean);
      depsOf.set(attr(s, "name") ?? "", deps);
      for (const d of deps) {
        if (d === attr(s, "name"))
          res.errors.push(`${where}: aw-mod "${d}" depends on itself`);
        else if (!sibNames.has(d))
          res.errors.push(`${where}: aw-mod "${attr(s, "name")}" deps: unknown sibling "${d}"`);
      }
    }
    assertAcyclic(depsOf, res, where);
    const parentDeps = (attr(mod, "deps") ?? "").split(/[\s,]+/).filter(Boolean);
    const forChildren = new Set(visibleFromAbove);
    for (const d of parentDeps)
      forChildren.add(d);
    for (const s of sibs)
      checkMod(s, ctx, res, here, new Set(forChildren));
  }
}
function assertAcyclic(depsOf, res, where) {
  const state = new Map;
  const visit = (n, stack) => {
    if (state.get(n) === 2)
      return;
    if (state.get(n) === 1) {
      res.errors.push(`${where}: deps cycle (${[...stack, n].join(" → ")})`);
      return;
    }
    state.set(n, 1);
    for (const d of depsOf.get(n) ?? [])
      if (depsOf.has(d))
        visit(d, [...stack, n]);
    state.set(n, 2);
  };
  for (const n of depsOf.keys())
    visit(n, []);
}
function checkContent(content, ctx, res, path, mod, visibleFromAbove, tb = false) {
  const where = `${tb ? "aw-tb-mod" : "aw-mod"} ${path.join(".")}`;
  const scope = moduleScope(content);
  for (const c of content.children ?? []) {
    const tag = (c.tagName ?? "").toLowerCase();
    if (!CONTENT_GROUPS.includes(tag))
      res.errors.push(`${where}: unexpected <${tag}> under aw-content`);
  }
  for (const g of CONTENT_GROUPS) {
    const group = child(content, g);
    if (!group)
      continue;
    for (const c of group.children ?? []) {
      const tag = (c.tagName ?? "").toLowerCase();
      if (tag !== GROUP_CHILD[g])
        res.errors.push(`${where}: <${tag}> not allowed under ${g}`);
    }
  }
  const lib = templateLib(content);
  const modVars = {};
  for (const [k, v] of scope.params)
    modVars[k] = v.value;
  for (const [k, v] of scope.localparams)
    modVars[k] = v.value;
  for (const [tname, t] of lib)
    checkTemplate(t, ctx, res, `${where} template "${tname}"`, lib, scope, tb);
  const sibs = children(child(mod, "aw-submods") ?? mod, "aw-mod");
  const ownChildren = new Set(sibs.map((s) => attr(s, "name")));
  const ownDeps = (attr(mod, "deps") ?? "").split(/[\s,]+/).filter(Boolean);
  const visible = new Set([...visibleFromAbove, ...ownDeps]);
  const usedDeps = new Set;
  for (const inst of children(child(content, "aw-insts") ?? content, "aw-inst")) {
    const id = attr(inst, "id");
    const target = attr(inst, "mod") ?? "";
    const iwhere = `${where} aw-inst "${id ?? "?"}"`;
    if (!id)
      res.errors.push(`${iwhere}: missing id`);
    if (!target)
      res.errors.push(`${iwhere}: missing mod`);
    for (const c of inst.children ?? []) {
      const tag = (c.tagName ?? "").toLowerCase();
      if (tag !== "aw-template")
        res.errors.push(`${iwhere}: <${tag}> must be wrapped in <aw-template>`);
    }
    if (target) {
      const isLeaf = ctx.leaf?.(target) != null;
      const isChild = ownChildren.has(target);
      const isUnitMod = ctx.unitMods?.get(target) && ctx.unitMods.get(target) !== ctx.unitId;
      if (!isLeaf && !isChild && !isUnitMod) {
        if (visible.has(target))
          usedDeps.add(target);
        else
          res.errors.push(`${iwhere}: mod "${target}" is not a RtlIndex leaf, not a child aw-mod, and not in the visible set (add it to aw-mod@deps)`);
      }
      if (isLeaf)
        checkLeafInst(inst, ctx.leaf?.(target) ?? null, res, iwhere);
    }
    for (const t of children(inst, "aw-template")) {
      checkTemplate(t, ctx, res, `${iwhere} template`, lib, scope, tb);
      const base = attr(t, "base");
      if (base && !lib.has(base))
        res.errors.push(`${iwhere}: unknown template base "${base}" (templates are per-aw-mod)`);
    }
  }
  for (const d of ownDeps) {
    if (!usedDeps.has(d)) {
      res.warnings.push(`${where}: deps "${d}" declared but never referenced`);
    }
  }
}
function checkLeafInst(inst, leaf, res, where) {
  const leafParams = new Map((leaf?.params ?? []).map((p) => [p.name, p]));
  const leafPorts = new Set((leaf?.ports ?? []).map((p) => p.name));
  for (const t of children(inst, "aw-template")) {
    for (const r of walkRules(t)) {
      const tag = (r.tagName ?? "").toLowerCase();
      if (tag === "aw-param") {
        const name = attr(r, "name");
        const lp = leafParams.get(name ?? "");
        if (leaf && name && !lp) {
          res.errors.push(`${where}: aw-param "${name}" does not exist on module ${attr(inst, "mod")}`);
        } else if (lp?.kind === "localparam") {
          res.errors.push(`${where}: aw-param "${name}" is a localparam on ${attr(inst, "mod")} (not overridable)`);
        }
      }
      if (tag === "aw-connect") {
        const port = attr(r, "port");
        if (leaf && port && !leafPorts.has(port)) {
          res.errors.push(`${where}: aw-connect port "${port}" does not exist on module ${attr(inst, "mod")}`);
        }
      }
    }
  }
}
function* walkRules(tpl) {
  for (const r of tpl.children ?? []) {
    const tag = (r.tagName ?? "").toLowerCase();
    if (["aw-param", "aw-connect", "aw-rewrite"].includes(tag))
      yield r;
  }
}
function checkTemplate(t, ctx, res, where, lib, scope, tb = false) {
  const modVars = {};
  for (const [k, v] of scope.params)
    modVars[k] = v.value;
  for (const [k, v] of scope.localparams)
    modVars[k] = v.value;
  const probeVars = { id: "u", idx: "0", mod: "m", ...modVars };
  const probeTo = (r) => {
    const raw = attr(r, "to");
    if (!raw)
      return null;
    const probe = { errors: [], warnings: [] };
    const text = substVars(raw, probeVars, probe, `${where} @to`);
    res.errors.push(...probe.errors);
    return text;
  };
  for (const r of walkRules(t)) {
    const tag = (r.tagName ?? "").toLowerCase();
    if (tag === "aw-rewrite" || tag === "aw-connect") {
      const typeAttr = attr(r, "type");
      const isOpen = typeAttr === "open";
      const isRaw = typeAttr === "raw";
      if (isRaw) {
        if (!tb)
          res.errors.push(`${where}: type="raw" is only allowed inside aw-tb-mod`);
        if (tag === "aw-rewrite")
          res.errors.push(`${where}: aw-rewrite must not produce type="raw"`);
        for (const a of ["part", "packed", "width", "unpacked", "nettype"]) {
          if (attr(r, a))
            res.errors.push(`${where}: type="raw" takes no @${a}`);
        }
      }
      if (tag === "aw-rewrite" && !attr(r, "match"))
        res.errors.push(`${where}: aw-rewrite missing match`);
      if (tag === "aw-connect" && !attr(r, "port"))
        res.errors.push(`${where}: aw-connect missing port`);
      if (tag === "aw-rewrite") {
        try {
          new RegExp(attr(r, "match") ?? "", attr(r, "flags") ?? "");
        } catch (e) {
          res.errors.push(`${where}: aw-rewrite bad RegExp: ${e.message}`);
        }
      }
      if (isOpen) {
        for (const a of [
          "to",
          "part",
          "packed",
          "width",
          "unpacked",
          "nettype"
        ]) {
          if (attr(r, a)) {
            res.errors.push(`${where}: type="open" takes no @${a}`);
          }
        }
        continue;
      }
      if (!attr(r, "to")) {
        res.errors.push(`${where}: ${tag} missing to (declare type="open" for a dangling pin)`);
        continue;
      }
      if (isRaw) {
        probeTo(r);
        continue;
      }
      if (tag === "aw-connect")
        rejectCaptures(attr(r, "to") ?? "", res, `${where} aw-connect@to`);
      const rawText = probeTo(r);
      const text = tag === "aw-rewrite" && rawText != null ? rawText.replace(/\$<[^>]*>|\$\d+|\$&/g, "x") : rawText;
      if (text == null)
        continue;
      const kind = classifyTo(text, scope);
      if (kind == null) {
        res.errors.push(`${where} ${tag}@to: "${text}" is neither a net name nor a constant`);
      } else if (kind === "net") {
        checkNetName(text, res, `${where} ${tag}@to`);
      } else {
        if (tag === "aw-rewrite" && CAPTURE_RE.test(attr(r, "to") ?? "")) {
          res.errors.push(`${where}: aw-rewrite@to is a constant but uses regex captures`);
        }
        if (attr(r, "part")) {
          res.errors.push(`${where}: part-select on a constant is not allowed`);
        }
        for (const a of ["packed", "width", "unpacked", "nettype"]) {
          if (attr(r, a)) {
            res.errors.push(`${where}: @${a} does not apply to a constant`);
          }
        }
      }
      checkTypeAttr(r, kind, res, where);
    }
    if (tag === "aw-param") {
      if (!attr(r, "name"))
        res.errors.push(`${where}: aw-param missing name`);
      rejectCaptures(attr(r, "expr") ?? "", res, `${where} aw-param@expr`);
    }
    const packed = attr(r, "packed");
    const width = attr(r, "width");
    if (packed && width && packed !== "auto" && width !== "auto" && packed !== width) {
      res.errors.push(`${where}: packed="${packed}" conflicts with width="${width}"`);
    }
    for (const a of ["packed", "width", "unpacked", "part"]) {
      const v = attr(r, a);
      if (v)
        rejectCaptures(v, res, `${where} @${a}`);
    }
    for (const a of [
      "expr",
      "packed",
      "width",
      "unpacked",
      "part",
      "inst_name"
    ]) {
      const v = attr(r, a);
      if (!v)
        continue;
      const probe = { errors: [], warnings: [] };
      substVars(v, { id: "", idx: "", mod: "", ...modVars }, probe, `${where} @${a}`);
      res.errors.push(...probe.errors);
    }
  }
  const instName = attr(t, "inst_name");
  if (instName) {
    rejectCaptures(instName, res, `${where} @inst_name`);
    const probe = { errors: [], warnings: [] };
    substVars(instName, { id: "", idx: "", mod: "", ...modVars }, probe, `${where} @inst_name`);
    res.errors.push(...probe.errors);
  }
  const nettype = attr(t, "nettype");
  for (const r of walkRules(t)) {
    const nt = attr(r, "nettype");
    if (nt && nt !== "wire" && nt !== "logic") {
      res.errors.push(`${where}: nettype "${nt}" must be wire|logic`);
    }
  }
}
function checkTypeAttr(r, kind, res, where) {
  const asserted = attr(r, "type");
  if (asserted != null && !["net", "const", "open", "raw"].includes(asserted)) {
    res.errors.push(`${where}: type must be "net", "const", "open" or "raw", got "${asserted}"`);
    return;
  }
  if (asserted != null && kind != null && asserted !== kind) {
    res.errors.push(`${where}: type="${asserted}" but to classifies as ${kind}`);
  } else if (kind === "const" && asserted == null) {
    res.errors.push(`${where}: constant must be declared type="const" (type defaults to net)`);
  }
}
function checkNetName(to, res, where) {
  if (!to)
    return;
  if (/[[\]]/.test(to))
    res.errors.push(`${where}: "${to}" must be a bare net name (no [] / part-select)`);
}
var frozen = new WeakSet;
function isFrozen(renderEl) {
  return frozen.has(renderEl);
}
function elaborate(doc, ctx = {}) {
  const res = { errors: [], warnings: [] };
  const root = all(doc, "autowire").filter((e) => !e.closest("aw-mod") && !e.closest("aw-tb-mod"))[0];
  if (!root) {
    res.errors.push("document: missing <autowire> root");
    return res;
  }
  for (const mod of topMods(root)) {
    elaborateMod(mod, ctx, res, [], new Map);
  }
  return res;
}
function elaborateMod(mod, ctx, res, path, sibRenders) {
  const tb = isTbMod(mod);
  const name = attr(mod, "name") ?? "?";
  const here = [...path, name];
  const where = `${tb ? "aw-tb-mod" : "aw-mod"} ${here.join(".")}`;
  const errAtEntry = res.errors.length;
  const content = child(mod, "aw-content");
  if (!content) {
    res.errors.push(`${where}: missing aw-content`);
    return null;
  }
  const submods = tb ? null : child(mod, "aw-submods");
  const childRenders = new Map;
  if (submods) {
    const sibs = children(submods, "aw-mod");
    const depsOf = new Map(sibs.map((s) => [
      attr(s, "name") ?? "",
      (attr(s, "deps") ?? "").split(/[\s,]+/).filter(Boolean)
    ]));
    const sibByName = new Map(sibs.map((x) => [attr(x, "name") ?? "", x]));
    for (const s of topoOrder(depsOf)) {
      const el = sibByName.get(s);
      const facts = elaborateMod(el, ctx, res, here, childRenders);
      if (facts)
        childRenders.set(s, facts);
    }
  }
  for (const [k, v] of sibRenders)
    if (!childRenders.has(k))
      childRenders.set(k, v);
  const initFn = resolveAuthorFn(content, "on-init", res, `${where} on-init`);
  if (initFn) {
    const before = res.errors.length;
    callAuthorFn(initFn, content, [content, modsLookup(ctx, childRenders)], res, `${where} on-init`);
    if (res.errors.length > before)
      return null;
  }
  const scope = moduleScope(content);
  const lib = templateLib(content);
  const instsGroup = child(content, "aw-insts");
  const instEls = instsGroup ? children(instsGroup, "aw-inst") : [];
  const renderInsts = [];
  const seenInstNames = new Set;
  const uniqLocalparams = [];
  const usedUniqNames = new Set;
  const factsCache = new Map;
  const factsOf = (target) => {
    let f = factsCache.get(target);
    if (f === undefined) {
      f = ctx.leaf?.(target) ?? childRenders.get(target) ?? ctx.wrapper?.(target) ?? null;
      factsCache.set(target, f);
    }
    return f;
  };
  const leafParamsCache = new Map;
  const leafParamsOf = (target) => {
    let m = leafParamsCache.get(target);
    if (!m) {
      m = new Map((factsOf(target)?.params ?? []).map((p) => [p.name, p]));
      leafParamsCache.set(target, m);
    }
    return m;
  };
  const portFactsCache = new Map;
  const portFactsOf = (target) => {
    let m = portFactsCache.get(target);
    if (!m) {
      m = new Map((factsOf(target)?.ports ?? []).map((p) => [p.name, p]));
      portFactsCache.set(target, m);
    }
    return m;
  };
  const portOrderCache = new Map;
  const portOrderOf = (target) => {
    let order = portOrderCache.get(target);
    if (!order) {
      order = (factsOf(target)?.ports ?? []).map((p) => p.name);
      portOrderCache.set(target, order);
    }
    return order;
  };
  for (const inst of instEls) {
    const id = attr(inst, "id") ?? "?";
    const target = attr(inst, "mod") ?? "";
    const iwhere = `${where} aw-inst "${id}"`;
    const targetFacts = factsOf(target);
    if (!targetFacts) {
      res.errors.push(`${iwhere}: unknown module "${target}" (no RtlIndex leaf and no elaborated wrapper)`);
      continue;
    }
    const tplFn = resolveAuthorFn(inst, "on-template", res, `${iwhere} on-template`);
    if (tplFn) {
      const before = res.errors.length;
      callAuthorFn(tplFn, inst, [inst, authorModOf(targetFacts)], res, `${iwhere} on-template`);
      if (res.errors.length > before)
        continue;
    }
    const vars = {
      id,
      idx: attr(inst, "idx") ?? "0",
      mod: target
    };
    for (const [k, v] of scope.params)
      vars[k] = v.resolved ?? v.value;
    for (const [k, v] of scope.localparams)
      vars[k] = v.resolved ?? v.value;
    const chain = [];
    for (const t of children(inst, "aw-template"))
      expandTemplate(t, lib, chain, res, iwhere, new Set);
    let instNameTpl = "${id}";
    for (const t of chain) {
      const v = attr(t, "inst_name");
      if (v)
        instNameTpl = v;
    }
    const instName = substVars(instNameTpl, vars, res, `${iwhere} @inst_name`);
    if (seenInstNames.has(instName)) {
      res.errors.push(`${iwhere}: expanded instance name "${instName}" is not unique under ${where}`);
      continue;
    }
    seenInstNames.add(instName);
    const paramRules = new Map;
    for (const t of chain) {
      for (const r of walkRules(t)) {
        if ((r.tagName ?? "").toLowerCase() === "aw-param")
          paramRules.set(attr(r, "name"), attr(r, "expr") ?? "");
      }
    }
    const inlineParams = ctx.style?.paramInline !== false;
    const instParams = new Map;
    for (const [pname, expr0] of paramRules) {
      const expr = substVars(expr0, vars, res, `${iwhere} aw-param "${pname}"`);
      const cls = classifyExpr(expr, scope);
      const uniq0 = `${name}__${instName}__${pname}`;
      const uniq = ctx.style?.localparamUpper ? uniq0.toUpperCase() : uniq0;
      const simple = LITERAL.test(cls.value) || IDENT.test(cls.value) || /^`[A-Za-z_]\w*$/.test(cls.value);
      if (inlineParams && simple) {
        instParams.set(pname, {
          expr: cls.value,
          uniq: `(${cls.value})`,
          renderValue: cls.value
        });
        continue;
      }
      if (usedUniqNames.has(uniq)) {
        res.errors.push(`${iwhere}: localparam ${uniq} generated twice`);
        continue;
      }
      usedUniqNames.add(uniq);
      instParams.set(pname, { expr: cls.value, uniq, renderValue: uniq });
      uniqLocalparams.push({
        name: uniq,
        value: cls.value,
        folded: cls.folded,
        forInst: instName,
        forParam: pname
      });
    }
    const ports = targetFacts.ports ?? [];
    const leafParams = leafParamsOf(target);
    for (const pname of instParams.keys()) {
      const target2 = leafParams.get(pname);
      if (!target2) {
        res.errors.push(`${iwhere}: aw-param "${pname}" does not exist on module ${target}`);
      } else if (target2.kind === "localparam") {
        res.errors.push(`${iwhere}: aw-param "${pname}" is a localparam on ${target} (not overridable)`);
      }
    }
    const connects = new Map;
    for (const t of chain) {
      for (const r of walkRules(t)) {
        const tag = (r.tagName ?? "").toLowerCase();
        if (tag === "aw-connect" || tag === "aw-rewrite") {
          if (attr(r, "type") === "open") {
            if (tag === "aw-connect") {
              connects.set(attr(r, "port"), {
                open: true,
                to: null,
                part: null
              });
            } else {
              let re;
              try {
                re = new RegExp(attr(r, "match") ?? "", attr(r, "flags") ?? "");
              } catch {
                continue;
              }
              for (const p of ports) {
                if (re.test(p.name))
                  connects.set(p.name, { open: true, to: null, part: null });
              }
            }
            continue;
          }
        }
        if (tag === "aw-connect") {
          const cport = attr(r, "port") ?? "?";
          connects.set(cport, ruleToConnect(r, cport, vars, res, iwhere, null, scope));
        } else if (tag === "aw-rewrite") {
          let re;
          try {
            re = new RegExp(attr(r, "match") ?? "", attr(r, "flags") ?? "");
          } catch {
            continue;
          }
          for (const p of ports) {
            if (!re.test(p.name))
              continue;
            const net = p.name.replace(re, attr(r, "to") ?? "");
            connects.set(p.name, ruleToConnect(r, p.name, vars, res, iwhere, net, scope));
          }
        }
      }
    }
    for (const p of ports) {
      if (connects.has(p.name) || p.dir === "interface")
        continue;
      connects.set(p.name, {
        to: p.name,
        packed: null,
        width: null,
        unpacked: null,
        part: null,
        nettype: null,
        isConst: false
      });
    }
    renderInsts.push({
      id: instName,
      mod: target,
      params: instParams,
      connects,
      order: portOrderOf(target),
      leafParams
    });
  }
  const dimVals = new Map;
  for (const [k, v] of scope.localparams)
    dimVals.set(k, v.resolved ?? v.value);
  for (const lp of uniqLocalparams)
    dimVals.set(lp.name, lp.value);
  const signals = new Map;
  const netDirs = new Map;
  const fullDrivers = new Map;
  const netMode = ctx.style?.netType ?? "logic";
  for (const ri of renderInsts) {
    const portFacts = portFactsOf(ri.mod);
    for (const [port, c] of ri.connects) {
      const pf = portFacts.get(port);
      if (pf) {
        c.dir = pf.dir;
        const scratch = { errors: [], warnings: [] };
        const rewritePort = (dims) => dims ? rewriteDims(dims, ri.params, (p) => p.uniq, ri.leafParams, scratch, `${where} port "${port}"`) : null;
        c.portPackedRaw = rewritePort(pf.packed);
        c.portUnpackedRaw = rewritePort(pf.unpacked);
        const foldPort = (dims) => dims ? canonicalDims(foldDims(dims, dimVals)) : null;
        c.portPacked = foldPort(c.portPackedRaw);
        c.portUnpacked = foldPort(c.portUnpackedRaw);
      }
      if (c.open) {
        if (pf && pf.dir !== "output" && pf.dir !== "inout") {
          res.errors.push(`${where} port "${port}": open is only allowed on output/inout (got ${pf.dir}; tie inputs off with type="const")`);
        }
        continue;
      }
      if (c.isRaw) {
        continue;
      }
      if (c.isConst) {
        if (pf?.dir !== "input") {
          res.errors.push(`${where} port "${port}": constant "${c.to}" drives a ${pf?.dir ?? "unknown-dir"} port (inputs only)`);
        }
        continue;
      }
      const net0 = c.to ?? "";
      if (pf?.dir === "output" && c.part == null)
        fullDrivers.set(net0, (fullDrivers.get(net0) ?? 0) + 1);
      const dirs = netDirs.get(net0) ?? new Set;
      dirs.add(pf?.dir ?? "input");
      netDirs.set(net0, dirs);
      const dims = resolveDims(c, pf, ri, name, res, `${where} port "${port}"`, netMode === "auto");
      mergeSignal(signals, net0, dims, dimVals, res, `${where} port "${port}"`);
    }
  }
  for (const [net, n] of fullDrivers)
    if (n > 1)
      res.errors.push(`${where}: net "${net}" has ${n} full-net output drivers (short circuit)`);
  const foldPortDims = (packed, unpacked) => ({
    packed: packed ? canonicalDims(foldDims(packed, dimVals)) : null,
    unpacked: unpacked ? canonicalDims(foldDims(unpacked, dimVals)) : null
  });
  const portsOut = [];
  const explicit = new Set;
  const portsGroup = tb ? null : child(content, "aw-ports");
  for (const p of portsGroup ? children(portsGroup, "aw-port") : []) {
    const pname = attr(p, "name");
    if (!pname)
      continue;
    explicit.add(pname);
    const folded = foldPortDims(attr(p, "packed") ?? signals.get(pname)?.packed ?? null, attr(p, "unpacked") ?? signals.get(pname)?.unpacked ?? null);
    portsOut.push({
      name: pname,
      dir: attr(p, "dir") ?? "input",
      packed: folded.packed,
      unpacked: folded.unpacked,
      nettype: attr(p, "nettype") ?? null,
      interface: attr(p, "interface") ?? null,
      modport: attr(p, "modport") ?? null
    });
  }
  if (!tb) {
    for (const [net, sig] of signals) {
      if (explicit.has(net))
        continue;
      const dirs = netDirs.get(net) ?? new Set;
      let dir = null;
      if (dirs.has("inout"))
        dir = "inout";
      else if ([...dirs].every((d) => d === "input"))
        dir = "input";
      else if ([...dirs].every((d) => d === "output"))
        dir = "output";
      if (!dir)
        continue;
      const folded = foldPortDims(sig.packed, sig.unpacked);
      portsOut.push({
        name: net,
        dir,
        packed: folded.packed,
        unpacked: folded.unpacked,
        nettype: sig.nettype,
        interface: sig.interface ?? null,
        modport: null,
        auto: true
      });
    }
  }
  const netFill = netMode === "auto" ? "logic" : netMode;
  for (const sig of signals.values()) {
    if (sig.nettype == null)
      sig.nettype = netFill;
  }
  for (const p of portsOut) {
    if (p.nettype != null)
      continue;
    p.nettype = netMode === "auto" ? signals.get(p.name)?.nettype ?? "logic" : netFill;
  }
  const taken = new Set([
    ...scope.params.keys(),
    ...scope.localparams.keys(),
    ...signals.keys()
  ]);
  for (const lp of uniqLocalparams) {
    if (taken.has(lp.name))
      res.errors.push(`${where}: generated localparam ${lp.name} collides with an existing name`);
  }
  const imports = [];
  const seenImports = new Set;
  const addImport = (pkg, symbol) => {
    const key = `${pkg}::${symbol}`;
    if (!pkg || seenImports.has(key))
      return;
    seenImports.add(key);
    imports.push({ package: pkg, symbol: symbol ?? "*" });
  };
  const impGroup = child(content, "aw-imports");
  for (const i of impGroup ? children(impGroup, "aw-import") : []) {
    addImport(attr(i, "package"), attr(i, "symbol") ?? "*");
  }
  for (const facts of childRenders.values()) {
    for (const i of facts.imports ?? [])
      addImport(i.package, i.symbol);
  }
  for (const ri of renderInsts) {
    for (const p of factsOf(ri.mod)?.ports ?? []) {
      const m = /([A-Za-z_][A-Za-z0-9_]*)::/.exec(p.dataType ?? "");
      if (m)
        addImport(m[1] ?? null, "*");
    }
  }
  if (res.errors.length > errAtEntry)
    return null;
  writeRender(mod, {
    scope,
    imports,
    uniqLocalparams,
    portsOut,
    signals,
    renderInsts,
    isTb: tb,
    bodyPreInclude: tb ? splitIncludes(attr(mod, "body-pre-include")) : [],
    bodyPostInclude: tb ? splitIncludes(attr(mod, "body-post-include")) : []
  });
  frozen.add(child(mod, "aw-render"));
  return {
    name,
    params: [...scope.params.entries()].map(([n, v]) => ({
      name: n,
      value: v.value
    })),
    ports: portsOut,
    imports
  };
}
function topoOrder(depsOf) {
  const out = [];
  const state = new Map;
  const visit = (n) => {
    if (state.get(n) === 2)
      return;
    if (state.get(n) === 1)
      return;
    state.set(n, 1);
    for (const d of depsOf.get(n) ?? [])
      if (depsOf.has(d))
        visit(d);
    state.set(n, 2);
    out.push(n);
  };
  for (const n of depsOf.keys())
    visit(n);
  return out;
}
function expandTemplate(t, lib, chain, res, where, seen) {
  const base = attr(t, "base");
  if (base) {
    if (seen.has(base)) {
      res.errors.push(`${where}: template base cycle at "${base}"`);
      return;
    }
    const b = lib.get(base);
    if (!b)
      return;
    seen.add(base);
    expandTemplate(b, lib, chain, res, where, seen);
  }
  chain.push(t);
}
function ruleToConnect(r, port, vars, res, where, rewrittenNet, scope) {
  const to = rewrittenNet ?? attr(r, "to") ?? "";
  const net = substVars(to, vars, res, `${where} connect "${port}"`);
  const sub = (a) => {
    const v = attr(r, a);
    return v == null || v === "" ? null : substVars(v, vars, res, `${where} @${a}`);
  };
  if (attr(r, "type") === "raw") {
    return {
      to: net,
      packed: null,
      width: null,
      unpacked: null,
      part: null,
      nettype: null,
      isConst: false,
      isRaw: true
    };
  }
  const kind = classifyTo(net, scope);
  if (kind == null) {
    res.errors.push(`${where} connect "${port}": "${net}" is neither a net name nor a constant`);
  }
  const asserted = attr(r, "type");
  if (asserted != null && !["net", "const", "open"].includes(asserted)) {
    res.errors.push(`${where}: type must be "net", "const" or "open", got "${asserted}"`);
  } else if (asserted === "open") {
    res.errors.push(`${where} connect "${port}": type="open" takes no to (did you mean a dangling pin?)`);
  } else if (asserted != null && kind != null && asserted !== kind) {
    res.errors.push(`${where} connect "${port}": type="${asserted}" but "${net}" classifies as ${kind}`);
  } else if (kind === "const" && asserted == null) {
    res.errors.push(`${where} connect "${port}": constant "${net}" must be declared type="const"`);
  }
  if (rewrittenNet != null && kind === "const" && CAPTURE_RE.test(attr(r, "to") ?? "")) {
    res.errors.push(`${where}: aw-rewrite@to is a constant ("${net}") but uses regex captures`);
  }
  const part = evalPart(sub("part"));
  const packed = sub("packed");
  const width = sub("width");
  const unpacked = sub("unpacked");
  const nettype = sub("nettype");
  if (kind === "const") {
    if (part)
      res.errors.push(`${where} connect "${port}": part-select on a constant is not allowed`);
    if (packed ?? width ?? unpacked ?? nettype)
      res.errors.push(`${where} connect "${port}": packed/width/unpacked/nettype do not apply to constants`);
  }
  return {
    to: net,
    packed,
    width,
    unpacked,
    part,
    nettype,
    isConst: kind === "const"
  };
}
function resolveDims(c, portFact, ri, modName, res, where, inheritNetType) {
  const explicitPacked = c.packed && c.packed !== "auto" ? c.packed : null;
  const explicitWidth = c.width && c.width !== "auto" ? c.width : null;
  let packed = explicitPacked ?? explicitWidth ?? null;
  let unpacked = c.unpacked ?? null;
  let nettype = c.nettype ?? null;
  const auto = !packed && !unpacked;
  let preRewritten = false;
  if (auto && portFact) {
    packed = c.portPackedRaw ?? portFact.packed ?? null;
    unpacked = c.portUnpackedRaw ?? portFact.unpacked ?? null;
    preRewritten = c.portPackedRaw !== undefined || c.portUnpackedRaw !== undefined;
    if (inheritNetType && !nettype) {
      const dt = portFact.dataType ?? "";
      nettype = portFact.nettype ?? (/^(logic|reg)\b/.test(dt) ? "logic" : "wire");
    }
  }
  const uniqName = (p) => p.uniq;
  if (packed && !preRewritten)
    packed = rewriteDims(packed, ri.params, uniqName, ri.leafParams, res, where);
  if (unpacked && !preRewritten)
    unpacked = rewriteDims(unpacked, ri.params, uniqName, ri.leafParams, res, where);
  return {
    packed: canonicalDims(packed),
    unpacked: canonicalDims(unpacked),
    nettype
  };
}
function mergeSignal(signals, net, dims, foldVals, res, where) {
  const prev = signals.get(net);
  if (!prev) {
    signals.set(net, { name: net, ...dims });
    return;
  }
  const norm = (t) => foldDims(t ?? "", foldVals);
  if (prev.prevNormPacked === undefined)
    prev.prevNormPacked = norm(prev.packed);
  if (prev.prevNormUnpacked === undefined)
    prev.prevNormUnpacked = norm(prev.unpacked);
  if (prev.prevNormPacked !== norm(dims.packed) || prev.prevNormUnpacked !== norm(dims.unpacked)) {
    res.errors.push(`${where}: net "${net}" dimension conflict ([${prev.packed}][${prev.unpacked}] vs [${dims.packed}][${dims.unpacked}])`);
  }
  if (dims.nettype && prev.nettype && dims.nettype !== prev.nettype) {
    res.errors.push(`${where}: net "${net}" nettype conflict (${prev.nettype} vs ${dims.nettype})`);
  } else if (dims.nettype && !prev.nettype) {
    prev.nettype = dims.nettype;
  }
}
function writeRender(mod, m) {
  let render = child(mod, "aw-render");
  if (!render) {
    render = mod.ownerDocument.createElement("aw-render");
    mod.appendChild(render);
  }
  render.textContent = "";
  if (m.isTb) {
    render.setAttribute("tb", "1");
    const pre = (m.bodyPreInclude ?? []).join(" ");
    const post = (m.bodyPostInclude ?? []).join(" ");
    if (pre)
      render.setAttribute("body-pre-include", pre);
    else
      render.removeAttribute("body-pre-include");
    if (post)
      render.setAttribute("body-post-include", post);
    else
      render.removeAttribute("body-post-include");
  } else {
    render.removeAttribute("tb");
    render.removeAttribute("body-pre-include");
    render.removeAttribute("body-post-include");
  }
  const doc = mod.ownerDocument;
  const mk = (tag, attrs) => {
    const el = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v != null && v !== "")
        el.setAttribute(k, String(v));
    }
    return el;
  };
  const groups = {};
  for (const g of RENDER_GROUPS) {
    const el = doc.createElement(g);
    groups[g] = el;
    render.appendChild(el);
  }
  for (const [n, v] of m.scope.params)
    groups["aw-params"]?.appendChild(mk("aw-param", { name: n, value: v.value }));
  for (const i of m.imports)
    groups["aw-imports"]?.appendChild(mk("aw-import", { package: i.package, symbol: i.symbol }));
  for (const [n, v] of m.scope.localparams) {
    groups["aw-localparams"]?.appendChild(mk("aw-localparam", { name: n, value: v.value }));
  }
  for (const lp of m.uniqLocalparams) {
    groups["aw-localparams"]?.appendChild(mk("aw-localparam", {
      name: lp.name,
      value: lp.value,
      folded: lp.folded ? "true" : "false",
      "for-inst": lp.forInst,
      "for-param": lp.forParam
    }));
  }
  for (const p of m.portsOut) {
    groups["aw-ports"]?.appendChild(mk("aw-port", {
      name: p.name,
      dir: p.dir,
      packed: p.packed,
      unpacked: p.unpacked,
      nettype: p.nettype,
      interface: p.interface,
      modport: p.modport
    }));
  }
  for (const s of m.signals.values()) {
    groups["aw-signals"]?.appendChild(mk("aw-signal", {
      name: s.name,
      packed: s.packed,
      unpacked: s.unpacked,
      nettype: s.nettype
    }));
  }
  for (const ri of m.renderInsts) {
    const el = mk("aw-inst", { id: ri.id, mod: ri.mod });
    for (const [pname, p] of ri.params)
      el.appendChild(mk("aw-param", { name: pname, value: p.renderValue }));
    const orderIdx = new Map(ri.order.map((n, i) => [n, i]));
    const sorted = [...ri.connects.entries()].sort((a, b) => (orderIdx.get(a[0]) ?? 1e9) - (orderIdx.get(b[0]) ?? 1e9));
    for (const [port, c] of sorted) {
      const portAttrs = {
        dir: c.dir,
        "port-packed": c.portPacked,
        "port-unpacked": c.portUnpacked
      };
      el.appendChild(c.open ? mk("aw-connect", { port, type: "open", ...portAttrs }) : c.isRaw ? mk("aw-connect", { port, to: c.to, type: "raw", ...portAttrs }) : mk("aw-connect", { port, to: c.to, part: c.part, ...portAttrs }));
    }
    groups["aw-insts"]?.appendChild(el);
  }
}
var SNAPSHOT_ATTR_ORDER = null;
function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function serializeEl(el, indent, out) {
  const tag = (el.tagName ?? "").toLowerCase();
  const attrs = [];
  for (const a of el.attributes ?? []) {
    if (a.name === "aria-label")
      continue;
    attrs.push([a.name, a.value]);
  }
  attrs.sort((x, y) => x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0);
  const pad = "  ".repeat(indent);
  const kids = [...el.children ?? []];
  const attrText = attrs.map(([k, v]) => `${k}="${escapeXml(v)}"`).join(" ");
  if (kids.length === 0) {
    out.push(`${pad}<${tag}${attrText ? ` ${attrText}` : ""}></${tag}>`);
    return;
  }
  out.push(`${pad}<${tag}${attrText ? ` ${attrText}` : ""}>`);
  for (const k of kids)
    serializeEl(k, indent + 1, out);
  out.push(`${pad}</${tag}>`);
}
function serializeModSnapshot(mod, indent, out) {
  const pad = "  ".repeat(indent);
  const name = escapeXml(attr(mod, "name") ?? "");
  const tag = isTbMod(mod) ? "aw-tb-mod" : "aw-mod";
  const extras = [];
  if (isTbMod(mod)) {
    const pre = attr(mod, "body-pre-include");
    const post = attr(mod, "body-post-include");
    const render0 = child(mod, "aw-render");
    const preR = render0 ? attr(render0, "body-pre-include") : null;
    const postR = render0 ? attr(render0, "body-post-include") : null;
    const preV = preR ?? pre;
    const postV = postR ?? post;
    if (preV)
      extras.push(`body-pre-include="${escapeXml(preV)}"`);
    if (postV)
      extras.push(`body-post-include="${escapeXml(postV)}"`);
  }
  out.push(`${pad}<${tag} name="${name}"${extras.length ? ` ${extras.join(" ")}` : ""}>`);
  const render = child(mod, "aw-render");
  if (render)
    serializeEl(render, indent + 1, out);
  const submods = child(mod, "aw-submods");
  for (const sm of submods ? children(submods, "aw-mod") : [])
    serializeModSnapshot(sm, indent + 1, out);
  out.push(`${pad}</${tag}>`);
}
function serializeSnapshot(doc) {
  const out = [];
  const root = all(doc, "autowire").filter((e) => !e.closest("aw-mod") && !e.closest("aw-tb-mod"))[0];
  if (!root)
    return "";
  out.push("<autowire>");
  for (const mod of topMods(root))
    serializeModSnapshot(mod, 1, out);
  out.push("</autowire>");
  return out.join(`
`);
}
var AW_TAGS = [
  "aw-mod",
  "aw-tb-mod",
  "aw-content",
  "aw-submods",
  "aw-render",
  ...CONTENT_GROUPS,
  "aw-import",
  "aw-param",
  "aw-localparam",
  "aw-port",
  "aw-template",
  "aw-inst",
  "aw-connect",
  "aw-rewrite",
  "aw-signals",
  "aw-signal"
];
function installGlobal(win) {
  if (win.customElements) {
    for (const tag of AW_TAGS) {
      if (!win.customElements.get(tag)) {
        const cls = class extends win.HTMLElement {
          connectedCallback() {
            const label = this.getAttribute("name") ?? this.getAttribute("id") ?? this.getAttribute("port");
            if (label && !this.getAttribute("aria-label"))
              this.setAttribute("aria-label", `${tag} ${label}`);
          }
        };
        win.customElements.define(tag, cls);
      }
    }
  }
  win.aw = {
    check,
    elaborate,
    serializeSnapshot,
    isFrozen,
    inst,
    connect,
    rewrite,
    param,
    port,
    localparam
  };
  return win.aw;
}
export {
  check,
  connect,
  elaborate,
  inst,
  installGlobal,
  isFrozen,
  localparam,
  param,
  port,
  rewrite,
  serializeSnapshot
};
