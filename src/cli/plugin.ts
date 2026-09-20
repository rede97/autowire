// `autowire plugin generate` — type-A plugin generators.

import type { Command } from "commander";
import { generateAll, PLUGIN_ID } from "../plugins/wishbone/generate.ts";
import { requireWorkspace } from "./shared.ts";

const ALIASES = new Set(["wishbone-regfile", "wishbone-bus"]);

export function registerPlugin(program: Command): void {
	const plugin = program
		.command("plugin")
		.description("Type-A plugin generators (docs/plugins/)");

	plugin
		.command("generate")
		.description("Run a type-A generator into [dump] plugins_dir/<plugin-id>/")
		.argument(
			"[plugin-id]",
			`plugin id (default: ${PLUGIN_ID}; or "all")`,
			PLUGIN_ID,
		)
		.option(
			"--workspace <path>",
			"workspace dir or autowire.toml path (default: search upward from CWD)",
		)
		.action(async (pluginId: string, opts: { workspace?: string }) => {
			const ws = await requireWorkspace(opts.workspace ?? process.cwd());
			let id = pluginId;
			if (ALIASES.has(id)) {
				console.error(
					`plugin id "${id}" is an alias of ${PLUGIN_ID}; running ${PLUGIN_ID}`,
				);
				id = PLUGIN_ID;
			}
			const ids = id === "all" ? [PLUGIN_ID] : [id];
			for (const runId of ids) {
				if (runId !== PLUGIN_ID) {
					console.error(
						`unknown plugin id "${runId}" (v1: ${PLUGIN_ID}, or all)`,
					);
					process.exit(1);
				}
				if (ws.wishboneSources.length === 0) {
					if (pluginId !== "all") {
						console.error(
							`autowire.toml: no [wishbone.<source_id>] ts= for ${PLUGIN_ID}`,
						);
						process.exit(1);
					}
					continue;
				}
				try {
					const paths = await generateAll(ws);
					for (const p of paths) console.log(p);
				} catch (e) {
					console.error(e instanceof Error ? e.message : e);
					process.exit(1);
				}
			}
		});
}
