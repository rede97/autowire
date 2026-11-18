#!/usr/bin/env bun
// autowire CLI entry (bun). Commands:
//   help [topic]  command index (default); Agent contract: help agent
//   init <name>   create default autowire.toml in CWD              (src/cli/analysis.ts)
//   analysis run      hdxml from autowire.toml                  (src/cli/analysis.ts)
//   analysis deps     RTL module dependency tree                (src/cli/analysis.ts)
//   connect run       happy-dom scripts, check, then write .sv  (src/cli/web.ts)
//   connect check     author-face validation (no write)         (src/cli/web.ts)
//   connect web       static session page                       (src/cli/web.ts)
//   dtsim ...         simulation runner; also the `dtsim` name  (src/cli/dtsim.ts)

import { Command } from "commander";
import { registerAnalysis } from "./src/cli/analysis.ts";
import { registerDocs } from "./src/cli/docs.ts";
import {
	invokedAsDtsim,
	registerDtsim,
	runDtsimMain,
} from "./src/cli/dtsim.ts";
import { renderHelp } from "./src/cli/help.ts";
import { registerPlugin } from "./src/cli/plugin.ts";
import { registerUpdate } from "./src/cli/update.ts";
import { formatRelease, releaseStamp } from "./src/cli/version.ts";
import { registerConnect } from "./src/cli/web.ts";

if (invokedAsDtsim()) {
	// Multi-call: `ln -s autowire.js dtsim` runs `autowire dtsim` directly.
	await runDtsimMain(process.argv);
} else {
	const program = new Command();
	program
		.name("autowire")
		.version(formatRelease())
		.description(
			"RTL register and connectivity tool. Agents: run `help agent`; do not invent a project prompt.",
		)
		.addHelpText(
			"after",
			"\nCommands:  bun index.ts help\nAgent contract:  bun index.ts help agent\nTopics:  bun index.ts help topics\n",
		);

	program.addHelpCommand(false);
	program
		.command("help")
		.description("Command index (default) or topic help; Agents: help agent")
		.argument(
			"[topic]",
			"agent | status | workspace | analysis | connect | web | dump | cli | deps | dont | dtsim | topics",
		)
		.action((topic?: string) => {
			try {
				console.log(renderHelp(topic));
			} catch (e) {
				console.error(e instanceof Error ? e.message : e);
				process.exit(1);
			}
		});

	registerAnalysis(program);
	registerConnect(program);
	registerPlugin(program);
	registerDocs(program);
	registerUpdate(program);
	registerDtsim(program);

	if (process.argv.slice(2).length === 0) {
		// Command index first, then who/what/where (version + project link).
		console.log(renderHelp());
		console.log(
			`\nhttps://github.com/rede97/autowire — autowire ${releaseStamp().version}`,
		);
	} else {
		try {
			await program.parseAsync();
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
	}
}
