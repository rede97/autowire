// `autowire connect web` — static page and read-only data (127.0.0.1 only).
// The session does not write the workspace. connect run writes .sv.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
// Browser assets embedded as text: same source in dev (`bun index.ts`) and in
// the compiled binary (`bun build --compile`). out/web is build:web output.
// @ts-expect-error Bun text import (typed via src/assets.d.ts for editors that resolve it)
import awBundle from "../../out/web/aw.js" with { type: "text" };
// @ts-expect-error Bun text import
import pageJs from "../../out/web/page.js" with { type: "text" };
import { connectDir, topoUnits } from "../core/connect.ts";
import { LeafDb } from "../rtl/leaf.ts";
import { indexFileName, loadRtlIndex } from "../rtl/rtlindex.ts";
import { allUnits, findUnit, type WorkspaceConfig } from "../workspace.ts";

const UNIT_ID = /^[A-Za-z0-9_-]+$/;

interface WebState {
	ws: WorkspaceConfig;
	leafDb: LeafDb;
	defaultUnit: string | null;
}

function json(data: unknown, status = 200): Response {
	return Response.json(data, { status });
}

class HttpError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

/** Loopback-only, same-origin guard: a foreign Host (DNS rebinding) or a
 *  cross-site Origin means another page in the user's browser is calling. */
function originGuard(req: Request, port: number | undefined): string | null {
	const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
	const host = req.headers.get("host") ?? "";
	if (!hosts.includes(host)) return `refused: unexpected Host "${host}"`;
	const origin = req.headers.get("origin");
	if (origin !== null && !hosts.some((h) => origin === `http://${h}`))
		return `refused: cross-origin request from "${origin}"`;
	return null;
}

async function handleApi(
	state: WebState,
	url: URL,
	req: Request,
): Promise<Response> {
	const { ws, leafDb } = state;
	const path = url.pathname;
	if (req.method === "GET" && path === "/api/units") {
		const units = topoUnits(allUnits(ws));
		return json({
			workspace: ws.root,
			style: {
				// engine param folding
				paramInline: ws.styleParamInline,
				localparamUpper: ws.styleLocalparamUpper,
				netType: ws.styleNetType,
				// printSv style (same text as connect run)
				portAlign: ws.stylePortAlign,
				paramAlign: ws.styleParamAlign,
				instPortAlign: ws.styleInstPortAlign,
				instParamAlign: ws.styleInstParamAlign,
				instPortDir: ws.styleInstPortDir,
				instPortDirFormat: ws.styleInstPortDirFormat,
				instPortWidth: ws.styleInstPortWidth,
				signalAlign: ws.styleSignalAlign,
			},
			units: units.map((u) => ({
				id: u.id,
				html: u.html,
				deps: u.deps,
				kind: u.kind,
			})),
			defaultUnit: state.defaultUnit,
		});
	}
	if (req.method === "GET" && path === "/api/rtlindex") {
		if (!existsSync(join(ws.indexDir, indexFileName(ws.indexFormat)))) {
			return json(
				{
					error: `no RtlIndex at ${ws.indexDir} (run autowire analysis first)`,
				},
				404,
			);
		}
		const index = await loadRtlIndex(ws.indexDir, ws.indexFormat);
		return json({
			tool: index.tool,
			generated: index.generated,
			definesFp: index.definesFp,
			files: index.files.length,
			modules: index.moduleSource.size,
			errorFiles: index.errorFiles.map((f) => f.source),
			hierarchy: index.tops,
		});
	}
	if (req.method === "GET" && path === "/api/modules") {
		const index = await loadRtlIndex(ws.indexDir, ws.indexFormat);
		return json({
			modules: [...index.moduleSource.entries()].map(([name, source]) => ({
				name,
				source,
				kind: "module",
			})),
			packages: [...index.packageSource.entries()].map(([name, source]) => ({
				name,
				source,
				kind: "package",
			})),
		});
	}
	if (req.method === "GET" && path === "/api/module") {
		const name = url.searchParams.get("name") ?? "";
		const leaf = await leafDb.get(name);
		if (!leaf) return json({ error: `unknown module "${name}"` }, 404);
		return json(leaf);
	}
	if (req.method === "GET" && path === "/api/leaves") {
		try {
			return json({ modules: await leafDb.all() });
		} catch (error) {
			if (
				error instanceof Error &&
				"code" in error &&
				(error as NodeJS.ErrnoException).code === "ENOENT"
			)
				return json({ error: "no RtlIndex" }, 404);
			throw error;
		}
	}
	if (req.method === "GET" && path === "/api/author") {
		const id = url.searchParams.get("id") ?? "";
		const unit = findUnit(ws, id);
		if (!unit) return json({ error: `unknown unit "${id}"` }, 404);
		if (!existsSync(unit.html))
			return json({ error: `author HTML not found: ${unit.html}` }, 404);
		return new Response(await readFile(unit.html, "utf8"), {
			headers: { "content-type": "text/html; charset=utf-8" },
		});
	}
	if (req.method === "GET" && path === "/api/connect") {
		const id = url.searchParams.get("id") ?? "";
		if (!UNIT_ID.test(id)) return json({ error: "bad unit id" }, 400);
		const file = join(connectDir(ws), `${id}.xml`);
		if (!existsSync(file)) {
			return json(
				{ error: `no snapshot for unit "${id}" (connect run writes it)` },
				404,
			);
		}
		return new Response(await readFile(file, "utf8"), {
			headers: { "content-type": "application/xml; charset=utf-8" },
		});
	}
	return json({ error: `no route ${req.method} ${path}` }, 404);
}

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>autowire — units</title>
<style>
  :root { color-scheme: light dark; font-family: Consolas, "Cascadia Mono", "SF Mono", Menlo, "DejaVu Sans Mono", ui-monospace, monospace; }
  body { margin: 2em auto; max-width: 44em; padding: 0 1em; }
  h1 { font-size: 1.2em; }
  li { margin: .3em 0; }
  .kind { color: #888; margin-left: .6em; }
</style>
</head>
<body>
<h1>autowire — <span id="ws"></span></h1>
<ul id="units"></ul>
<script>
  // Classic script: obscura rejects inline type=module (it becomes a data: URL).
  fetch("/api/units").then((r) => r.json()).then((meta) => {
    document.querySelector("#ws").textContent = meta.workspace.split("/").pop() ?? "";
    const ul = document.querySelector("#units");
    for (const u of meta.units) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = "/?unit=" + encodeURIComponent(u.id);
      a.textContent = u.id;
      li.appendChild(a);
      const k = document.createElement("span");
      k.className = "kind";
      k.textContent = u.kind ?? "connect";
      li.appendChild(k);
      ul.appendChild(li);
    }
  });
