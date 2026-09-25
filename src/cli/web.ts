// `autowire web [unit]` + `autowire check [unit]` — connect page server and
// author-face validation (docs/workspace/web-ui.md).

import type { Command } from "commander";
import { check as awCheck } from "../core/aw.ts";
import { buildEngineCtx, loadUnitDoc, topoUnits } from "../core/connect.ts";
import { renderUnit } from "../core/happydom.ts";
import { LeafDb } from "../rtl/leaf.ts";
import { startWeb } from "../web/server.ts";
import { allUnits, findUnit } from "../workspace.ts";
import { requireWorkspace } from "./shared.ts";

export function registerWeb(program: Command): void {
	program
		.command("web")
		.description(
			"Local connect page (127.0.0.1 only; docs/workspace/web-ui.md)",
		)
		.argument(
			"[unit]",
			"connect/sim unit id or author HTML path (default: first unit in deps topo order)",
		)
		.option(
			"--workspace <path>",
			"workspace dir or autowire.toml path (default: search upward from CWD)",
		)
		.option("--port <n>", "TCP port (default: random)", (v) => Number(v))
		.action(
			async (
				unit: string | undefined,
				opts: { workspace?: string; port?: number },
			) => {
				const cfg = await requireWorkspace(opts.workspace ?? process.cwd());
				const units = allUnits(cfg);
				if (units.length === 0) {
					console.error(
						"autowire.toml: no [connect.<id>] / [sim.<id>] units configured",
					);
					process.exit(1);
				}
				let defaultUnit: string | null = null;
				if (unit) {
					const byId = units.find((u) => u.id === unit);
					const byHtml = units.find(
						(u) => u.html === unit || u.html.endsWith(`/${unit}`),
					);
					defaultUnit = (byId ?? byHtml)?.id ?? null;
					if (!defaultUnit) {
						console.error(
							`unknown unit "${unit}" (have: ${units.map((u) => u.id).join(", ")})`,
						);
						process.exit(1);
					}
				} else {
					defaultUnit = topoUnits(units)[0]?.id ?? null;
				}
				const url = await startWeb(cfg, opts.port ?? 0, defaultUnit);
				console.log(`autowire web: ${url} (unit ${defaultUnit})`);
				console.log(
					"GET actions: ?check=1 | ?render=1 | ?dump=1 | ?select=MOD&… — see help web",
				);
			},
		);
}

export function registerCheck(program: Command): void {
	program
		.command("check")
		.description(
			"Validate author-face connect/sim HTML + deps (no write; docs/workspace/web-ui.md §3.1)",
		)
		.argument(
			"[unit]",
			"unit id (default: all connect+sim units in deps topo order)",
		)
		.option(
			"--workspace <path>",
			"workspace dir or autowire.toml path (default: search upward from CWD)",
		)
		.action(async (unit: string | undefined, opts: { workspace?: string }) => {
			const cfg = await requireWorkspace(opts.workspace ?? process.cwd());
			const all = allUnits(cfg);
			const units = unit ? all.filter((u) => u.id === unit) : topoUnits(all);
			if (units.length === 0) {
				console.error(
					unit
						? `unknown unit "${unit}"`
						: "no [connect.<id>] / [sim.<id>] units configured",
				);
				process.exit(1);
			}
			const leafDb = new LeafDb(cfg.indexDir);
			let failed = false;
			for (const u of units) {
				const { doc } = await loadUnitDoc(cfg, u);
				const built = await buildEngineCtx(cfg, u, all, leafDb);
				await built.prewarm(doc);
				const res = awCheck(doc as never, built.ctx);
				const errors = [...built.errors, ...res.errors];
				for (const w of res.warnings) console.warn(`${u.id}: warning: ${w}`);
				for (const e of errors) console.error(`${u.id}: error: ${e}`);
				if (errors.length > 0) failed = true;
				else
					console.log(`${u.id}: check ok (${res.warnings.length} warning(s))`);
			}
			if (failed) process.exit(1);
		});
}

export function registerRender(program: Command): void {
	program
		.command("render")
		.description(
			"happy-dom render: scripts + check → elaborate → write .sv (no browser)",
		)
		.argument("[unit]", "unit id (default: all units, deps first)")
		.option(
			"--workspace <path>",
			"workspace dir or autowire.toml path (default: search upward from CWD)",
		)
		.action(async (unit: string | undefined, opts: { workspace?: string }) => {
			const cfg = await requireWorkspace(opts.workspace ?? process.cwd());
			const all = allUnits(cfg);
			if (unit && !findUnit(cfg, unit)) {
				console.error(`unknown unit "${unit}"`);
				process.exit(1);
			}
			const wanted = new Set<string>();
			const visit = (id: string) => {
				if (wanted.has(id)) return;
				wanted.add(id);
				for (const dep of findUnit(cfg, id)?.deps ?? []) visit(dep);
			};
			if (unit) visit(unit);
			const selected = topoUnits(all).filter((u) => !unit || wanted.has(u.id));
			if (selected.length === 0) {
				console.error("no [connect.<id>] / [sim.<id>] units configured");
				process.exit(1);
			}
			const leafDb = new LeafDb(cfg.indexDir);
			const session = new Map<string, Awaited<ReturnType<typeof renderUnit>>>();
			for (const u of selected) {
				const rendered = await renderUnit(cfg, u, leafDb, session);
				session.set(u.id, rendered);
				for (const w of rendered.warnings)
					console.warn(`${u.id}: warning: ${w}`);
				for (const file of rendered.files) console.log(file);
			}
		});
}
