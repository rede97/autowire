// Release stamp. Dev reads CHANGELOG.md. scripts/build-js.ts bakes the three
// fields into autowire.js with bun --define.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseChangelog } from "./changelog.ts";

export type ReleaseStamp = {
	version: string;
	commit: string;
	built: string;
};

function baked(value: string | undefined): string | undefined {
	if (value === undefined || value.length === 0) return undefined;
	return value;
}

function changelogVersion(): string {
	const path = join(import.meta.dir, "..", "..", "CHANGELOG.md");
	try {
		return parseChangelog(readFileSync(path, "utf8")).version;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`autowire version: cannot read ${path} (${detail})`);
	}
}

export function releaseStamp(): ReleaseStamp {
	return {
		version: baked(process.env.AUTOWIRE_VERSION) ?? changelogVersion(),
		commit: baked(process.env.AUTOWIRE_COMMIT) ?? "dev",
		built: baked(process.env.AUTOWIRE_BUILT) ?? "dev",
	};
}

export function formatRelease(stamp: ReleaseStamp = releaseStamp()): string {
	return `autowire ${stamp.version}\ncommit ${stamp.commit}\nbuilt ${stamp.built}`;
}