</script>
</body>
</html>
`;

const PAGE_HTML = `<!doctype html>
<html lang="en" data-ui="page">
<head>
<meta charset="utf-8" />
<title>autowire web</title>
<style>
  :root { color-scheme: light dark; font-family: Consolas, "Cascadia Mono", "SF Mono", Menlo, "DejaVu Sans Mono", ui-monospace, monospace; }
  body { margin: 0; display: grid; grid-template-rows: auto 1fr; height: 100vh; }
  header { display: flex; gap: .6em; align-items: center; padding: .4em .8em; border-bottom: 1px solid #8885; }
  header h1 { font-size: 1em; margin: 0; }
  header button { font: inherit; padding: .15em .8em; border: 1px solid #8885; border-radius: 4px; background: none; color: inherit; }
  header a { color: inherit; }
  /* Per-action status shows on the buttons themselves (docs/workspace/web-ui.md §1/§4). */
  #btn-check[data-state="done"], #btn-elaborate[data-state="done"], #btn-run[data-state="done"] { border-color: #4a4; color: #4a4; }
  #btn-check[data-state="error"], #btn-elaborate[data-state="error"], #btn-run[data-state="error"] { border-color: #c44; color: #c44; }
  #btn-check[data-state="running"], #btn-elaborate[data-state="running"], #btn-run[data-state="running"] { border-color: #cb4; color: #cb4; }
  /* Machine sync signal: kept in the DOM for Playwright, hidden from view. */
  #aw-status { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); margin: -1px; padding: 0; border: 0; }
  #layout { display: grid; grid-template-columns: minmax(14em, 18em) 1fr; min-height: 0; }
  #sidebar { border-right: 1px solid #8885; display: grid; grid-template-rows: auto 1fr; min-height: 0; }
  #side-tabs { display: flex; border-bottom: 1px solid #8885; }
  #side-tabs button { flex: 1; font: inherit; border: 0; background: none; padding: .4em; cursor: pointer; }
  #side-tabs button[aria-selected="true"] { box-shadow: inset 0 -2px #57c; }
  #author-tabs { border-bottom: 1px solid #8885; }
  #author-tabs button { font: inherit; border: 0; background: none; padding: .3em .8em; cursor: pointer; }
  #author-tabs button[aria-selected="true"] { box-shadow: inset 0 -2px #57c; }
  #col-author { display: grid; grid-template-rows: auto minmax(0, 1fr); min-height: 0; }
  #author-source, #author-processed, #author-rtl { overflow: auto; min-height: 0; }
  /* The real aw-* trees stay in the DOM for the engine and Playwright, but the
     page never paints them. A sibling view tree is the only thing on screen. */
  #aw-source, #aw-live { display: none; }
  #aw-source-view, #aw-live-view, #aw-rtl { font-family: inherit; padding: .3em .5em; line-height: 1.45; }
  /* Elements-panel look: one tag per line, tag / attribute / value in three
     colors, a disclosure triangle only on nodes that really have children. */
  .aw-tree details { margin-left: 1em; }
  .aw-tree > details { margin-left: 0; }
  .aw-tree summary { cursor: pointer; list-style: none; white-space: nowrap; }
  .aw-tree summary::-webkit-details-marker { display: none; }
  .aw-tree summary::before { content: "\\25b8"; display: inline-block; width: 1em; margin-left: -1em; color: #888; text-align: center; }
  .aw-tree details[open] > summary::before { content: "\\25be"; }
  .aw-tree summary:hover, .aw-tree .leaf:hover { background: #8882; }
  .aw-tree .leaf { margin-left: 1em; white-space: nowrap; }
  .aw-tree .tg { color: #881280; }
  .aw-tree .an { color: #994500; }
  .aw-tree .av { color: #1a1aa6; }
  .aw-tree .punct { color: #888; }
  .aw-tree .close { color: #888; }
  .aw-tree details:not([open]) > summary .close { display: none; }
  .aw-tree details:not([open]) > summary .ellipsis { display: inline; }
  .aw-tree .ellipsis { display: none; color: #888; }
  .aw-tree .script-body { display: block; white-space: pre; color: #6a7; border-left: 2px solid #8885; margin: 0 0 .1em 1em; padding: 0 .4em; }
  /* Template rules keep their type / content / target columns. */
  .aw-tree .rules { display: grid; grid-template-columns: max-content minmax(6em, 1.2fr) minmax(6em, 1.4fr) max-content; column-gap: .9em; align-items: baseline; }
  .aw-tree .rules > .leaf { display: contents; }
  .aw-tree .rules .col { white-space: pre; overflow: hidden; text-overflow: ellipsis; }
  .aw-tree .rules .col:nth-child(1) { color: #881280; }
  .aw-tree .rules .col:nth-child(2) { color: #994500; }
  .aw-tree .rules .col:nth-child(3) { color: #1a1aa6; }
  .aw-tree .rules .col:nth-child(4) { color: #888; }
  .aw-tree .err > summary, .aw-tree .leaf.err { outline: 1px solid #c44; background: #c442; }
  .aw-tree .rtl-title { color: #881280; margin: .2em 0 .4em; }
  @media (prefers-color-scheme: dark) {
    .aw-tree .tg { color: #5db0d7; }
    .aw-tree .an { color: #9bbbdc; }
    .aw-tree .av { color: #f29766; }
    .aw-tree .rules .col:nth-child(1) { color: #5db0d7; }
    .aw-tree .rules .col:nth-child(2) { color: #9bbbdc; }
    .aw-tree .rules .col:nth-child(3) { color: #f29766; }
    .aw-tree .rtl-title { color: #5db0d7; }
  }
  .pane { overflow: auto; padding: .4em .6em; min-height: 0; }
  #rtl-search { width: 100%; box-sizing: border-box; font: inherit; margin: .2em 0 .4em; }
  #rtl-list div { display: block; padding: .1em .3em; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #rtl-list div:hover { text-decoration: underline; }
  #rtl-list .pkg { color: #b80; }
  #unit-list a { display: block; padding: .1em .3em; color: inherit; text-decoration: none; }
  #unit-list a[aria-current="true"] { background: #57c3; }
  #unit-list .kind { color: #888; }
  table { border-collapse: collapse; }
  td, th { border: 1px solid #8885; padding: .1em .5em; text-align: left; }
  #content { min-height: 0; overflow: auto; }
  #unit-view { display: grid; grid-template-columns: minmax(20em, 1fr) 1fr; height: 100%; }
  #col-author { border-right: 1px solid #8885; overflow: auto; padding: .4em .8em; }
  #col-result { overflow: auto; padding: .4em .8em; display: grid; grid-template-rows: auto 1fr; }
  #result-tabs { border-bottom: 1px solid #8885; margin-bottom: .4em; }
  #result-tabs button { font: inherit; border: 0; background: none; padding: .3em .8em; cursor: pointer; }
  #result-tabs button[aria-selected="true"] { box-shadow: inset 0 -2px #57c; }
  #error-list { color: #c44; white-space: pre-wrap; }
  #aw-generated { margin: 0; white-space: pre; }
  .sv-kw { color: #07c; } .sv-cmt { color: #6a7; font-style: italic; }
  .sv-num { color: #a4a; } .sv-str { color: #a40; } .sv-dir { color: #b6b; }
  .xml-tag { color: #07c; } .xml-attr { color: #a40; } .xml-cmt { color: #6a7; font-style: italic; }
</style>
</head>
<body>
<header>
  <h1><a href="/">autowire</a></h1>
  <span id="ws-name"></span>
  <strong id="unit-name"></strong>
  <button id="btn-check" type="button">Check</button>
  <button id="btn-elaborate" type="button">Elaborate</button>
  <button id="btn-run" type="button">Run</button>
  <button id="btn-save-sv" type="button" title="Download the printed .sv text. Does not write the workspace.">Save SV</button>
  <button id="btn-save-html" type="button" title="Download the live author HTML with aw-render stripped. Does not write the workspace.">Save HTML</button>
  <button id="btn-reset" type="button">Reset</button>
  <span id="aw-status" data-state="idle" role="status">idle</span>
</header>
<div id="layout">
  <aside id="sidebar">
    <nav id="side-tabs">
      <button id="tab-rtl" type="button" aria-selected="false">RtlIndex</button>
      <button id="tab-connect" type="button" aria-selected="true">Connect</button>
    </nav>
    <div id="pane-rtlindex" class="pane" aria-label="RtlIndex modules" hidden>
      <div id="db-summary"></div>
      <input id="rtl-search" type="search" placeholder="filter modules…" aria-label="filter modules" />
      <div id="rtl-list"></div>
    </div>
    <div id="pane-connect" class="pane" aria-label="connect targets">
      <div id="unit-list"></div>
    </div>
  </aside>
  <main id="content">
    <section id="unit-view">
      <div id="col-author" aria-label="author workspaces">
        <nav id="author-tabs">
          <button id="atab-source" type="button" aria-selected="true">Source</button>
          <button id="atab-proc" type="button" aria-selected="false">Processed</button>
          <button id="atab-rtl" type="button" aria-selected="false">RtlIndex</button>
        </nav>
        <div id="author-source">
          <div id="aw-source" aria-label="unmodified author HTML"></div>
          <div id="aw-source-view" class="aw-tree" aria-label="source tree"></div>
        </div>
        <div id="author-processed" hidden>
          <div id="aw-live" aria-label="post-script author HTML"></div>
          <div id="aw-live-view" class="aw-tree" aria-label="processed tree"></div>
        </div>
        <div id="author-rtl" hidden>
          <div id="aw-rtl" aria-label="RtlIndex module detail"></div>
        </div>
      </div>
      <div id="col-result" aria-label="errors and generated source">
        <nav id="result-tabs" hidden>
          <button id="rtab-render" type="button" aria-selected="false">Rendered</button>
          <button id="rtab-sv" type="button" aria-selected="true">SystemVerilog</button>
        </nav>
        <div id="error-list" hidden></div>
        <pre id="aw-generated" aria-label="generated source"></pre>
      </div>
    </section>
  </main>
</div>
<script type="module" src="/page.js"></script>
</body>
</html>
`;

const MIN_HTML = `<!doctype html>
<html lang="en" data-ui="min">
<head>
<meta charset="utf-8" />
<title>autowire web</title>
<style>
  :root { color-scheme: light dark; font-family: Consolas, "Cascadia Mono", "SF Mono", Menlo, "DejaVu Sans Mono", ui-monospace, monospace; }
  body { margin: 0; font-family: inherit; }
  header { padding: .4em .8em; border-bottom: 1px solid #8885; }
  header button, header span, header strong { display: inline-block; margin: .15em .3em; font: inherit; }
  #aw-source, #aw-live, #db-summary, #right-body, #aw-generated { display: block; clear: both; }
  #aw-status[data-state="done"] { color: #4a4; }
  #aw-status[data-state="error"] { color: #c44; }
  #aw-status[data-state="running"] { color: #cb4; }
  #error-list { color: #c44; white-space: pre-wrap; }
  #aw-generated { white-space: pre; }
  script[type="aw/hook"] { display: block; white-space: pre-wrap; }
  h2 { font-size: 1em; margin: .6em .8em .2em; }
  table { border-collapse: collapse; }
  td, th { border: 1px solid #8885; padding: .1em .5em; text-align: left; }
</style>
</head>
<body>
<header>
  <span id="ws-name"></span>
  <strong id="unit-name"></strong>
  <button id="btn-check" type="button">Check</button>
  <button id="btn-elaborate" type="button">Elaborate</button>
  <button id="btn-run" type="button">Run</button>
  <button id="btn-save-sv" type="button" title="Download the printed .sv text. Does not write the workspace.">Save SV</button>
  <button id="btn-save-html" type="button" title="Download the live author HTML with aw-render stripped. Does not write the workspace.">Save HTML</button>
  <button id="btn-reset" type="button">Reset</button>
  <span id="aw-status" data-state="idle" role="status">idle</span>
</header>
<div id="db-summary"></div>
<h2 id="right-title">(no module selected)</h2>
<div id="right-body"></div>
<div id="error-list" hidden></div>
<pre id="aw-generated" aria-label="generated source"></pre>
<h2>source</h2>
<div id="aw-source" aria-label="unmodified author HTML"></div>
<h2>processed</h2>
<div id="aw-live" aria-label="post-script author HTML"></div>
<script type="module" src="/page.js"></script>
</body>
</html>
`;

/** Start the web server; returns the bound URL. The process stays alive serving. */
export async function startWeb(
	ws: WorkspaceConfig,
	port: number,
	defaultUnit: string | null,
): Promise<string> {
	const leafDb = new LeafDb(ws.indexDir, ws.indexFormat);
	const state: WebState = {
		ws,
		leafDb,
		defaultUnit,
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		async fetch(req, srv) {
			const url = new URL(req.url);
			const refused = originGuard(req, srv.port);
			if (refused) return json({ error: refused }, 403);
			try {
				if (url.pathname.startsWith("/api/"))
					return await handleApi(state, url, req);
				if (req.method !== "GET")
					return json({ error: "method not allowed" }, 405);
				if (url.pathname === "/aw.js") {
					return new Response(awBundle, {
						headers: { "content-type": "text/javascript; charset=utf-8" },
					});
				}
				if (url.pathname === "/page.js") {
					return new Response(pageJs, {
						headers: { "content-type": "text/javascript; charset=utf-8" },
					});
				}
				if (url.pathname.startsWith("/raw/")) {
					const rel = decodeURIComponent(url.pathname.slice("/raw/".length));
					const root = resolve(ws.root);
					const abs = resolve(root, rel);
					if (abs !== root && !abs.startsWith(root + sep))
						return json({ error: "path escapes the workspace" }, 403);
					if (!existsSync(abs)) return json({ error: "not found" }, 404);
					return new Response(Bun.file(abs));
				}
				if (url.pathname === "/") {
					const minimal = url.searchParams.get("ui") === "min";
					const html = minimal
						? MIN_HTML
						: url.searchParams.has("unit")
							? PAGE_HTML
							: INDEX_HTML;
					return new Response(html, {
						headers: { "content-type": "text/html; charset=utf-8" },
					});
				}
				return json({ error: `no route GET ${url.pathname}` }, 404);
			} catch (e) {
				return json(
					{ error: (e as Error).message },
					e instanceof HttpError ? e.status : 500,
				);
			}
		},
	});
	return `http://127.0.0.1:${server.port}/`;
}
