// CDP driver helpers for headless browsers that speak CDP (Playwright
// Chromium, obscura, lightpanda). Pattern doc: docs/dev/cdp-debug.md.
//
// Hard-won quirks encoded here (obscura 0.2.x):
// - No page lifecycle events: use goto(domcontentloaded); setContent /
//   addScriptTag hang.
// - blob: URLs are forbidden; import the engine over http from the
//   connect-web server (/aw.js).
// - Anchor click downloads navigate the page (context destroyed); stub
//   HTMLAnchorElement.prototype.click when you only want the text.

import { type Browser, chromium, type Page } from "playwright";

export interface CdpSession {
	browser: Browser;
	page: Page;
}

/** Connect to a CDP endpoint (`obscura_c7 serve`, lightpanda, or Chromium
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
		const mod = (await import("/aw.js")) as {
			installGlobal: (w: unknown) => void;
		};
		mod.installGlobal(window);
	});
}
