import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { startWeb } from "../src/web/server.ts";
import type { WorkspaceConfig } from "../src/workspace.ts";
import { loadWorkspace } from "../src/workspace.ts";

// End-to-end: the demo workspace (demo/soc/autowire.toml + connect/*.html),
// real headless Chromium, real dump. Golden .sv files live in test/golden/soc/.

const ROOT = join(import.meta.dir, "..");
const DEMO = join(ROOT, "demo", "soc");
const GOLDEN_DIR = join(ROOT, "test", "golden", "soc");
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
	ws = await loadWorkspace(join(DEMO, "autowire.toml"));
	if (!existsSync(join(ws.indexDir, "index.xml"))) {
		throw new Error(
			"RtlIndex missing; run `bun ../../index.ts analysis` in demo/soc first",
		);
	}
	// Clean dump surfaces so the test observes only this run's writes.
	await rm(join(DEMO, ".autowire", "connect"), {
		recursive: true,
		force: true,
	});
	await rm(ws.connectDir, { recursive: true, force: true });
	await rm(ws.simDir, { recursive: true, force: true });
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
		expect(mods.length).toBeGreaterThanOrEqual(1);
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
		expect(existsSync(ws.connectDir)).toBe(false);
		await page.close();
	});

	test("?select= shows leaf facts from RtlIndex", async () => {
		const page = await browser.newPage();
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

	test("?dump=1 on tb: deps chain dumps first, SV files match goldens", async () => {
		const page = await browser.newPage();
		await page.goto(`${base}?unit=soc_top&dump=1`);
		const status = await waitStatus(page);
		expect(status.state).toBe("done");
		expect(status.text).toContain("dump: 2 file(s)");
		expect(existsSync(join(DEMO, ".autowire", "connect", "sha256wb.xml"))).toBe(
			true,
		);
		expect(existsSync(join(DEMO, ".autowire", "connect", "soc_top.xml"))).toBe(
			true,
		);
		await page.close();
		const names = ["soc_top", "sha256wb"];
		await mkdir(GOLDEN_DIR, { recursive: true });
		for (const n of names) {
			const got = await readFile(join(ws.connectDir, `${n}.sv`), "utf8");
			const goldenPath = join(GOLDEN_DIR, `${n}.sv`);
			if (UPDATE_GOLDEN || !existsSync(goldenPath)) {
				await writeFile(goldenPath, got, "utf8");
			} else {
				expect(got).toBe(await readFile(goldenPath, "utf8"));
			}
		}
	});

	test("?dump=1 on soc_tb: writes gen/sim/tb_soc.sv (no connect XML for sim)", async () => {
		const page = await browser.newPage();
		await page.goto(`${base}?unit=soc_tb&dump=1`);
		const status = await waitStatus(page);
		expect(status.state).toBe("done");
		expect(status.text).toMatch(/dump: \d+ file\(s\)/);
		await page.close();
		expect(existsSync(join(DEMO, ".autowire", "connect", "soc_tb.xml"))).toBe(
			false,
		);
		const got = await readFile(join(ws.simDir, "tb_soc.sv"), "utf8");
		expect(got).toContain("module tb_soc;");
		expect(got).toContain('`include "tb_env_setup.svh"');
		expect(got).toContain('`include "tb_sim.svh"');
		expect(got).toContain("soc_top u_dut");
		const goldenPath = join(GOLDEN_DIR, "tb_soc.sv");
		await mkdir(GOLDEN_DIR, { recursive: true });
		if (UPDATE_GOLDEN || !existsSync(goldenPath)) {
			await writeFile(goldenPath, got, "utf8");
		} else {
			expect(got).toBe(await readFile(goldenPath, "utf8"));
		}
	});

	test("dump gate: leftover template in render → 422; unknown snapshot → 404", async () => {
		const bad = await fetch(`${base}api/dump`, {
			method: "POST",
			body: JSON.stringify({
				id: "sha256wb",
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

	test("save: [Save] drops live DOM to .autowire/save; API guards id/body", async () => {
		const page = await browser.newPage();
		await page.goto(`${base}?unit=sha256wb&check=1`);
		await waitStatus(page);
		await page.locator("#btn-save").click();
		const status = await waitStatus(page);
		expect(status.state).toBe("done");
		expect(status.text).toContain(".autowire/save/sha256wb.html");
		await page.close();
		const saved = await readFile(
			join(DEMO, ".autowire", "save", "sha256wb.html"),
			"utf8",
		);
		// live DOM: author content present, and it is not the author file path
		expect(saved).toContain("<aw-content>");
		expect(saved).toContain('name="sha256wb"');
		const ghost = await fetch(`${base}api/save`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "ghost_unit", html: "<autowire/>" }),
		});
		expect(ghost.status).toBe(404);
		const noRoot = await fetch(`${base}api/save`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "sha256wb", html: "<div/>" }),
		});
		expect(noRoot.status).toBe(422);
		const badId = await fetch(`${base}api/save`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "../escape", html: "<autowire/>" }),
		});
		expect(badId.status).toBe(400);
	});

	test("check error path: tb without dep snapshot reports missing snapshot", async () => {
		await rm(join(DEMO, ".autowire", "connect", "sha256wb.xml"), {
			force: true,
		});
		const page = await browser.newPage();
		await page.goto(`${base}?unit=soc_top&check=1`);
		const status = await waitStatus(page);
		expect(status.state).toBe("error");
		expect(status.text).toContain('snapshot for "sha256wb" missing');
		expect(await page.title()).toMatch(/\[error\]$/);
		await page.close();
		// restore shared state for later runs
		const page2 = await browser.newPage();
		await page2.goto(`${base}?unit=soc_top&dump=1`);
		await waitStatus(page2);
		await page2.close();
	});
});
