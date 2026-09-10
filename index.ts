// autowire CLI entry (bun). Commands:
//   help [topic]  command index (default); Agent contract: help agent
//   init          create default autowire.toml in CWD              (src/cli/analysis.ts)
//   analysis      run hdxml analysis with args from autowire.toml  (src/cli/analysis.ts)
//   deps <path>   RTL module dependency tree                        (src/cli/deps.ts)
//   web [unit]    local connect page (127.0.0.1)                    (src/cli/web.ts)
//   check [unit]  author-face connect validation (no write)         (src/cli/web.ts)

import { Command } from "commander";
import { registerAnalysis } from "./src/cli/analysis.ts";
import { registerDeps } from "./src/cli/deps.ts";
import { renderHelp } from "./src/cli/help.ts";
import { registerPlugin } from "./src/cli/plugin.ts";
import { registerCheck, registerWeb } from "./src/cli/web.ts";

const program = new Command();
program
	.name("autowire")
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
		"agent | status | workspace | analysis | connect | web | dump | cli | deps | dont | topics",
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
registerDeps(program);
registerWeb(program);
registerCheck(program);
registerPlugin(program);

if (process.argv.slice(2).length === 0) {
	console.log(renderHelp());
} else {
	program.parse();
}
