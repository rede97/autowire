import { describe, expect, test } from "bun:test";
import { renderUpdate, UPDATE_PAGE, updateInfo } from "../src/cli/update.ts";

const RELEASE = {
	tag_name: "v9.9.9",
	html_url: "https://github.com/rede97/autowire/releases/tag/v9.9.9",
	assets: [
		{
			name: "autowire.js",
			browser_download_url: "https://example.com/autowire.js",
		},
		{
			name: "hdxml-linux-x64.tar.xz",
			browser_download_url: "https://example.com/hdxml-linux-x64.tar.xz",
		},
		{ name: "broken-entry" }, // no URL — must be skipped
	],
};

describe("update command", () => {
	test("outdated build gets the release address and the AI prompt", () => {
		const info = updateInfo("2.3.1", RELEASE);
		expect(info.upToDate).toBe(false);
		const out = renderUpdate(info);
		expect(out).toContain("current: autowire 2.3.1");
		expect(out).toContain("latest:  9.9.9");
		expect(out).toContain(RELEASE.html_url);
		expect(out).toContain("https://example.com/autowire.js");
		expect(out).not.toContain("broken-entry");
		expect(out).toContain("AI upgrade prompt");
		expect(out).toContain("plugin wishbone");
	});

	test("up-to-date build says so and prints no prompt", () => {
		const out = renderUpdate(updateInfo("9.9.9", RELEASE));
		expect(out).toContain("up to date");
		expect(out).not.toContain("AI upgrade prompt");
	});

	test("offline lookup falls back to the release page", () => {
		const out = renderUpdate(updateInfo("2.3.1", {}));
		expect(out).toContain("lookup failed");
		expect(out).toContain(UPDATE_PAGE);
	});
});
