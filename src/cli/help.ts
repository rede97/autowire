// Command and topic help. The text lives in help/<topic>.txt.
// Print: `bun index.ts help` | `bun index.ts help agent` | `autowire help <topic>`
// These imports are inlined into autowire.js, so `help` works before `docs unpack`.

import agent from "../../help/agent.txt" with { type: "text" };
import analysis from "../../help/analysis.txt" with { type: "text" };
import cdp from "../../help/cdp.txt" with { type: "text" };
import check from "../../help/check.txt" with { type: "text" };
import cli from "../../help/cli.txt" with { type: "text" };
import connect from "../../help/connect.txt" with { type: "text" };
import deps from "../../help/deps.txt" with { type: "text" };
import docs from "../../help/docs.txt" with { type: "text" };
import dont from "../../help/dont.txt" with { type: "text" };
import dump from "../../help/dump.txt" with { type: "text" };
import index from "../../help/index.txt" with { type: "text" };
import initAttach from "../../help/init-attach.txt" with { type: "text" };
import status from "../../help/status.txt" with { type: "text" };
import topics from "../../help/topics.txt" with { type: "text" };
import web from "../../help/web.txt" with { type: "text" };
import workspace from "../../help/workspace.txt" with { type: "text" };

export const HELP_TOPICS = [
	"agent",
	"status",
	"workspace",
	"analysis",
	"connect",
	"web",
	"check",
	"dump",
	"cli",
	"deps",
	"dont",
	"docs",
	"cdp",
] as const;

export type HelpTopic = (typeof HELP_TOPICS)[number];

/** Printed by `init` after it writes. The full setup conversation is help/agent.txt. */
export const INIT_ATTACH_NOTE = initAttach.trimEnd();

const SECTIONS: Record<HelpTopic, string> = {
	agent,
	status,
	workspace,
	analysis,
	connect,
	web,
	check,
	dump,
	cli,
	deps,
	dont,
	docs,
	cdp,
};

function finish(text: string): string {
	const body = text.trimEnd();
	return `${body}\n`;
}

/** Default `autowire help` — command index + one-line Agent pointer. */
export function renderHelp(topic?: string): string {
	if (topic === "topics") return finish(topics);
	if (!topic) return finish(index);
	if ((HELP_TOPICS as readonly string[]).includes(topic)) {
		return finish(SECTIONS[topic as HelpTopic]);
	}
	throw new Error(`unknown help topic: ${topic}\n\n${finish(topics)}`);
}
