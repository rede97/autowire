// `dtsim results`: read .result symlinks, or re-grade every seed in place.
import { readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { loadWorkspace, mergeCase } from "./config.ts";
import { gradeLog, waiveRuleMap } from "./grade.ts";
import { runHook } from "./hooks.ts";
import { writeResultMarker } from "./scripts.ts";

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
		const rules = waiveRuleMap(ws.waive);
		for (const row of rows) {
			const caseId = row.dir.split("/").at(-2) ?? "";
			const seed = row.dir.split("/").at(-1) ?? "";
			try {
				const c = mergeCase(ws, caseId);
				if (ws.hooks.onGrade) {
					const outcome = await runHook(ws.hooks.onGrade, {
						phase: "onGrade",
						caseId,
						seed,
						dir: row.dir,
						verify: ws.verify,
						tool: ws.toolId,
						log: join(row.dir, "sim.log"),
						env: process.env as Record<string, string>,
					});
					row.status = outcome.firstLine || "FAIL";
				} else {
					row.status = gradeLog(
						join(row.dir, "sim.log"),
						c.grade,
						rules,
					).status;
				}
			} catch {
				row.status = "FAIL";
			}
			writeResultMarker(row.dir, row.status);
			if (seed.length === 0) row.status = "FAIL";
		}
	}
	for (const row of rows) {
		console.log(
			opts.csv ? `${row.dir},${row.status}` : `${row.status}\t${row.dir}`,
		);
	}
	const counts = new Map<string, number>();
	for (const row of rows)
		counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
	console.log(
		[...counts.entries()]
			.sort()
			.map(([status, n]) => `${status}=${n}`)
			.join(" "),
	);
	return rows.every(
		(r) => r.status === "PASS" || r.status === "PASS WITH ERRORS",
	)
		? 0
		: 1;
}
