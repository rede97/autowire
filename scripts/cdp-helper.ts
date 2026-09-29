// CDP driver helpers for headless browsers that speak CDP (Playwright
// Chromium, obscura). Pattern doc: docs/skills/cdp-debug.md.
//
// Hard-won quirks encoded here (obscura 0.2.x):
// - No page lifecycle events: use goto(domcontentloaded); setContent /
//   addScriptTag hang.
// - blob: URLs are forbidden; import the engine over http from the
//   connect-web server (/aw.js).
// - Anchor click downloads navigate the page (context destroyed); stub
//   HTMLAnchorElement.prototype.click when you only want the text.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";

export interface CdpSession {
	browser: Browser;
	page: Page;
}

export interface TestBrowser {
	browser: Browser;
	/** Kill the spawned browser process if we started one. */
	close: () => Promise<void>;
}

function obscuraBin(): string | null {
	const candidates = [
		process.env.OBSCURA_BIN,
		join(homedir(), ".local", "bin", "obscura_c7"),
	];
	for (const c of candidates) if (c && existsSync(c)) return c;
	return null;
}

/** Browser for tests: installed Chromium first, else spawn `obscura serve`
 *  and attach over CDP. Override with AW_CDP_ENDPOINT (attach only) or
 *  OBSCURA_BIN. Fails loudly when neither is available. */
export async function launchBrowser(): Promise<TestBrowser> {
	try {
		const browser = await chromium.launch({ headless: true });
		return { browser, close: () => browser.close() };
	} catch {
		// Chromium not installed (unsupported platform) — fall through.
	}
	if (process.env.AW_CDP_ENDPOINT) {
		const browser = await chromium.connectOverCDP(process.env.AW_CDP_ENDPOINT);
		return { browser, close: () => browser.close() };
	}
	const bin = obscuraBin();
	if (!bin)
		throw new Error(
			"no browser: playwright install chromium failed and obscura not found " +
				"(set OBSCURA_BIN, or start `obscura_c7 serve --allow-private-network` and set AW_CDP_ENDPOINT)",
		);
	const port = 19200 + (process.pid % 1000);
	const proc = Bun.spawn(
		[bin, "serve", "--port", String(port), "--allow-private-network"],
		{
			stdout: "ignore",
			stderr: "ignore",
		},
	);
	const endpoint = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 15000;
	for (;;) {
		try {
			const browser = await chromium.connectOverCDP(endpoint);
			return {
				browser,
				close: async () => {
					await browser.close();
					proc.kill();
				},
			};
		} catch {
			if (Date.now() > deadline) {
				proc.kill();
				throw new Error(`obscura serve did not come up on ${endpoint}`);
			}
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 300);
			await promise;
		}
	}
}

/** Connect to a CDP endpoint (`obscura_c7 serve` or Chromium
 *  --remote-debugging-port) and open one tab. */
export async function connectCdp(
	endpoint = "http://127.0.0.1:9222",
): Promise<CdpSession> {
	const browser = await chromium.connectOverCDP(endpoint);
	const page = await (
		browser.contexts()[0] ?? (await browser.newContext())
	).newPage();
	return { browser, page };
}

/** Navigate. Never setContent: no lifecycle events on minimal browsers. */
export async function openPage(page: Page, url: string): Promise<void> {
	await page.goto(url, { waitUntil: "domcontentloaded" });
}

interface AwSessionWindow {
	aw: { session: (step: string) => Promise<string> };
}

/** One connect-page session step (window.aw.session). */
export async function sessionStep(page: Page, step: string): Promise<string> {
	return page.evaluate(
		(s) => (window as unknown as AwSessionWindow).aw.session(s),
		step,
	);
}

/** before-instances → check → elaborate → before-dump → run. Returns the
 *  printed .sv text (also shown in #aw-generated). */
export async function runSession(page: Page): Promise<string> {
	for (const step of ["before-instances", "check", "elaborate", "before-dump"])
		await sessionStep(page, step);
	return sessionStep(page, "run");
}

/** Live author face with aw-render stripped, without a real download. */
export async function authorFaceText(page: Page): Promise<string> {
	return page.evaluate(() => {
		HTMLAnchorElement.prototype.click = () => {}; // download navigates in obscura
		return (window as unknown as AwSessionWindow).aw.session("save-html");
	});
}

/** Load web/aw.js into the current page (engine without the page UI).
 *  The specifier is a URL the server hosts — not a runtime registry, but
 *  blob:/data: module URLs are blocked on minimal browsers, so this is the
 *  one place a dynamic import is legitimate. */
export async function installEngine(page: Page): Promise<void> {
	await page.evaluate(async () => {
		// @ts-expect-error runtime URL served by the page host
		const mod = (await import("/aw.js")) as {
			installGlobal: (w: unknown) => void;
		};
		mod.installGlobal(window);
	});
}
