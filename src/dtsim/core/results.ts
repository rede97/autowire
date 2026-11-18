// `dtsim results`: read .result symlinks, or re-grade every seed in place.
import { readdirSync, readlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { loadWorkspace, mergeCase } from "./config.ts";
import { gradeSeed } from "./engine.ts";
import { writeResultMarker } from "./scripts.ts";
import { status, table } from "./ui.ts";

export type ResultRow = { dir: string; status: string };

export function collectResults(dir: string): ResultRow[] {
	const rows: ResultRow[] = [];
	const walk = (current: string): void => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isSymbolicLink() && entry.name === ".result") {
				rows.push({ dir: current, status: readlinkSync(path) });
			} else if (entry.isDirectory() && !entry.name.startsWith("compile_g")) {
				walk(path);
			}
		}
	};
	walk(dir);
	return rows.sort((a, b) => a.dir.localeCompare(b.dir));
}

export async function resultsCommand(opts: {
	dir: string;
	recheck: boolean;
	csv: boolean;
	config?: string;
}): Promise<number> {
	const rows = collectResults(opts.dir);
	if (opts.recheck) {
		const ws = await loadWorkspace({ config: opts.config });
		for (const row of rows) {
			const caseId = basename(dirname(row.dir));
			const seed = basename(row.dir);
			try {
				const c = mergeCase(ws, caseId);
				const log = join(row.dir, "sim.log");
				row.status = (await gradeSeed(ws, c, row.dir, log, seed)).status;
			} catch {
				row.status = "FAIL";
			}
			writeResultMarker(row.dir, row.status);
			if (seed.length === 0) row.status = "FAIL";
		}
	}
	if (opts.csv) {
		for (const row of rows) console.log(`${row.dir},${row.status}`);
	} else if (rows.length > 0) {
		console.log(
			table(
				rows.map((r) => [status(r.status), r.dir]),
				["Status", "Seed dir"],
				120,
			),
		);
	}
	const counts = new Map<string, number>();
	for (const row of rows)
		counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
	// `STATUS=n` stays plain: scripts grep it.
	console.log(
		[...counts.entries()]
			.sort()
			.map(([s, n]) => `${s}=${n}`)
			.join(" "),
	);
	return rows.every(
		(r) => r.status === "PASS" || r.status === "PASS WITH ERRORS",
	)
		? 0
		: 1;
}
