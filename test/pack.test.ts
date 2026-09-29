import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
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
		// ip/ ships only the filelist closure, with demo patches applied.
		expect(
			files.some((f) => f.path === "demo/soc/ip/picorv32/picorv32.v"),
		).toBe(true);
		expect(files.some((f) => f.path === "demo/soc/ip/sha256/sha256.v")).toBe(
			true,
		);
		expect(files.some((f) => f.path.startsWith("demo/soc/ip/sdspi/doc/"))).toBe(
			false,
		);
		expect(files.some((f) => f.path === "demo/soc/ip/picorv32/README.md")).toBe(
			false,
		);
		const sdspi = files.find(
			(f) => f.path === "demo/soc/ip/sdspi/rtl/spi/sdspi.v",
		);
		expect(new TextDecoder().decode(sdspi?.bytes)).toContain("(!dly_stb)");
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
			const runSh = statSync(join(dest, "demo/soc/sim/vcs/run.sh"));
			expect(runSh.mode & 0o111).not.toBe(0);
		} finally {
			rmSync(dest, { recursive: true, force: true });
		}
		// zstd-22 on the real ~11MB tree takes ~4s; default 5s timeout is too tight.
	}, 30000);
});
