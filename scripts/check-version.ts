// Fail when package.json disagrees with CHANGELOG.md.
// hdxml has its own version (hdxml/Cargo.toml) and is intentionally not checked.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseChangelog } from "../src/cli/changelog.ts";

const root = join(import.meta.dir, "..");
const notes = parseChangelog(readFileSync(join(root, "CHANGELOG.md"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
	version?: string;
};

if (pkg.version !== notes.version) {
	console.error(
		`package.json version ${pkg.version} != CHANGELOG.md ${notes.version}`,
	);
	process.exit(1);
}
console.log(notes.version);
