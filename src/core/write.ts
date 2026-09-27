// Shared incremental write for generated text and bytes.
// Default: skip when the file already has the same bytes. --force rewrites.

import { readFile, writeFile } from "node:fs/promises";

export async function writeIfChanged(
	path: string,
	content: string | Uint8Array,
	force = false,
): Promise<boolean> {
	if (!force) {
		try {
			const prev = await readFile(path);
			const next =
				typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
			if (Buffer.compare(prev, next) === 0) return false;
		} catch {
			// Missing or unreadable: write it.
		}
	}
	await writeFile(path, content);
	return true;
}
