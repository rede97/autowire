import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verilatorSim, verilatorTest } from "./fixtures/verilator.ts";

const RTL = ["wb_sync_cell", "wb_async_fifo", "wb_cdc", "wb_apb2wb"].map(
	(name) => join(import.meta.dir, `../docs/plugins/rtl/${name}_template.sv`),
);

/** Build and run one fixture top against the CDC templates; expect PASS. */
function runFixture(fixture: string, args: string[]): void {
	const dir = mkdtempSync(join(tmpdir(), "aw-cdc-"));
	try {
		const result = verilatorSim({
			dir: join(dir, "obj"),
			top: "tb",
			args,
			sources: [join(import.meta.dir, `fixtures/${fixture}`), ...RTL],
		});
		expect(result.buildOk, result.buildLog).toBe(true);
		expect(result.exitCode, result.stdout + result.stderr).toBe(0);
		expect(result.stdout).toContain("PASS");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

for (const half of [3, 11]) {
	for (const apb of [false, true]) {
		verilatorTest(
			`CDC ${apb ? "APB" : "WB"}: posted writes, read fences and coordinated reset (${half})`,
			() =>
				runFixture("wb_cdc_boundary_tb.sv", [
					`-GHALF=${half}`,
					`-GAPB=${apb ? 1 : 0}`,
				]),
			180_000,
		);
	}
	verilatorTest(
		`CDC: one-sided and stopped-clock resets never replay, lost read ERRs, abandoned read drains (${half})`,
		() => runFixture("wb_cdc_reset_tb.sv", [`-GHALF=${half}`]),
		180_000,
	);
	verilatorTest(
		`APB TIMEOUT through CDC: PSLVERR, late response drained, full-FIFO write not queued (${half})`,
		() => runFixture("wb_apb_timeout_tb.sv", [`-GHALF=${half}`]),
		180_000,
	);
}
