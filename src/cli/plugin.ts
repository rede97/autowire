// `autowire plugin <id> run` — each plugin owns its full generate.

import type { Command } from "commander";
import { generateAll, PLUGIN_ID } from "../plugins/wishbone/generate.ts";
import { requireWorkspace } from "./shared.ts";

export function registerPlugin(program: Command): void {
	const plugin = program
		.command("plugin")
		.description("Type-A plugins. Each plugin implements its own run.");

	const wishbone = plugin
		.command(PLUGIN_ID)
		.description("Wishbone regfile and bus generator");

	wishbone
		.command("run")
		.description("Generate every configured regfile and bus into plugins_dir")
		.option(
			"--workspace <path>",
			"workspace dir or autowire.toml path (default: search upward from CWD)",
		)
		.option("--force", "rewrite outputs even when the bytes already match")
		.option("--only <name>", "one [wishbone.<name>] source from autowire.toml")
		.action(
			async (opts: { workspace?: string; force?: boolean; only?: string }) => {
				const ws = await requireWorkspace(opts.workspace ?? process.cwd());
				if (ws.wishboneSources.length === 0) {
					console.error(
						`autowire.toml: no [wishbone.<source_id>] ts= for ${PLUGIN_ID}`,
					);
					process.exit(1);
				}
				try {
					const paths = await generateAll(ws, opts.only, opts.force ?? false);
					for (const p of paths) console.log(p);
				} catch (e) {
					console.error(e instanceof Error ? e.message : e);
					process.exit(1);
				}
			},
		);
}
