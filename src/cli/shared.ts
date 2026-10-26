// Shared CLI helpers: hdxml binary resolution, workspace loading.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WorkspaceConfig } from "../workspace.js";
import { findWorkspace, loadWorkspace } from "../workspace.js";

/** Pinned hdxml release (rede97/hdxml) this autowire checkout builds against. */
export const HDXML_VERSION_FILE = "hdxml-version.txt";

/** Repo checkout root, found by walking up for hdxml-version.txt; null inside a
 *  standalone bundle (no repo candidates, hdxml comes from PATH/HDXML_BIN). */
function findRepoRoot(): string | null {
	let dir = import.meta.dir;
	for (let i = 0; i < 8; i++) {
		if (existsSync(join(dir, HDXML_VERSION_FILE))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}
export const REPO_ROOT: string | null = findRepoRoot();

/** `.cache/hdxml/<pinned>/hdxml(.exe)` written by `bun run fetch:hdxml`. */
export function pinnedHdxmlPath(root: string): string {
	const version = readFileSync(join(root, HDXML_VERSION_FILE), "utf8").trim();
	const exe = process.platform === "win32" ? ".exe" : "";
	return join(root, ".cache", "hdxml", version, `hdxml${exe}`);
}

/** Resolve hdxml binary: --hdxml > toml [analysis] hdxml_bin > $HDXML_BIN > repo pinned cache > PATH */
export function findHdxml(explicit?: string, tomlBin?: string | null): string {
	if (tomlBin && !existsSync(tomlBin)) {
		console.error(`autowire.toml: [analysis] hdxml_bin not found: ${tomlBin}`);
		process.exit(1);
	}
	const candidates = [
		explicit,
		tomlBin ?? undefined,
		process.env.HDXML_BIN,
		REPO_ROOT ? pinnedHdxmlPath(REPO_ROOT) : undefined,
	].filter((c): c is string => typeof c === "string" && c.length > 0);
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	return "hdxml"; // fall back to PATH; spawn fails if missing
}

/** Resolve and load the workspace config (shared by web / check / analysis). */
export async function requireWorkspace(
	start: string,
): Promise<WorkspaceConfig> {
	const tomlPath = start.endsWith(".toml") ? start : findWorkspace(start);
	if (!tomlPath || !existsSync(tomlPath)) {
		console.error(`autowire.toml not found from ${start} (run: autowire init)`);
		process.exit(1);
	}
	return loadWorkspace(tomlPath);
}
