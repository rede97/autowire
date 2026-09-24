// Shared CLI helpers: hdxml binary resolution, sidecar analysis, workspace loading.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceConfig } from "../workspace.js";
import { findWorkspace, loadWorkspace } from "../workspace.js";

/** Repo root (this file lives in src/cli/). */
export const REPO_ROOT = join(import.meta.dir, "..", "..");

const EXE = process.platform === "win32" ? ".exe" : "";

/** Resolve hdxml binary: --hdxml > toml [hdxml] bin > $HDXML_BIN > repo target/{release,debug} > PATH */
export function findHdxml(explicit?: string, tomlBin?: string | null): string {
	if (tomlBin && !existsSync(tomlBin)) {
		console.error(`autowire.toml: [hdxml] bin not found: ${tomlBin}`);
		process.exit(1);
	}
	const candidates = [
		explicit,
		tomlBin ?? undefined,
		process.env.HDXML_BIN,
		join(REPO_ROOT, `hdxml/target/release/hdxml${EXE}`),
		join(REPO_ROOT, `hdxml/target/debug/hdxml${EXE}`),
	].filter((c): c is string => typeof c === "string" && c.length > 0);
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	return "hdxml"; // fall back to PATH; spawn fails if missing
}

/** When path is an RTL source dir, run the hdxml sidecar into .autowire/hdxml (autowire-owned fixed temp dir; GC keeps it clean). */
export function analyzeWithSidecar(
	rtlDir: string,
	hdxmlBin: string,
	incdirs: string[],
): string {
	const outDir = join(REPO_ROOT, ".autowire/hdxml");
	const args = ["-w", rtlDir, "-o", outDir];
	for (const i of incdirs) args.push("-I", i);
	const proc = Bun.spawnSync({
		cmd: [hdxmlBin, ...args],
		stdout: "inherit",
		stderr: "inherit",
	});
	if (!existsSync(join(outDir, "index.xml"))) {
		console.error(
			`hdxml analysis failed (exit ${proc.exitCode}); no index.xml`,
		);
		process.exit(1);
	}
	console.error(`RtlIndex dir: ${outDir}`);
	return outDir;
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
