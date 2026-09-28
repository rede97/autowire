// Top entry of CHANGELOG.md is the release version and the GitHub Release notes.
// hdxml keeps its own version in hdxml/Cargo.toml; this file never touches it.

export type ChangelogEntry = {
	version: string;
	date: string;
	body: string;
};

const HEADING = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})\s*$/;

export function parseChangelog(text: string): ChangelogEntry {
	const lines = text.split("\n");
	const start = lines.findIndex((line) => HEADING.test(line));
	if (start < 0) {
		throw new Error("CHANGELOG.md: expected a heading ## [x.y.z] - YYYY-MM-DD");
	}
	const found = HEADING.exec(lines[start] ?? "");
	if (!found?.[1] || !found[2]) {
		throw new Error("CHANGELOG.md: unreadable version heading");
	}
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (lines[i]?.startsWith("## ")) {
			end = i;
			break;
		}
	}
	return {
		version: found[1],
		date: found[2],
		body: lines
			.slice(start + 1, end)
			.join("\n")
			.trim(),
	};
}
