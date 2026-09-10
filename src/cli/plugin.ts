// `autowire plugin generate` — type-A plugin generators.

import type { Command } from "commander";
import {
	generateAll,
	PLUGIN_ID,
} from "../plugins/wishbone-regfile/generate.ts";
import { requireWorkspace } from "./shared.ts";

export function registerPlugin(program: Command): void {
	const plugin = program
		.command("plugin")
		.description("Type-A plugin generators (docs/plugins/)");

	plugin
		.command("generate")
		.description("Run a type-A generator into [dump] plugins_dir/<plugin-id>/")
		.argument("[plugin-id]", `plugin id (default: ${PLUGIN_ID})`, PLUGIN_ID)
		.option(
			"--workspace <path>",
			"workspace dir or autowire.toml path (default: search upward from CWD)",
		)
		.action(async (pluginId: string, opts: { workspace?: string }) => {
			const ws = await requireWorkspace(opts.workspace ?? process.cwd());
			if (pluginId !== PLUGIN_ID) {
				console.error(
					`unknown plugin id "${pluginId}" (v1 supports only ${PLUGIN_ID})`,
				);
				process.exit(1);
			}
			if (ws.regfileSources.length === 0) {
				console.error(
					`autowire.toml: no [regfile.<source_id>] ts= entries for ${PLUGIN_ID}`,
				);
				process.exit(1);
			}
			try {
				const paths = await generateAll(ws, ws.regfileSources);
				for (const p of paths) console.log(p);
				if (ws.regfileExcelExport) {
					console.error(
						`note: [plugins.regfile] export=${ws.regfileExcelExport} (Excel emit not landed yet)`,
					);
				}
			} catch (e) {
				console.error(e instanceof Error ? e.message : e);
				process.exit(1);
			}
		});
}
