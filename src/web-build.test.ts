import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

// web/aw.js is a generated artifact (bun build web/aw.ts). This guard fails
// when the checked-in bundle is stale; regenerate with `bun run build:web`.
test("web/aw.js matches a fresh build of web/aw.ts", async () => {
	const result = await Bun.build({
		entrypoints: ["web/aw.ts"],
		target: "browser",
		format: "esm",
	});
	const fresh = await result.outputs[0]?.text();
	const committed = await readFile("web/aw.js", "utf8");
	expect(committed).toBe(fresh);
});
