import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { startWeb } from "./web.ts";
import type { WorkspaceConfig } from "./workspace.ts";
import { loadWorkspace } from "./workspace.ts";

// End-to-end: real workspace (repo autowire.toml + connect/ demos), real
// headless Chromium, real dump. Golden .sv files live in test/golden/.

const ROOT = join(import.meta.dir, "..");
const GOLDEN_DIR = join(ROOT, "test", "golden");
const UPDATE_GOLDEN = process.env.AW_UPDATE_GOLDEN === "1";

let ws: WorkspaceConfig;
let base = "";
let browser: Browser;

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
	ws = await loadWorkspace(join(ROOT, "autowire.toml"));
	if (!existsSync(join(ws.indexDir, "index.xml"))) {
		throw new Error("RtlIndex missing; run ./gen_index.sh first");
	}
	// Clean dump surfaces so the test observes only this run's writes.
	await rm(join(ROOT, ".autowire", "connect"), {
		recursive: true,
		force: true,
	});
	await rm(ws.dumpDir, { recursive: true, force: true });
	base = await startWeb(ws, 0, null);
	browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
	await browser?.close();
});

describe("autowire web e2e", () => {
	test("plain load: idle status, panels populated, no auto action", async () => {
		const page = await browser.newPage();
		await page.goto(`${base}`);
		await page.waitForSelector("#db-summary table", { timeout: 10000 });
		expect(await page.locator("#aw-status").getAttribute("data-state")).toBe(
			"idle",
		);
		for (const id of ["#btn-check", "#btn-render", "#btn-dump", "#btn-reset"]) {
			expect(await page.locator(id).isVisible()).toBe(true);
		}
		const mods = await page.locator("#aw-live aw-mod").all();
		expect(mods.length).toBeGreaterThanOrEqual(3);
		const renderInsts = await page
			.locator("#aw-live aw-render > aw-insts > aw-inst")
			.all();
		expect(renderInsts).toHaveLength(0);
		await page.close();
	});

	test("?check=1 validates only (render untouched, no .sv)", async () => {
		const page = await browser.newPage();
		await page.goto(`${base}?check=1`);
		const status = await waitStatus(page);
		expect(status.state).toBe("done");
		expect(status.text).toContain("check: ok");
		expect(
			await page.locator("#aw-live aw-render > aw-insts > aw-inst").all(),
		).toHaveLength(0);
		expect(existsSync(ws.dumpDir)).toBe(false);
		await page.close();
	});

	test("?select= shows leaf facts from RtlIndex", async () => {
		const page = await browser.newPage();
		await page.goto(`${base}?select=cc_counter&check=1`);
		await waitStatus(page);
		expect(await page.locator("#right-title").textContent()).toBe("cc_counter");
		expect(await page.locator("#right-body").textContent()).toContain("clk_i");
		expect(await page.locator("#right-body").textContent()).toContain("Width");
		await page.close();
	});

	test("buttons: [Render] auto-runs check; [Reset] restores author face", async () => {
		const page = await browser.newPage();
		await page.goto(`${base}`);
		await page.waitForSelector("#aw-live aw-mod");
		await page.locator("#btn-render").click();
		const status = await waitStatus(page);
		expect(status.state).toBe("done");
		expect(status.text).toContain("render: ok");
		expect(
			await page
				.locator(
					'#aw-live aw-mod[name="phy_wrap"] > aw-render > aw-insts > aw-inst',
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

	test("?dump=1 on tb: deps chain dumps first, SV files match goldens", async () => {
		const page = await browser.newPage();
		await page.goto(`${base}?unit=phy_wrap_tb&dump=1`);
		const status = await waitStatus(page);
		expect(status.state).toBe("done");
		expect(status.text).toContain("dump: 4 file(s)");
		expect(existsSync(join(ROOT, ".autowire", "connect", "phy_wrap.xml"))).toBe(
			true,
		);
		expect(
			existsSync(join(ROOT, ".autowire", "connect", "phy_wrap_tb.xml")),
		).toBe(true);
		await page.close();
		const names = ["phy_wrap_tb", "phy_wrap", "gray_tap", "gray_pair"];
		await mkdir(GOLDEN_DIR, { recursive: true });
		for (const n of names) {
			const got = await readFile(join(ws.dumpDir, `${n}.sv`), "utf8");
			const goldenPath = join(GOLDEN_DIR, `${n}.sv`);
			if (UPDATE_GOLDEN || !existsSync(goldenPath)) {
				await writeFile(goldenPath, got, "utf8");
			} else {
				expect(got).toBe(await readFile(goldenPath, "utf8"));
			}
		}
	});

	test("dump gate: leftover template in render → 422; unknown snapshot → 404", async () => {
		const bad = await fetch(`${base}api/dump`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				id: "phy_wrap",
				html: "<autowire><aw-mod name='x'><aw-render><aw-templates><aw-template></aw-template></aw-templates></aw-render></aw-mod></autowire>",
			}),
		});
		expect(bad.status).toBe(422);
		const missing = await fetch(`${base}api/connect?id=ghost_unit`);
		expect(missing.status).toBe(404);
		const badId = await fetch(`${base}api/dump`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "../escape", html: "<autowire/>" }),
		});
		expect(badId.status).toBe(400);
	});

	test("check error path: tb without dep snapshot reports missing snapshot", async () => {
		await rm(join(ROOT, ".autowire", "connect", "phy_wrap.xml"), {
			force: true,
		});
		const page = await browser.newPage();
		await page.goto(`${base}?unit=phy_wrap_tb&check=1`);
		const status = await waitStatus(page);
		expect(status.state).toBe("error");
		expect(status.text).toContain('snapshot for "phy_wrap" missing');
		expect(await page.title()).toMatch(/\[error\]$/);
		await page.close();
		// restore shared state for later runs
		const page2 = await browser.newPage();
		await page2.goto(`${base}?unit=phy_wrap_tb&dump=1`);
		await waitStatus(page2);
		await page2.close();
	});
});
