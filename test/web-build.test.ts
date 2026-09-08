import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

// web/aw.js is a generated artifact (bun build src/core/aw.ts). This guard fails
// when the checked-in bundle is stale; regenerate with `bun run build:web`.
test("web/aw.js matches a fresh build of src/core/aw.ts", async () => {
	const result = await Bun.build({
		entrypoints: ["src/core/aw.ts", "src/web/page.ts"],
		external: ["/aw.js"],
		target: "browser",
		format: "esm",
	});
	expect(result.outputs).toHaveLength(2);
	for (const output of result.outputs) {
		const name = output.path.split("/").pop();
		if (!name) throw new Error("unnamed build output");
		expect(await readFile(`web/${name}`, "utf8")).toBe(await output.text());
	}
});
