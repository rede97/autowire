// `autowire web [unit|html]` — local page server (127.0.0.1 only).
// Contract: docs/web-ui.md (layout, GET actions, #aw-status), docs/workspace-toml.md §4.2.
// The browser never touches the workspace: RtlIndex via /api/rtlindex + /api/module,
// dep snapshots via /api/connect, the only write path is POST /api/dump.

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check as awCheck } from "../web/aw.ts";
import {
	buildEngineCtx,
	connectDir,
	loadUnitDoc,
	topoUnits,
} from "./connect.ts";
import { LeafDb } from "./leaf.ts";
import { assertPrintable, parseSnapshot, writeSvFiles } from "./printer.ts";
import { loadRtlIndex } from "./rtlindex.ts";
import type { WorkspaceConfig } from "./workspace.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const UNIT_ID = /^[A-Za-z0-9_-]+$/;

interface WebState {
	ws: WorkspaceConfig;
	leafDb: LeafDb;
	defaultUnit: string | null;
}

function json(data: unknown, status = 200): Response {
	return Response.json(data, { status });
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
	try {
		const body: unknown = await req.json();
		if (typeof body === "object" && body !== null)
			return body as Record<string, unknown>;
	} catch {
		// fall through
	}
	throw new Error("bad request: expected JSON object body");
}

async function handleApi(
	state: WebState,
	url: URL,
	req: Request,
): Promise<Response> {
	const { ws, leafDb } = state;
	const path = url.pathname;
	if (req.method === "GET" && path === "/api/units") {
		const units = topoUnits(ws.connectUnits);
		return json({
			workspace: ws.root,
			units: units.map((u) => ({ id: u.id, html: u.html, deps: u.deps })),
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
		const unit = ws.connectUnits.find((u) => u.id === id);
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
		const file = join(connectDir(ws), `${id}.html`);
		if (!existsSync(file)) {
			return json(
				{ error: `no snapshot for unit "${id}" (render/dump it first)` },
				404,
			);
		}
		return new Response(await readFile(file, "utf8"), {
			headers: { "content-type": "text/html; charset=utf-8" },
		});
	}
	if (req.method === "POST" && path === "/api/check") {
		const body = await readBody(req);
		const id = typeof body.id === "string" ? body.id : "";
		const unit = ws.connectUnits.find((u) => u.id === id);
		if (!unit) return json({ error: `unknown unit "${id}"` }, 404);
		const { doc } = await loadUnitDoc(ws, unit);
		const built = await buildEngineCtx(ws, unit, ws.connectUnits, leafDb);
		await built.prewarm(doc);
		const res = awCheck(doc as never, built.ctx);
		return json({
			errors: [...built.errors, ...res.errors],
			warnings: res.warnings,
		});
	}
	if (req.method === "POST" && path === "/api/dump") {
		const body = await readBody(req);
		const id = typeof body.id === "string" ? body.id : "";
		const html = typeof body.html === "string" ? body.html : "";
		if (!UNIT_ID.test(id)) return json({ error: "bad unit id" }, 400);
		const unit = ws.connectUnits.find((u) => u.id === id);
		if (!unit) return json({ error: `unknown unit "${id}"` }, 404);
		try {
			assertPrintable(html);
		} catch (e) {
			return json({ error: (e as Error).message }, 422);
		}
		const mods = parseSnapshot(html);
		if (mods.length === 0)
			return json({ error: "snapshot has no aw-mod" }, 422);
		await mkdir(connectDir(ws), { recursive: true });
		await writeFile(join(connectDir(ws), `${id}.html`), `${html}\n`, "utf8");
		const files = await writeSvFiles(mods, resolve(ws.root, ws.dumpDir), id);
		return json({ files, mods: mods.map((m) => m.name) });
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
  autowire, aw-mod, aw-content, aw-submods, aw-render, aw-imports, aw-params, aw-localparams,
  aw-ports, aw-templates, aw-insts, aw-signals { display: block; margin-left: 1em; border-left: 1px dotted #8885; padding-left: .6em; }
  aw-mod::before { content: "aw-mod " attr(name); color: #57c; }
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
  <button id="btn-render" type="button">Render</button>
  <button id="btn-dump" type="button">Dump</button>
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
	const awJs = await readFile(join(HERE, "../web/aw.js"), "utf8");
	const pageJs = await readFile(join(HERE, "../web/page.js"), "utf8");
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		async fetch(req) {
			const url = new URL(req.url);
			try {
				if (url.pathname.startsWith("/api/"))
					return await handleApi(state, url, req);
				if (req.method !== "GET")
					return json({ error: "method not allowed" }, 405);
				if (url.pathname === "/aw.js") {
					return new Response(awJs, {
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
				return json({ error: (e as Error).message }, 500);
			}
		},
	});
	return `http://127.0.0.1:${server.port}/`;
}
