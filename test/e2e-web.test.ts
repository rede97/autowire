import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import { launchBrowser } from "../scripts/cdp-helper.ts";
import { startWeb } from "../src/web/server.ts";
import type { WorkspaceConfig } from "../src/workspace.ts";
import { loadWorkspace } from "../src/workspace.ts";

// End-to-end: the demo workspace (demo/soc/autowire.toml + connect/*.html),
// real headless Chromium. The page shows generated source and does not write
// the workspace. .sv goldens are connect run's job, not this browser session.

const ROOT = join(import.meta.dir, "..");
const DEMO = join(ROOT, "demo", "soc");

let ws: WorkspaceConfig;
let base = "";
let ctx: BrowserContext;
let closeBrowser: () => Promise<void>;

async function waitStatus(page: import("playwright").Page) {
	await page.waitForSelector(
		'#aw-status[data-state="done"], #aw-status[data-state="error"]',
		{
			timeout: 20000,
		},
	);
	const el = page.locator("#aw-status");
	return {
		state: await el.getAttribute("data-state"),
		text: (await el.textContent()) ?? "",
	};
}

beforeAll(async () => {
	ws = await loadWorkspace(join(DEMO, "autowire.toml"));
	if (!existsSync(join(ws.indexDir, "index.xml"))) {
		throw new Error(
			"RtlIndex missing; run `bun ../../index.ts analysis run` in demo/soc first",
		);
	}
	base = await startWeb(ws, 0, null);
	const launched = await launchBrowser();
	closeBrowser = launched.close;
	ctx = launched.browser.contexts()[0] ?? (await launched.browser.newContext());
}, 30000);

afterAll(async () => {
	await closeBrowser?.();
});

