import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type VerilatorRun,
	verilatorSim,
	verilatorTest,
} from "./fixtures/verilator.ts";

const rtl = (name: string) =>
	join(import.meta.dir, `../docs/plugins/rtl/${name}_template.sv`);
const fixture = (name: string) => join(import.meta.dir, `fixtures/${name}`);
const ADAPTER = "-DAUTOWIRE_SYNC_CELL=tb_sync_cell_adapter";

function sim(sources: string[], args: string[]): VerilatorRun {
	const dir = mkdtempSync(join(tmpdir(), "aw-sync-cell-"));
	try {
		return verilatorSim({ dir: join(dir, "obj"), top: "tb", args, sources });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function expectPass(r: VerilatorRun): void {
	expect(r.buildOk, r.buildLog).toBe(true);
	expect(r.exitCode, r.stdout + r.stderr).toBe(0);
	expect(r.stdout).toContain("PASS");
}

for (const cell of [false, true]) {
	for (const [stages, width, resetVal] of [
		[2, 1, 0],
		[2, 4, 1],
		[3, 5, 0],
	] as const) {
		verilatorTest(
			`wb_sync_cell ${cell ? "AUTOWIRE_SYNC_CELL adapter" : "built-in"}: STAGES=${stages} WIDTH=${width} RESET_VAL=${resetVal}`,
			() =>
				expectPass(
					sim(
						[
							fixture("wb_sync_cell_tb.sv"),
							rtl("wb_sync_cell"),
							...(cell ? [fixture("sync_cell_adapter.sv")] : []),
						],
						[
							`-GSTAGES=${stages}`,
							`-GWIDTH=${width}`,
							`-GRESET_VAL=${resetVal}`,
							...(cell ? [ADAPTER] : []),
						],
					),
				),
			180_000,
		);
	}
}

verilatorTest(
	"wb_sync_cell: a selected but missing cell fails the build (no fallback)",
	() => {
		const r = sim(
			[fixture("wb_sync_cell_tb.sv"), rtl("wb_sync_cell")],
			["-DAUTOWIRE_SYNC_CELL=NO_SUCH_SYNC_CELL"],
		);
		expect(r.buildOk).toBe(false);
		expect(r.buildLog).toContain("NO_SUCH_SYNC_CELL");
	},
	180_000,
);

// The whole CDC path (FIFO pointer sync, reset release, link detect) on the
// selected cell, with one extra flop of synchronizer latency.
for (const tb of ["wb_cdc_reset_tb.sv", "wb_apb_timeout_tb.sv"]) {
	verilatorTest(
		`CDC on AUTOWIRE_SYNC_CELL adapter: ${tb}`,
		() =>
			expectPass(
				sim(
					[
						fixture(tb),
						fixture("sync_cell_adapter.sv"),
						...["wb_sync_cell", "wb_async_fifo", "wb_cdc", "wb_apb2wb"].map(
							rtl,
						),
					],
					["-GHALF=3", ADAPTER],
				),
			),
		180_000,
	);
}
