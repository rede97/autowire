// `autowire plugin generate` — type-A plugin generators.

import type { Command } from "commander";
import {
	PLUGIN_ID as BUS_PLUGIN_ID,
	generateAll as generateBusAll,
} from "../plugins/wishbone-bus/generate.ts";
import {
	generateAll as generateRegfileAll,
	PLUGIN_ID as REGFILE_PLUGIN_ID,
} from "../plugins/wishbone-regfile/generate.ts";
import { requireWorkspace } from "./shared.ts";

const KNOWN = [REGFILE_PLUGIN_ID, BUS_PLUGIN_ID] as const;

export function registerPlugin(program: Command): void {
	const plugin = program
		.command("plugin")
		.description("Type-A plugin generators (docs/plugins/)");

	plugin
		.command("generate")
		.description("Run a type-A generator into [dump] plugins_dir/<plugin-id>/")
		.argument(
			"[plugin-id]",
			`plugin id (default: ${REGFILE_PLUGIN_ID}; or "all")`,
			REGFILE_PLUGIN_ID,
		)
		.option(
			"--workspace <path>",
			"workspace dir or autowire.toml path (default: search upward from CWD)",
		)
		.action(async (pluginId: string, opts: { workspace?: string }) => {
			const ws = await requireWorkspace(opts.workspace ?? process.cwd());
			const ids = pluginId === "all" ? [...KNOWN] : ([pluginId] as string[]);
			for (const id of ids) {
				if (id === REGFILE_PLUGIN_ID) {
					if (ws.regfileSources.length === 0) {
						if (pluginId !== "all") {
							console.error(
								`autowire.toml: no [regfile.<source_id>] ts= for ${id}`,
							);
							process.exit(1);
						}
						continue;
					}
					try {
						const paths = await generateRegfileAll(ws, ws.regfileSources);
						for (const p of paths) console.log(p);
					} catch (e) {
						console.error(e instanceof Error ? e.message : e);
						process.exit(1);
					}
				} else if (id === BUS_PLUGIN_ID) {
					if (ws.busSources.length === 0) {
						if (pluginId !== "all") {
							console.error(
								`autowire.toml: no [bus.<source_id>] ts= for ${id}`,
							);
							process.exit(1);
						}
						continue;
					}
					try {
						const paths = await generateBusAll(ws, ws.busSources);
						for (const p of paths) console.log(p);
					} catch (e) {
						console.error(e instanceof Error ? e.message : e);
						process.exit(1);
					}
				} else {
					console.error(
						`unknown plugin id "${id}" (v1: ${KNOWN.join(", ")}, or all)`,
					);
					process.exit(1);
				}
			}
		});
}
