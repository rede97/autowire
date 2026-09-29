import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	formatGeneratedGaps,
	generatedFilelistGaps,
} from "../src/cli/analysis.ts";

test("analysis names the writer for missing dump paths", () => {
	const root = mkdtempSync(join(tmpdir(), "aw-gap-"));
	try {
		mkdirSync(join(root, "rtl"));
		writeFileSync(join(root, "rtl/hand.v"), "module hand; endmodule\n");
		writeFileSync(
			join(root, "rtl/soc.f"),
			[
				"# comment",
				"rtl/hand.v",
				"rtl/missing_hand.v",
				"rtl/gen/plugins/wishbone/bus/soc_wb_interconnect.sv",
				"rtl/gen/connect/soc_top.sv",
				"rtl/gen/sim/tb_soc.sv",
				"",
			].join("\n"),
		);
		const gaps = generatedFilelistGaps({
			root,
			filelists: ["rtl/soc.f"],
			pluginsDir: join(root, "rtl/gen/plugins"),
			connectDir: join(root, "rtl/gen/connect"),
			simDir: join(root, "rtl/gen/sim"),
		});
		expect(gaps.map((gap) => gap.kind)).toEqual(["plugins", "connect", "sim"]);
		expect(gaps.some((gap) => gap.path.includes("missing_hand"))).toBe(false);
		const text = formatGeneratedGaps(gaps);
		expect(text).toContain("plugin wishbone run");
		expect(text).toContain("connect run");
		expect(text).toContain("soc_wb_interconnect.sv");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
