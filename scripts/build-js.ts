// Bundle one autowire.js. Run scripts/pack-docs.ts first.
// --compile also writes out/autowire with the Bun runtime linked in.

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const version = spawnSync("bun", ["scripts/check-version.ts"], {
	cwd: root,
	encoding: "utf8",
});
if (version.status !== 0) {
	process.stderr.write(version.stderr ?? "");
	process.exit(version.status ?? 1);
}
const release = (version.stdout ?? "").trim().split("\n").at(-1) ?? "";
if (!/^\d+\.\d+\.\d+$/.test(release)) {
	console.error(`build-js: bad version ${JSON.stringify(release)}`);
	process.exit(1);
}

const commitProc = spawnSync("git", ["rev-parse", "HEAD"], {
	cwd: root,
	encoding: "utf8",
});
const commit = (commitProc.stdout ?? "").trim() || "unknown";
const built = new Date().toISOString();
const defines = [
	`process.env.AUTOWIRE_VERSION=${JSON.stringify(release)}`,
	`process.env.AUTOWIRE_COMMIT=${JSON.stringify(commit)}`,
	`process.env.AUTOWIRE_BUILT=${JSON.stringify(built)}`,
];

mkdirSync(join(root, "out"), { recursive: true });

function bunBuild(args: string[]): void {
	const proc = spawnSync("bun", ["build", ...args], {
		cwd: root,
		stdio: "inherit",
	});
	if (proc.status !== 0) process.exit(proc.status ?? 1);
}

const defineArgs = defines.flatMap((value) => ["--define", value]);
bunBuild([
	"index.ts",
	"--outfile",
	"out/autowire.js",
	"--target",
	"bun",
	"--minify",
	"--keep-names",
	...defineArgs,
]);
console.log(`autowire.js ${release} commit ${commit} built ${built}`);

if (process.argv.includes("--compile")) {
	bunBuild([
		"--compile",
		"index.ts",
		"--outfile",
		"out/autowire",
		...defineArgs,
	]);
	console.log(`autowire ${release} commit ${commit} built ${built}`);
}
