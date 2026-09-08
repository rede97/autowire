import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

// web/aw.js is a generated artifact (bun build src/core/aw.ts). This guard fails
// when the checked-in bundle is stale; regenerate with `bun run build:web`.
test("web/aw.js matches a fresh build of src/core/aw.ts", async () => {
	const result = await Bun.build({
		entrypoints: ["src/core/aw.ts"],
		target: "browser",
		format: "esm",
	});
	const output = result.outputs[0];
	if (!output) throw new Error("bun build produced no output");
	const fresh = await output.text();
	const committed = await readFile("web/aw.js", "utf8");
	expect(committed).toBe(fresh);
});
