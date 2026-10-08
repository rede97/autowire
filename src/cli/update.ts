// `autowire update` (help/update.txt): print the latest GitHub release address
// plus a ready-to-use upgrade prompt for an AI agent. Read-only: no download,
// no writes — the agent (or user) performs the upgrade itself.

import type { Command } from "commander";
import { releaseStamp } from "./version.ts";

export const UPDATE_REPO = "rede97/autowire";
export const UPDATE_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
export const UPDATE_PAGE = `https://github.com/${UPDATE_REPO}/releases/latest`;

export interface UpdateInfo {
	/** Currently running version (from the release stamp). */
	current: string;
	/** Latest tag, e.g. "v2.3.0". Empty when the release lookup failed. */
	latest: string;
	/** Latest release page (always the human URL). */
	url: string;
	/** Asset name → browser download URL. */
	assets: Record<string, string>;
	/** true when the running build is already the latest. */
	upToDate: boolean;
}

export interface ReleaseJson {
	tag_name?: unknown;
	html_url?: unknown;
	assets?: unknown;
}

/** Narrow the GitHub release JSON into UpdateInfo. */
export function updateInfo(current: string, json: ReleaseJson): UpdateInfo {
	const tag = typeof json.tag_name === "string" ? json.tag_name : "";
	const assets: Record<string, string> = {};
	if (Array.isArray(json.assets)) {
		for (const a of json.assets) {
			if (typeof a !== "object" || a === null) continue;
			const name = (a as Record<string, unknown>).name;
			const url = (a as Record<string, unknown>).browser_download_url;
			if (typeof name === "string" && typeof url === "string")
				assets[name] = url;
		}
	}
	const latest = tag.replace(/^v/, "");
	return {
		current,
		latest,
		url:
			typeof json.html_url === "string" && json.html_url
				? json.html_url
				: UPDATE_PAGE,
		assets,
		upToDate: latest.length > 0 && latest === current,
	};
}

/** Render the report + AI upgrade prompt (pure — testable without network). */
export function renderUpdate(info: UpdateInfo): string {
	const lines: string[] = [`current: autowire ${info.current}`];
	if (!info.latest) {
		lines.push(`latest:  lookup failed (offline?) — check ${UPDATE_PAGE}`);
		return lines.join("\n");
	}
	lines.push(`latest:  ${info.latest} (${info.url})`);
	if (info.upToDate) {
		lines.push("status:  up to date");
		return lines.join("\n");
	}
	lines.push("status:  upgrade available", "", "assets:");
	for (const [name, url] of Object.entries(info.assets)) {
		lines.push(`  ${name}\n    ${url}`);
	}
	lines.push(
		"",
		"--- AI upgrade prompt (paste to your agent) ---",
		"",
		`Upgrade autowire in this workspace from ${info.current} to ${info.latest}.`,
		`Release page: ${info.url}`,
		"Steps:",
		"1. Download the assets above: autowire.js plus the hdxml archive for this",
		"   platform (linux-x64 / macos-arm64 / macos-x64 / windows-x64).",
		"2. Replace the existing autowire.js and unpack the hdxml archive over the",
		"   existing hdxml binary location (the one in PATH, $HDXML_BIN, or",
		"   [analysis] hdxml_bin in autowire.toml).",
		"3. Verify: `bun autowire.js --version` prints the new version and commit,",
		"   `hdxml --version` prints its own version (hdxml versions independently).",
		"4. Read the release notes at the page above for breaking changes; the",
		"   changelog section lists behavior changes since the current version.",
		"5. Regenerate the workspace in dependency order: `autowire plugin wishbone",
		"   run`, then `autowire analysis run`, then `autowire connect run`.",
		"6. If AGENTS-AUTOWIRE.md exists in the workspace, diff it against the",
		"   bundled AGENTS.md (`autowire docs unpack <tmp>`) and re-init if stale.",
		"7. Re-run the project's simulations/tests to confirm the upgrade.",
	);
	return lines.join("\n");
}

export function registerUpdate(program: Command): void {
	program
		.command("update")
		.description(
			"Print the latest release address and an AI upgrade prompt (no writes)",
		)
		.action(async () => {
			const current = releaseStamp().version;
			try {
				const res = await fetch(UPDATE_API, {
					headers: { "user-agent": "autowire", accept: "application/json" },
				});
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const json = (await res.json()) as ReleaseJson;
				console.log(renderUpdate(updateInfo(current, json)));
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				console.log(
					renderUpdate({
						current,
						latest: "",
						url: UPDATE_PAGE,
						assets: {},
						upToDate: false,
					}),
				);
				console.error(`update: release lookup failed (${detail})`);
			}
		});
}
