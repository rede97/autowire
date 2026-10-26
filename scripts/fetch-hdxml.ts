// Download the pinned hdxml release binary into .cache/hdxml/<version>/.
//
// autowire no longer compiles hdxml: rede97/hdxml publishes the binaries, and
// this repo pins one version in hdxml-version.txt. Dev, CI, and the autowire
// release all call this instead of `cargo build`. Idempotent: an existing
// binary of the pinned version is left alone (--force redownloads).
//
// Usage: bun scripts/fetch-hdxml.ts [--force]

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";
import { pinnedHdxmlPath, REPO_ROOT } from "../src/cli/shared.ts";

const REPO = "rede97/hdxml";

/** Release asset for the running platform. macOS/Linux ship a tar.xz holding
 *  `hdxml`; Windows ships a zip holding `hdxml.exe` (both extracted as-is). */
function assetFor(): string {
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	if (process.platform === "win32") return "hdxml-windows-x64.zip";
	if (process.platform === "darwin") return `hdxml-macos-${arch}.tar.xz`;
	if (process.platform === "linux" && arch === "x64")
		return "hdxml-linux-x64.tar.xz";
	throw new Error(
		`no hdxml release asset for ${process.platform}/${process.arch}`,
	);
}

const root = REPO_ROOT;
if (!root) throw new Error("fetch-hdxml: run inside the autowire checkout");

const version = readFileSync(join(root, "hdxml-version.txt"), "utf8").trim();
if (!/^\d+\.\d+\.\d+$/.test(version))
	throw new Error(`hdxml-version.txt: bad version "${version}"`);

const dest = pinnedHdxmlPath(root);
const force = process.argv.includes("--force");
if (!force && existsSync(dest)) {
	console.log(`hdxml ${version} already at ${dest}`);
	process.exit(0);
}

const asset = assetFor();
const tag = `v${version}`;
const tmp = join(root, ".cache", "hdxml", `${version}.tmp`);
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

function run(cmd: string[]): void {
	const proc = Bun.spawnSync({ cmd, stdout: "inherit", stderr: "inherit" });
	if (proc.exitCode !== 0)
		throw new Error(`${cmd[0]} failed (${proc.exitCode})`);
}

const gh = Bun.which("gh");
if (
	gh &&
	Bun.spawnSync({
		cmd: [gh, "auth", "status"],
		stdout: "ignore",
		stderr: "ignore",
	}).exitCode === 0
) {
	run([
		gh,
		"release",
		"download",
		tag,
		"--repo",
		REPO,
		"--pattern",
		asset,
		"--dir",
		tmp,
		"--clobber",
	]);
} else {
	const url = `https://github.com/${REPO}/releases/download/${tag}/${asset}`;
	const out = join(tmp, asset);
	if (process.platform === "win32") {
		run([
			"powershell",
			"-NoProfile",
			"-Command",
			`Invoke-WebRequest -UseBasicParsing -Uri '${url}' -OutFile '${out}'`,
		]);
	} else {
		run(["curl", "-fsSL", "-o", out, url]);
	}
}

// Extract `hdxml` / `hdxml.exe` from the archive root.
if (asset.endsWith(".zip")) {
	run([
		"powershell",
		"-NoProfile",
		"-Command",
		`Expand-Archive -Force -Path '${join(tmp, asset)}' -DestinationPath '${tmp}'`,
	]);
} else {
	run(["tar", "-xJf", join(tmp, asset), "-C", tmp]);
}

const extracted = join(
	tmp,
	process.platform === "win32" ? "hdxml.exe" : "hdxml",
);
if (!existsSync(extracted))
	throw new Error(`fetch-hdxml: ${asset} has no hdxml binary`);
mkdirSync(join(root, ".cache", "hdxml", version), { recursive: true });
rmSync(dest, { force: true });
Bun.write(dest, Bun.file(extracted));
if (process.platform !== "win32") chmodSync(dest, 0o755);
rmSync(tmp, { recursive: true, force: true });
console.log(`hdxml ${version} -> ${dest}`);
