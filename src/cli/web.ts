// `autowire connect` — local run, rule check, and the static web session.
// docs/cli.md section 2.

import type { Command } from "commander";
import { check as awCheck } from "../core/aw.ts";
import { buildEngineCtx, topoUnits } from "../core/connect.ts";
import {
	loadLiveUnitDoc,
	type RenderedUnit,
	renderUnit,
} from "../core/happydom.ts";
import { LeafDb } from "../rtl/leaf.ts";
import { startWeb } from "../web/server.ts";
import { allUnits, findUnit, type WorkspaceConfig } from "../workspace.ts";
import { requireWorkspace } from "./shared.ts";

export function registerConnect(program: Command): void {
	const connect = program
		.command("connect")
		.description(
			"Connect HTML: run writes .sv, check reports rules, web is a session",
		);

	connect
		.command("run")
		.description("happy-dom: scripts, check, elaborate, then write .sv")
		.argument("[unit]", "unit id (default: all units, deps first)")
		.option(
			"--workspace <path>",
			"workspace dir or autowire.toml path (default: search upward from CWD)",
		)
		.option("--force", "rewrite outputs even when the bytes already match")
		.action(
			async (
				unit: string | undefined,
				opts: { workspace?: string; force?: boolean },
			) => {
				const cfg = await requireWorkspace(opts.workspace ?? process.cwd());
				const selected = selectUnits(cfg, unit);
				const leafDb = new LeafDb(cfg.indexDir);
				const session = new Map<string, RenderedUnit>();
				for (const u of selected) {
					const rendered = await renderUnit(
						cfg,
						u,
						leafDb,
						session,
						opts.force ?? false,
					);
					session.set(u.id, rendered);
					for (const w of rendered.warnings)
						console.warn(`${u.id}: warning: ${w}`);
					for (const file of rendered.files) console.log(file);
				}
			},
		);

	connect
		.command("check")
		.description("Validate author-face connect/sim HTML and deps (no write)")
		.argument("[unit]", "unit id (default: all units, deps first)")
		.option(
			"--workspace <path>",
			"workspace dir or autowire.toml path (default: search upward from CWD)",
		)
		.action(async (unit: string | undefined, opts: { workspace?: string }) => {
			const cfg = await requireWorkspace(opts.workspace ?? process.cwd());
			const units = selectUnits(cfg, unit, false);
			const leafDb = new LeafDb(cfg.indexDir);
			const all = allUnits(cfg);
			let failed = false;
			for (const u of units) {
				// Static check: do not run scripts and do not call on-init.
				const { win, doc } = await loadLiveUnitDoc(cfg, u, {
					scripts: false,
				});
				try {
					const built = await buildEngineCtx(cfg, u, all, leafDb);
					await built.prewarm(doc as never);
					const res = awCheck(doc as never, built.ctx);
					const errors = [...built.errors, ...res.errors];
					for (const w of res.warnings) console.warn(`${u.id}: warning: ${w}`);
					for (const e of errors) console.error(`${u.id}: error: ${e}`);
					if (errors.length > 0) failed = true;
					else
						console.log(
							`${u.id}: check ok (${res.warnings.length} warning(s))`,
						);
				} finally {
					await win.happyDOM.close();
				}
			}
			if (failed) process.exit(1);
		});

	connect
		.command("elaborate")
		.description(
			"Classic scripts, then elaborate (on-init / on-template); no write",
		)
		.argument("[unit]", "unit id (default: all units, deps first)")
		.option(
			"--workspace <path>",
			"workspace dir or autowire.toml path (default: search upward from CWD)",
		)
		.action(async (unit: string | undefined, opts: { workspace?: string }) => {
			const cfg = await requireWorkspace(opts.workspace ?? process.cwd());
			const selected = selectUnits(cfg, unit);
			const leafDb = new LeafDb(cfg.indexDir);
			const session = new Map<string, RenderedUnit>();
			let failed = false;
			for (const u of selected) {
				try {
					const rendered = await renderUnit(
						cfg,
						u,
						leafDb,
						session,
						false,
						false,
					);
					session.set(u.id, rendered);
					for (const w of rendered.warnings)
						console.warn(`${u.id}: warning: ${w}`);
					console.log(`${u.id}: elaborate ok`);
				} catch (error) {
					failed = true;
					console.error(error instanceof Error ? error.message : error);
				}
			}
			if (failed) process.exit(1);
		});

	connect
		.command("web")
		.description(
			"Static connect page (127.0.0.1). The session does not write files.",
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
				console.log(`autowire connect web: ${url} (unit ${defaultUnit})`);
				if (defaultUnit) {
					const id = encodeURIComponent(defaultUnit);
					console.log(`  frontend: ${url}?unit=${id}`);
					console.log(`  headless: ${url}?ui=min&unit=${id}`);
				}
			},
		);
}

function selectUnits(
	cfg: WorkspaceConfig,
	unit: string | undefined,
	withDeps = true,
) {
	const all = allUnits(cfg);
	if (!unit) {
		const units = topoUnits(all);
		if (units.length === 0) {
			console.error("no [connect.<id>] / [sim.<id>] units configured");
			process.exit(1);
		}
		return units;
	}
	if (!findUnit(cfg, unit)) {
		console.error(`unknown unit "${unit}"`);
		process.exit(1);
	}
	if (!withDeps) return all.filter((u) => u.id === unit);
	const wanted = new Set<string>();
	const visit = (id: string) => {
		if (wanted.has(id)) return;
		wanted.add(id);
		for (const dep of findUnit(cfg, id)?.deps ?? []) visit(dep);
	};
	visit(unit);
	return topoUnits(all).filter((u) => wanted.has(u.id));
}
