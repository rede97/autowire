import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { renderUnit } from "../src/core/happydom.ts";
import { LeafDb } from "../src/rtl/leaf.ts";
import { loadWorkspace } from "../src/workspace.ts";

const SCRIPT = `aw.on("before-instances", ({ mod }) => {
  const ports = mod.querySelector(":scope > aw-content > aw-ports");
  const port = document.createElement("aw-port");
  port.setAttribute("name", "probe");
  port.setAttribute("dir", "output");
  ports.appendChild(port);
});
aw.on("before-dump", ({ doc }) => {
  if (doc.querySelector("aw-render aw-connect"))
    throw new Error("before-dump must stay read-only");
});
`;

const HTML = `<!doctype html>
<html><body>
<autowire>
  <aw-mod name="leaf">
    <aw-content>
      <aw-ports>
        <aw-port name="clk" dir="input"></aw-port>
      </aw-ports>
      <aw-insts></aw-insts>
    </aw-content>
    <aw-submods></aw-submods>
    <aw-render></aw-render>
  </aw-mod>
</autowire>
<script type="module">
${SCRIPT}</script>
</body></html>
`;

async function workspace(): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "aw-happy-"));
	writeFileSync(
		join(dir, "autowire.toml"),
		`
[dump]
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
	test("module script mutates the author face before elaborate", async () => {
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

	test("same HTML snapshot as Chromium", async () => {
		const browser = await chromium.launch();
		const page = await browser.newPage();
		page.on("pageerror", (error) => {
			throw error;
		});
		try {
			await page.setContent("<!doctype html><html><body></body></html>");
			const aw = readFileSync(
				join(import.meta.dir, "..", "web", "aw.js"),
				"utf8",
			);
			await page.addScriptTag({
				type: "module",
				content: `${aw}\ninstallGlobal(window);`,
			});
			await page.waitForFunction(() => "aw" in window, undefined, {
				timeout: 3000,
			});
			await page.setContent(HTML.replace(/<script[\s\S]*<\/script>/, ""), {
				waitUntil: "domcontentloaded",
			});
			const fromBrowser = await page.evaluate(async (script) => {
				const aw = (
					window as unknown as {
						aw: {
							beginUnitHooks: (id: string) => void;
							endUnitHooks: () => void;
							runBeforeInstances: (doc: Document, id: string) => void;
							check: (doc: Document, ctx: unknown) => { errors: string[] };
							elaborate: (doc: Document, ctx: unknown) => { errors: string[] };
							runBeforeDump: (doc: Document, id: string) => void;
							serializeSnapshot: (doc: Document) => string;
						};
					}
				).aw;
				const fn = new Function("window", "document", "aw", script);
				aw.beginUnitHooks("leaf");
				try {
					fn(window, document, aw);
				} finally {
					aw.endUnitHooks();
				}
				aw.runBeforeInstances(document, "leaf");
				const ctx = {
					style: { paramInline: true, localparamUpper: false },
					unitId: "leaf",
					unitKind: "connect",
					unitDeps: [],
					unitMods: new Map(),
					leaf: () => null,
					wrapper: () => null,
				};
				const checked = aw.check(document, ctx);
				if (checked.errors.length) throw new Error(checked.errors[0]);
				const rendered = aw.elaborate(document, ctx);
				if (rendered.errors.length) throw new Error(rendered.errors[0]);
				aw.runBeforeDump(document, "leaf");
				return aw.serializeSnapshot(document);
			}, SCRIPT);
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
			await browser.close();
		}
	});

	test("a failing module script rejects the render", async () => {
		const dir = await workspace();
		writeFileSync(
			join(dir, "leaf.html"),
			HTML.replace("aw.on", "throw new Error('script boom'); aw.on"),
		);
		const ws = await loadWorkspace(join(dir, "autowire.toml"));
		const unit = ws.connectUnits[0];
		if (!unit) throw new Error("fixture unit missing");
		await expect(
			renderUnit(ws, unit, new LeafDb(ws.indexDir), new Map()),
		).rejects.toThrow(/script boom|module script/);
	});
});
