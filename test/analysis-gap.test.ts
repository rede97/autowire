import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	formatGeneratedGaps,
	formatMisplacedDump,
	generatedFilelistGaps,
	misplacedDumpEntries,
} from "../src/cli/analysis.ts";

function makeWorkspace(filelist: string[]): {
	root: string;
	cfg: {
		root: string;
		filelists: string[];
		pluginsDir: string;
		connectDir: string;
		simDir: string;
	};
	cleanup: () => void;
} {
	const root = mkdtempSync(join(tmpdir(), "aw-gap-"));
	mkdirSync(join(root, "rtl"), { recursive: true });
	writeFileSync(join(root, "rtl/hand.v"), "module hand; endmodule\n");
	writeFileSync(join(root, "rtl/soc.f"), `${filelist.join("\n")}\n`);
	return {
		root,
		cfg: {
			root,
			filelists: ["rtl/soc.f"],
			pluginsDir: join(root, "rtl/gen/plugins"),
			connectDir: join(root, "rtl/gen/connect"),
			simDir: join(root, "rtl/gen/sim"),
		},
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

test("analysis names the writer for missing plugins_dir leaves", () => {
	const { cfg, cleanup } = makeWorkspace([
		"# comment",
		"rtl/hand.v",
		"rtl/missing_hand.v",
		"rtl/gen/plugins/wishbone/bus/soc_wb_interconnect.sv",
	]);
	try {
		const gaps = generatedFilelistGaps(cfg);
		expect(gaps.map((gap) => gap.kind)).toEqual(["plugins"]);
		expect(gaps.some((gap) => gap.path.includes("missing_hand"))).toBe(false);
		const text = formatGeneratedGaps(gaps);
		expect(text).toContain("plugin wishbone run");
		expect(text).toContain("soc_wb_interconnect.sv");
		expect(text).not.toContain("connect run");
	} finally {
		cleanup();
	}
});

test("analysis rejects connect_dir / sim_dir entries in its filelists", () => {
	const { root, cfg, cleanup } = makeWorkspace([
		"rtl/hand.v",
		"rtl/gen/connect/soc_top.sv",
		"rtl/gen/sim/tb_soc.sv",
	]);
	try {
		// On disk or not, connect run outputs are not analysis inputs.
		mkdirSync(join(root, "rtl/gen/connect"), { recursive: true });
		writeFileSync(join(root, "rtl/gen/connect/soc_top.sv"), "// generated\n");
		expect(generatedFilelistGaps(cfg)).toEqual([]);
		expect(misplacedDumpEntries(cfg)).toEqual([
			"rtl/gen/connect/soc_top.sv",
			"rtl/gen/sim/tb_soc.sv",
		]);
		const text = formatMisplacedDump(misplacedDumpEntries(cfg));
		expect(text).toContain("connect run");
		expect(text).toContain("simulation-only filelist");
		expect(text).toContain("rtl/gen/sim/tb_soc.sv");
	} finally {
		cleanup();
	}
});
