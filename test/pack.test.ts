import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	collectPackFiles,
	decodePack,
	encodePack,
	unpackPack,
} from "../src/cli/pack.ts";

describe("docs pack", () => {
	test("round trip keeps docs and every demo", async () => {
		const root = join(import.meta.dir, "..");
		const files = await collectPackFiles(root);
		expect(files.some((file) => file.path === "docs/cli.md")).toBe(true);
		expect(files.some((file) => file.path === "AGENTS.md")).toBe(true);
		expect(files.some((file) => file.path.startsWith("demo/soc/"))).toBe(true);
		expect(files.some((file) => file.path.startsWith("demo/hbm/"))).toBe(true);
		expect(files.some((file) => file.path.includes(".autowire"))).toBe(false);
		const again = decodePack(encodePack(files));
		expect(again.map((file) => file.path)).toEqual(
			files.map((file) => file.path),
		);
		const dest = mkdtempSync(join(tmpdir(), "aw-docs-"));
		try {
			const written = await unpackPack(again, dest);
			expect(written.length).toBe(files.length);
			expect(await Bun.file(join(dest, "AGENTS.md")).text()).toContain(
				"Autowire",
			);
			expect(await Bun.file(join(dest, "docs/cli.md")).text()).toContain(
				"connect",
			);
		} finally {
			rmSync(dest, { recursive: true, force: true });
		}
	});
});