describe("autowire web e2e", () => {
	test("plain load: idle status, panels populated, no auto action", async () => {
		const page = await ctx.newPage();
		await page.goto(`${base}`);
		await page.waitForSelector("#db-summary table", { timeout: 10000 });
		expect(await page.locator("#aw-status").getAttribute("data-state")).toBe(
			"idle",
		);
		for (const id of [
			"#btn-check",
			"#btn-elaborate",
			"#btn-run",
			"#btn-save-sv",
			"#btn-save-html",
			"#btn-reset",
		]) {
			expect(await page.locator(id).isVisible()).toBe(true);
		}
		const mods = await page.locator("#aw-live aw-mod").all();
		expect(mods.length).toBeGreaterThanOrEqual(1);
		const renderInsts = await page
			.locator("#aw-live aw-render > aw-insts > aw-inst")
			.all();
		expect(renderInsts).toHaveLength(0);
		await page.close();
	});

	test("?check=1 validates only (render untouched, no workspace write)", async () => {
		const page = await ctx.newPage();
		await page.goto(`${base}?check=1`);
		const status = await waitStatus(page);
		expect(status.state).toBe("done");
		expect(status.text).toContain("check: ok");
		expect(
			await page.locator("#aw-live aw-render > aw-insts > aw-inst").all(),
		).toHaveLength(0);
		expect(existsSync(join(DEMO, ".autowire", "save"))).toBe(false);
		await page.close();
	});

	test("?select= shows leaf facts from RtlIndex", async () => {
		const page = await ctx.newPage();
		await page.goto(`${base}?select=picorv32_wb&check=1`);
		await waitStatus(page);
		expect(await page.locator("#right-title").textContent()).toBe(
			"picorv32_wb",
		);
		expect(await page.locator("#right-body").textContent()).toContain(
			"wb_clk_i",
		);
		await page.close();
	});

	test("buttons: [Elaborate] auto-runs check; [Reset] restores author face", async () => {
		const page = await ctx.newPage();
		await page.goto(`${base}`);
		await page.waitForSelector("#aw-live aw-mod");
		await page.locator("#btn-elaborate").click();
		const status = await waitStatus(page);
		expect(status.state).toBe("done");
		expect(status.text).toContain("elaborate: ok");
		expect(
			await page
				.locator(
					'#aw-live aw-mod[name="sha256wb"] > aw-render > aw-insts > aw-inst',
				)
				.all(),
		).not.toHaveLength(0);
		await page.locator("#btn-reset").click();
		await page.waitForSelector('#aw-status[data-state="idle"]', {
			timeout: 10000,
		});
		expect(await page.locator("#aw-status").getAttribute("data-state")).toBe(
			"idle",
		);
		expect(
			await page.locator("#aw-live aw-render > aw-insts > aw-inst").all(),
		).toHaveLength(0);
	});

	test("?run=1 shows snapshots and does not write the workspace", async () => {
		const before = existsSync(join(ws.connectDir, "soc_top.sv"))
			? await readFile(join(ws.connectDir, "soc_top.sv"), "utf8")
			: null;
		const page = await ctx.newPage();
		await page.goto(`${base}?unit=soc_top&run=1`);
		const status = await waitStatus(page);
		expect(status.state).toBe("done");
		expect(status.text).toContain(".sv in view");
		const shown = (await page.locator("#aw-generated").textContent()) ?? "";
		expect(shown).toContain("module sha256wb");
		expect(shown).toContain("module sd_sha_ch");
		expect(shown).toContain("module soc_top");
		expect(shown).not.toContain("aw-render");
		await page.close();
		const after = existsSync(join(ws.connectDir, "soc_top.sv"))
			? await readFile(join(ws.connectDir, "soc_top.sv"), "utf8")
			: null;
		expect(after).toBe(before);
	});

	test("?run=1 on soc_tb shows tb_soc in the page and writes nothing", async () => {
		const simPath = join(ws.simDir, "tb_soc.sv");
		const before = existsSync(simPath) ? await readFile(simPath, "utf8") : null;
		const page = await ctx.newPage();
		await page.goto(`${base}?unit=soc_tb&run=1`);
		const status = await waitStatus(page);
		expect(status.state).toBe("done");
		expect(status.text).toContain(".sv in view");
		const shown = (await page.locator("#aw-generated").textContent()) ?? "";
		expect(shown).toContain("module tb_soc");
		await page.close();
		expect(existsSync(join(DEMO, ".autowire", "connect", "soc_tb.xml"))).toBe(
			false,
		);
		const after = existsSync(simPath) ? await readFile(simPath, "utf8") : null;
		expect(after).toBe(before);
	});

	test("write routes are gone; unknown snapshot is 404", async () => {
		for (const path of ["/api/dump", "/api/save", "/api/check"]) {
			const res = await fetch(`${base}${path.slice(1)}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "sha256wb", html: "<autowire/>" }),
			});
			expect(res.status).toBe(404);
		}
		const missing = await fetch(`${base}api/connect?id=ghost_unit`);
		expect(missing.status).toBe(404);
	});

	test("api guard: cross-origin GET is refused", async () => {
		const crossSite = await fetch(`${base}api/units`, {
			headers: { origin: "https://evil.example" },
		});
		expect(crossSite.status).toBe(403);
	});

	test("save downloads visible .sv and does not write .autowire/save", async () => {
		await rm(join(DEMO, ".autowire", "save"), { recursive: true, force: true });
		const page = await ctx.newPage();
		await page.goto(`${base}?unit=sha256wb&run=1`);
		await waitStatus(page);
		// Minimal browsers (obscura) navigate on anchor downloads and lack CDP
		// download events; stub the click so the page survives.
		await page.evaluate(() => {
			HTMLAnchorElement.prototype.click = () => {};
		});
		await page.locator("#btn-save-sv").click();
		const status = await waitStatus(page);
		expect(status.state).toBe("done");
		expect(status.text).toContain("browser download (.sv)");
		await page.close();
		expect(existsSync(join(DEMO, ".autowire", "save", "sha256wb.html"))).toBe(
			false,
		);
	});

	test("session refuses a step whose predecessor was not run", async () => {
		const page = await ctx.newPage();
		await page.goto(`${base}?unit=sha256wb`);
		await page.waitForSelector("#aw-live aw-mod");
		const skipped = await page.evaluate(async () => {
			const aw = (
				window as unknown as { aw: { session: (s: string) => Promise<string> } }
			).aw;
			try {
				await aw.session("elaborate");
				return "";
			} catch (e) {
				return (e as Error).message;
			}
		});
		expect(skipped).toContain("requires a clean check");
		const help = await page.evaluate(async () => {
			const aw = (
				window as unknown as { aw: { session: (s: string) => Promise<string> } }
			).aw;
			return aw.session("help");
		});
		expect(help).toContain("before-instances");
		expect(help).toContain("write a file");
		const ran = await page.evaluate(async () => {
			const aw = (
				window as unknown as { aw: { session: (s: string) => Promise<string> } }
			).aw;
			return aw.session("run");
		});
		expect(ran).toContain("module sha256wb");
		await page.close();
	});

	test("check error path: tb without dep snapshot reports missing snapshot", async () => {
		const snap = join(DEMO, ".autowire", "connect", "sd_sha_ch.xml");
		const saved = existsSync(snap) ? await readFile(snap, "utf8") : null;
		await rm(snap, { force: true });
		try {
			const page = await ctx.newPage();
			await page.goto(`${base}?unit=soc_top&check=1`);
			const status = await waitStatus(page);
			expect(status.state).toBe("error");
			expect(status.text).toContain('snapshot for "sd_sha_ch" missing');
			expect(await page.title()).toMatch(/\[error\]$/);
			await page.close();
		} finally {
			if (saved !== null) {
				await Bun.write(snap, saved);
			}
		}
	});
});
