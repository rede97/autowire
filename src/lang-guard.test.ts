import { describe, expect, test } from "bun:test";

// Language rule (see AGENTS.md): comments and messages in code/config are English-only.
// Biome has no language rule, so this guard fails the suite on CJK in TypeScript sources.
const CJK =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

describe("language guard", () => {
	test("no CJK in TypeScript sources", async () => {
		const files = ["index.ts", ...new Bun.Glob("src/**/*.ts").scanSync()];
		const offenders: string[] = [];
		for (const f of files) {
			const text = await Bun.file(f).text();
			for (const [i, line] of text.split("\n").entries()) {
				if (CJK.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});
