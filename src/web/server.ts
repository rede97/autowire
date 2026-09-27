// `autowire connect web` — static page and read-only data (127.0.0.1 only).
// The session does not write the workspace. connect run writes .sv.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
// Browser assets embedded as text: same source in dev (`bun index.ts`) and in
// the compiled binary (`bun build --compile`); web/aw.js is the built bundle.
// @ts-expect-error Bun text import (typed via src/assets.d.ts for editors that resolve it)
import awBundle from "../../web/aw.js" with { type: "text" };
// @ts-expect-error Bun text import
import pageJs from "../../web/page.js" with { type: "text" };
import { connectDir, topoUnits } from "../core/connect.ts";
import { LeafDb } from "../rtl/leaf.ts";
import { loadRtlIndex } from "../rtl/rtlindex.ts";
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
				paramInline: ws.styleParamInline,
				localparamUpper: ws.styleLocalparamUpper,
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
		if (!existsSync(join(ws.indexDir, "index.xml"))) {
			return json(
				{
					error: `no RtlIndex at ${ws.indexDir} (run autowire analysis first)`,
				},
				404,
			);
		}
		const index = await loadRtlIndex(ws.indexDir);
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
	if (req.method === "GET" && path === "/api/module") {
		const name = url.searchParams.get("name") ?? "";
		const leaf = await leafDb.get(name);
		if (!leaf) return json({ error: `unknown module "${name}"` }, 404);
		return json(leaf);
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

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>autowire web</title>
<style>
  :root { color-scheme: light dark; font-family: ui-monospace, monospace; }
  body { margin: 0; display: grid; grid-template-rows: auto 1fr auto; height: 100vh; }
  header { display: flex; gap: .6em; align-items: center; padding: .4em .8em; border-bottom: 1px solid #8885; }
  header h1 { font-size: 1em; margin: 0; }
  header button { font: inherit; padding: .15em .8em; }
  #aw-status { margin-left: auto; padding: .1em .6em; border: 1px solid #8885; border-radius: 4px; }
  #aw-status[data-state="done"] { border-color: #4a4; color: #4a4; }
  #aw-status[data-state="error"] { border-color: #c44; color: #c44; }
  #aw-status[data-state="running"] { border-color: #cb4; color: #cb4; }
  main { display: grid; grid-template-columns: minmax(16em, 1fr) 2fr; min-height: 0; }
  #left { border-right: 1px solid #8885; overflow: auto; padding: .4em .8em; }
  #right { overflow: auto; padding: .4em .8em; }
  #connect-live { border-top: 1px solid #8885; overflow: auto; max-height: 34vh; padding: .2em .8em; }
  details { margin-left: .6em; }
  .mod-node { cursor: pointer; }
  .mod-node:hover { text-decoration: underline; }
  .blackbox { color: #b80; }
  table { border-collapse: collapse; }
  td, th { border: 1px solid #8885; padding: .1em .5em; text-align: left; }
  autowire, aw-mod, aw-tb-mod, aw-content, aw-submods, aw-render, aw-imports, aw-params, aw-localparams,
  aw-ports, aw-templates, aw-insts, aw-signals { display: block; margin-left: 1em; border-left: 1px dotted #8885; padding-left: .6em; }
  aw-mod::before { content: "aw-mod " attr(name); color: #57c; }
  aw-tb-mod::before { content: "aw-tb-mod " attr(name); color: #57c; }
  aw-render::before { content: "aw-render"; color: #4a4; }
  aw-content::before { content: "aw-content"; color: #b80; }
  aw-inst, aw-connect, aw-signal, aw-port, aw-param, aw-localparam, aw-import, aw-template, aw-rewrite { display: block; }
  aw-inst::before { content: "inst " attr(id) " : " attr(mod); color: #888; }
  aw-connect::before { content: "." attr(port) " → " attr(to); }
  aw-signal::before { content: "net " attr(name); }
  aw-port::before { content: attr(dir) " " attr(name); }
  aw-param::before { content: "param " attr(name); }
  aw-localparam::before { content: "localparam " attr(name); }
</style>
</head>
<body>
<header>
  <h1>autowire</h1>
  <span id="ws-name"></span>
  <select id="unit-select" aria-label="connect unit"></select>
  <button id="btn-check" type="button">Check</button>
  <button id="btn-elaborate" type="button">Elaborate</button>
  <button id="btn-run" type="button">Run</button>
  <button id="btn-save" type="button" title="Download #aw-generated in the browser. Does not write the workspace.">Save</button>
  <button id="btn-reset" type="button">Reset</button>
  <span id="aw-status" data-state="idle" role="status">idle</span>
</header>
<main>
  <section id="left" aria-label="dependency tree and database summary">
    <h2>RtlIndex</h2>
    <div id="db-summary"></div>
    <div id="dep-tree"></div>
  </section>
  <section id="right" aria-label="selected module">
    <h2 id="right-title">(no module selected)</h2>
    <div id="right-body"></div>
  </section>
</main>
<section id="connect-live" aria-label="live connect DOM">
  <h2>connect DOM (live)</h2>
  <div id="aw-live"></div>
</section>
<pre id="aw-generated" aria-label="generated source"></pre>
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
	const leafDb = new LeafDb(ws.indexDir);
	const state: WebState = { ws, leafDb, defaultUnit };
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
				return new Response(PAGE_HTML, {
					headers: { "content-type": "text/html; charset=utf-8" },
				});
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
