// Drive the packaged out/autowire.js end to end (CI release gate).
// Catches bundle-only breakage: pack reads, repo-root resolution, DSL
// materialization — things unit tests against src/ never see.
//
// Usage: bun scripts/smoke-bundle.ts   (needs hdxml on PATH or repo target/)

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseChangelog } from "../src/cli/changelog.ts";

const root = join(import.meta.dir, "..");
const bundle = join(root, "out", "autowire.js");
if (!existsSync(bundle)) {
	console.error("out/autowire.js missing; run bun run build:js first");
	process.exit(1);
}

let failed = 0;
function run(
	name: string,
	args: string[],
	cwd: string,
	expectCode = 0,
): string {
	const proc = spawnSync("bun", [bundle, ...args], { cwd, encoding: "utf8" });
	const out = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
	const ok = proc.status === expectCode;
	console.log(`${ok ? "ok" : "FAIL"} ${name}`);
	if (!ok) {
		failed++;
		console.log(out.split("\n").slice(0, 20).join("\n"));
	}
	return out;
}

// 1. --version carries the changelog version
const version = parseChangelog(
	readFileSync(join(root, "CHANGELOG.md"), "utf8"),
).version;
const v = run("bundle --version", ["--version"], root);
if (!v.includes(`autowire ${version}`)) {
	console.log(`FAIL --version lacks ${version}`);
	failed++;
}

// 2. standalone init in an empty dir (no repo checkout reachable)
const scratch = mkdtempSync(join(tmpdir(), "aw-smoke-"));
run("init", ["init", "smokechip"], scratch);
for (const rel of [
	"autowire.toml",
	"AGENTS-AUTOWIRE.md",
	".autowire/hdxml",
	".autowire/dsl/wishbone-bus/dsl.ts",
	".autowire/dsl/wishbone-regfile/dsl.ts",
	".autowire/dsl/wishbone-regfile/layout.ts",
]) {
	if (!existsSync(join(scratch, rel))) {
		console.log(`FAIL init missing ${rel}`);
		failed++;
	}
}
run("init refuses overwrite", ["init", "smokechip"], scratch, 1);

// 3. drive demo/soc with the bundle; outputs must stay byte-identical
const soc = join(root, "demo", "soc");
run("demo/soc analysis run", ["analysis", "run"], soc);
run("demo/soc plugin wishbone run", ["plugin", "wishbone", "run"], soc);
// run before check: a fresh checkout has no .autowire/connect snapshots yet
run("demo/soc connect run", ["connect", "run"], soc);
run("demo/soc connect check", ["connect", "check"], soc);
// Excel embeds a timestamp (always-rewrite policy); everything else must be stable.
const diff = spawnSync(
	"git",
	["diff", "--exit-code", "--stat", "--", "demo/soc", ":(exclude)**/*.xlsx"],
	{
		cwd: root,
		encoding: "utf8",
	},
);
if (diff.status !== 0) {
	console.log("FAIL demo/soc outputs drifted:");
	console.log(diff.stdout);
	failed++;
} else {
	console.log("ok demo/soc outputs byte-identical");
}

rmSync(scratch, { recursive: true, force: true });
if (failed > 0) {
	console.error(`bundle smoke: ${failed} failure(s)`);
	process.exit(1);
}
console.log("bundle smoke: all ok");
