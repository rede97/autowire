import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

// out/web/aw.js is a generated artifact (bun build src/core/aw.ts). This guard
// fails when the local bundle is stale; regenerate with `bun run build:web`.
test("out/web/aw.js matches a fresh build of src/core/aw.ts", async () => {
	const result = await Bun.build({
		entrypoints: ["src/core/aw.ts", "src/web/page.ts"],
		external: ["/aw.js", "*/aw.js"],
		target: "browser",
		format: "esm",
		minify: true,
	});
	expect(result.outputs).toHaveLength(2);
	for (const output of result.outputs) {
		const name = basename(output.path);
		if (!name) throw new Error("unnamed build output");
		expect(await readFile(`out/web/${name}`, "utf8")).toBe(await output.text());
	}
});
