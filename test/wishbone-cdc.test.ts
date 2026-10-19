import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verilatorSim, verilatorTest } from "./fixtures/verilator.ts";

for (const half of [3, 11]) {
	for (const apb of [false, true]) {
		verilatorTest(
			`CDC ${apb ? "APB" : "WB"}: posted writes, read fences and coordinated reset (${half})`,
			() => {
				const dir = mkdtempSync(join(tmpdir(), "aw-cdc-boundary-"));
				try {
					const result = verilatorSim({
						dir: join(dir, "obj"),
						top: "tb",
						args: [`-GHALF=${half}`, `-GAPB=${apb ? 1 : 0}`],
						sources: [
							join(import.meta.dir, "fixtures/wb_cdc_boundary_tb.sv"),
							...["wb_sync_cell", "wb_async_fifo", "wb_cdc", "wb_apb2wb"].map(
								(name) =>
									join(
										import.meta.dir,
										`../docs/plugins/rtl/${name}_template.sv`,
									),
							),
						],
					});
					expect(result.buildOk, result.buildLog).toBe(true);
					expect(result.exitCode, result.stdout + result.stderr).toBe(0);
					expect(result.stdout).toContain("PASS");
				} finally {
					rmSync(dir, { recursive: true, force: true });
				}
			},
			180_000,
		);
	}
}
