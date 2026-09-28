import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBrowser } from "../scripts/cdp-helper.ts";
import { check } from "../src/core/aw.ts";
import { loadLiveUnitDoc, renderUnit } from "../src/core/happydom.ts";
import { LeafDb } from "../src/rtl/leaf.ts";
import { loadWorkspace } from "../src/workspace.ts";

const SCRIPT = `function buildProbe(content) {
  aw.port(content, { name: "probe", dir: "output" });
}
`;

const HTML = `<!doctype html>
<html><body>
<script>
${SCRIPT}</script>
<autowire>
  <aw-mod name="leaf">
    <aw-content on-init="buildProbe">
      <aw-ports>
        <aw-port name="clk" dir="input"></aw-port>
      </aw-ports>
      <aw-insts></aw-insts>
    </aw-content>
    <aw-submods></aw-submods>
    <aw-render></aw-render>
  </aw-mod>
</autowire>
</body></html>
`;

async function workspace(): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "aw-happy-"));
	writeFileSync(
		join(dir, "autowire.toml"),
		`
[workspace]
name = "test"
[workspace.dump]
connect_dir = "out/connect"
sim_dir = "out/sim"
[analysis.index]
dir = ".autowire/hdxml"
[connect.leaf]
html = "leaf.html"
`,
	);
	writeFileSync(join(dir, "leaf.html"), HTML);
	return dir;
}

describe("happy-dom render", () => {
	test("classic script on-init mutates the author face during elaborate", async () => {
		const dir = await workspace();
		const ws = await loadWorkspace(join(dir, "autowire.toml"));
		const unit = ws.connectUnits[0];
		if (!unit) throw new Error("fixture unit missing");
		const rendered = await renderUnit(
			ws,
			unit,
			new LeafDb(ws.indexDir),
			new Map(),
		);
		expect(rendered.snapshot).toContain('name="probe"');
		expect(rendered.snapshot).toContain('dir="output"');
		expect(rendered.files.some((file) => file.endsWith("leaf.sv"))).toBe(true);
	});

	test("check does not run scripts", async () => {
		const dir = mkdtempSync(join(tmpdir(), "aw-happy-"));
		writeFileSync(
			join(dir, "autowire.toml"),
			`
[workspace]
name = "test"
[workspace.dump]
connect_dir = "out/connect"
sim_dir = "out/sim"
[analysis.index]
dir = ".autowire/hdxml"
[connect.leaf]
html = "leaf.html"
`,
		);
		writeFileSync(
			join(dir, "leaf.html"),
			HTML.replace("<script>", "<script>\nthrow new Error('script boom');\n"),
		);
		const ws = await loadWorkspace(join(dir, "autowire.toml"));
		const unit = ws.connectUnits[0];
		if (!unit) throw new Error("fixture unit missing");
		const { win, doc } = await loadLiveUnitDoc(ws, unit, { scripts: false });
		try {
			const res = check(doc as never, {});
			expect(res.errors).toEqual([]);
		} finally {
			await win.happyDOM.close();
		}
	});

	test("same HTML snapshot as the CDP browser", async () => {
		const { browser, close } = await launchBrowser();
		const host = Bun.serve({
			port: 0,
			fetch(req) {
				const p = new URL(req.url).pathname;
				if (p === "/aw.js")
					return new Response(
						readFileSync(join(import.meta.dir, "..", "web", "aw.js"), "utf8"),
						{ headers: { "content-type": "text/javascript" } },
					);
				return new Response("<!doctype html><html><body></body></html>", {
					headers: { "content-type": "text/html" },
				});
			},
		});
		const page = await (
			browser.contexts()[0] ?? (await browser.newContext())
		).newPage();
		page.on("pageerror", (error) => {
			throw error;
		});
		try {
			await page.goto(`http://127.0.0.1:${host.port}/`, {
				waitUntil: "domcontentloaded",
			});
			const fromBrowser = await page.evaluate(
				async ({ html, script }) => {
					// @ts-expect-error runtime URL served by the test host
					const mod = (await import("/aw.js")) as {
						installGlobal: (w: unknown) => void;
					};
					mod.installGlobal(window);
					document.open();
					document.write(html);
					document.close();
					const el = document.createElement("script");
					el.textContent = script;
					document.body.appendChild(el);
					const aw = (
						window as unknown as {
							aw: {
								elaborate: (
									doc: Document,
									ctx: unknown,
								) => { errors: string[] };
								serializeSnapshot: (doc: Document) => string;
							};
						}
					).aw;
					const ctx = {
						style: { paramInline: true, localparamUpper: false },
						unitId: "leaf",
						unitKind: "connect",
						unitDeps: [],
						unitMods: new Map(),
						leaf: () => null,
						wrapper: () => null,
					};
					const rendered = aw.elaborate(document, ctx);
					if (rendered.errors.length) throw new Error(rendered.errors[0]);
					return aw.serializeSnapshot(document);
				},
				{
					html: HTML.replace(/<script>[\s\S]*<\/script>/, ""),
					script: SCRIPT,
				},
			);
			const dir = await workspace();
			const ws = await loadWorkspace(join(dir, "autowire.toml"));
			const unit = ws.connectUnits[0];
			if (!unit) throw new Error("fixture unit missing");
			const happy = await renderUnit(
				ws,
				unit,
				new LeafDb(ws.indexDir),
				new Map(),
			);
			expect(happy.snapshot).toBe(fromBrowser);
		} finally {
			host.stop(true);
			await close();
		}
	});

	test("script src runs relative to the author HTML", async () => {
		const dir = await workspace();
		writeFileSync(
			join(dir, "gen.js"),
			`function buildProbe(content) {
  const ports = content.querySelector(":scope > aw-ports");
  const port = document.createElement("aw-port");
  port.setAttribute("name", "from_src");
  port.setAttribute("dir", "output");
  ports.appendChild(port);
}
`,
		);
		writeFileSync(
			join(dir, "leaf.html"),
			HTML.replace(
				/<script>[\s\S]*<\/script>/,
				`<script src="./gen.js"></script>`,
			),
		);
		const ws = await loadWorkspace(join(dir, "autowire.toml"));
		const unit = ws.connectUnits[0];
		if (!unit) throw new Error("fixture unit missing");
		const rendered = await renderUnit(
			ws,
			unit,
			new LeafDb(ws.indexDir),
			new Map(),
		);
		expect(rendered.snapshot).toContain('name="from_src"');
	});

	test("a failing classic script rejects the render", async () => {
		const dir = await workspace();
		writeFileSync(
			join(dir, "leaf.html"),
			HTML.replace("<script>", "<script>\nthrow new Error('script boom');\n"),
		);
		const ws = await loadWorkspace(join(dir, "autowire.toml"));
		const unit = ws.connectUnits[0];
		if (!unit) throw new Error("fixture unit missing");
		await expect(
			renderUnit(ws, unit, new LeafDb(ws.indexDir), new Map()),
		).rejects.toThrow(/script boom/);
	});

	test("a missing on-init function rejects the render", async () => {
		const dir = await workspace();
		writeFileSync(
			join(dir, "leaf.html"),
			HTML.replace(/<script>[\s\S]*<\/script>/, "").replace(
				'on-init="buildProbe"',
				'on-init="missing"',
			),
		);
		const ws = await loadWorkspace(join(dir, "autowire.toml"));
		const unit = ws.connectUnits[0];
		if (!unit) throw new Error("fixture unit missing");
		await expect(
			renderUnit(ws, unit, new LeafDb(ws.indexDir), new Map()),
		).rejects.toThrow(/not a function on window/);
	});
});
