// Print the top CHANGELOG.md entry version. Pass a path to also write the notes body.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseChangelog } from "../src/cli/changelog.ts";

const root = join(import.meta.dir, "..");
const notes = parseChangelog(readFileSync(join(root, "CHANGELOG.md"), "utf8"));
const out = process.argv[2];
if (out) writeFileSync(out, `${notes.body}\n`);
console.log(notes.version);
