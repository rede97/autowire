import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LeafDb } from "../src/rtl/leaf.ts";
import { loadRtlIndex } from "../src/rtl/rtlindex.ts";

// Self-contained JSON reader coverage (JSON is experimental; the demos stay on
// XML, so CI would otherwise never exercise the JSON path).

const INDEX = {
	tool: "hdxml 0.4.0",
	generated: 1,
	definesFp: "fp",
	incdirsFp: "fp2",
	defines: [
		{ name: "SYNTH", value: "1" },
		{ name: "RAW_M", raw: true },
	],
	files: [
		{
			source: "/w/rtl/top.sv",
			index: "rtl/top.sv.json",
			status: "ok",
			modules: 1,
			mtime: 7,
		},
	],
	modules: [{ name: "top", index: "rtl/top.sv.json" }],
	packages: [],
	hierarchy: [{ module: "top", blackbox: false, cycle: false, children: [] }],
};

const LEAF = {
	source: "/w/rtl/top.sv",
	mtime: 7,
	srcSize: 10,
	srcHash: "h",
	modules: [
		{
			name: "top",
			kind: "module",
			span: "0:10",
			contentHash: "c",
			normHash: "n",
			interfaceSig: "s",
			params: [
				{
					name: "W",
					kind: "parameter",
					dataType: "int",
					default: "8",
					span: "1:2",
				},
			],
			// declaration order on purpose: output first — the JSON reader must
			// regroup into PORT_DIRS order like the XML reader does
			ports: [
				{
					name: "o",
					dir: "output",
					dataType: "logic",
					packed: "[W-1:0]",
					span: "3:4",
				},
				{ name: "clk", dir: "input", span: "5:6" },
			],
			imports: [{ package: "pkg", symbol: "*" }],
		},
	],
};

describe("RtlIndex JSON readers (experimental)", () => {
	test("loadRtlIndex + LeafDb read the JSON mirror with XML-equivalent shapes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "aw-rtjson-"));
		mkdirSync(join(dir, "rtl"), { recursive: true });
		writeFileSync(join(dir, "index.json"), JSON.stringify(INDEX));
		writeFileSync(join(dir, "rtl/top.sv.json"), JSON.stringify(LEAF));

		const idx = await loadRtlIndex(dir, "json");
		expect(idx.tool).toBe("hdxml 0.4.0");
		expect(idx.defines).toEqual({ SYNTH: "1", RAW_M: null });
		expect(idx.files[0]?.status).toBe("ok");
		expect(idx.moduleSource.get("top")).toBe("/w/rtl/top.sv");
		expect(idx.tops[0]?.module).toBe("top");

		const leaf = await new LeafDb(dir, "json").get("top");
		expect(leaf?.params[0]).toMatchObject({
			name: "W",
			dataType: "int",
			defaultText: "8",
		});
		// input group comes before output (PORT_DIRS order, same as XML path)
		expect(leaf?.ports.map((p) => p.name)).toEqual(["clk", "o"]);
		expect(leaf?.ports[1]).toMatchObject({ dir: "output", packed: "[W-1:0]" });
		expect(leaf?.imports).toEqual([{ package: "pkg", symbol: "*" }]);
	});
});
