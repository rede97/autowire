// `autowire web [unit]` + `autowire check [unit]` — connect page server and
// author-face validation (docs/web-ui.md).

import type { Command } from "commander";
import { check as awCheck } from "../core/aw.ts";
import { buildEngineCtx, loadUnitDoc, topoUnits } from "../core/connect.ts";
import { LeafDb } from "../rtl/leaf.ts";
import { startWeb } from "../web/server.ts";
import { requireWorkspace } from "./shared.ts";

export function registerWeb(program: Command): void {
	program
		.command("web")
		.description("Local connect page (127.0.0.1 only; docs/web-ui.md)")
		.argument(
			"[unit]",
			"connect unit id or author HTML path (default: first unit in deps topo order)",
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
				if (cfg.connectUnits.length === 0) {
					console.error("autowire.toml: no [connect.<id>] units configured");
					process.exit(1);
				}
				let defaultUnit: string | null = null;
				if (unit) {
					const byId = cfg.connectUnits.find((u) => u.id === unit);
					const byHtml = cfg.connectUnits.find(
						(u) => u.html === unit || u.html.endsWith(`/${unit}`),
					);
					defaultUnit = (byId ?? byHtml)?.id ?? null;
					if (!defaultUnit) {
						console.error(
							`unknown connect unit "${unit}" (have: ${cfg.connectUnits.map((u) => u.id).join(", ")})`,
						);
						process.exit(1);
					}
				} else {
					defaultUnit = topoUnits(cfg.connectUnits)[0]?.id ?? null;
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
			"Validate author-face connect HTML + deps (no write; docs/web-ui.md §3.1)",
		)
		.argument(
			"[unit]",
			"connect unit id (default: all units in deps topo order)",
		)
		.option(
			"--workspace <path>",
			"workspace dir or autowire.toml path (default: search upward from CWD)",
		)
		.action(async (unit: string | undefined, opts: { workspace?: string }) => {
			const cfg = await requireWorkspace(opts.workspace ?? process.cwd());
			const units = unit
				? cfg.connectUnits.filter((u) => u.id === unit)
				: topoUnits(cfg.connectUnits);
			if (units.length === 0) {
				console.error(
					unit
						? `unknown connect unit "${unit}"`
						: "no [connect.<id>] units configured",
				);
				process.exit(1);
			}
			const leafDb = new LeafDb(cfg.indexDir);
			let failed = false;
			for (const u of units) {
				const { doc } = await loadUnitDoc(cfg, u);
				const built = await buildEngineCtx(cfg, u, cfg.connectUnits, leafDb);
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
