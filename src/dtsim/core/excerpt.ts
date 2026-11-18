// Error excerpts: on a non-clean result, capture the interesting lines
// instead of dumping the whole log. Full log always stays in the case dir.
// The log is scanned in a worker (scanLog), so its size does not matter.
import { existsSync, readFileSync } from "node:fs";
import { type LineScanner, scanLog } from "../dsl/index.ts";

const MAX_EXCERPT = 40;

type ExcerptArg = {
	toolErrors: Array<{ source: string; flags: string }>;
	highlight: readonly string[];
	max: number;
	tail: number;
};

/** Tool error lines and grader highlights, in log order; the last `tail`
 *  lines fill a short excerpt. Self-contained: it runs in a worker. */
export function excerptScanner(arg: ExcerptArg): LineScanner<string[]> {
	const res = arg.toolErrors.map((r) => new RegExp(r.source, r.flags));
	const highlight = new Set(arg.highlight);
	const picked: Array<{ i: number; line: string }> = [];
	const ring: Array<{ i: number; line: string }> = [];
	let truncated = false;
	let i = 0;
	return {
		push(line) {
			if (highlight.has(line) || res.some((re) => re.test(line))) {
				if (picked.length < arg.max) picked.push({ i, line });
				else truncated = true;
			}
			ring.push({ i, line });
			if (ring.length > arg.tail) ring.shift();
			i += 1;
		},
		finish() {
			const taken = new Set(picked.map((p) => p.i));
			const all =
				picked.length < 8
					? [...picked, ...ring.filter((r) => !taken.has(r.i))]
					: picked;
			const out = all.sort((a, b) => a.i - b.i).map((p) => p.line);
			return truncated ? [...out, "(excerpt truncated)"] : out;
		},
	};
}

/** Excerpt lines of `log`; empty when the log does not exist. */
export async function excerptLines(
	log: string,
	toolErrors: readonly RegExp[],
	highlight: readonly string[] = [],
): Promise<string[]> {
	if (!existsSync(log)) return [];
	return scanLog(log, excerptScanner, {
		toolErrors: toolErrors.map((re) => ({
			source: re.source,
			flags: re.flags,
		})),
		highlight,
		max: MAX_EXCERPT,
		tail: 15,
	});
}

export type ExcerptInput = {
	status: string;
	phase: "compile" | "sim" | "hook";
	exitCode?: number;
	tool: string;
	caseId: string;
	seed?: string;
	log: string;
	/** Grader report rows. */
	details?: ReadonlyArray<readonly [string, string]>;
	/** Grader-chosen log lines. */
	highlight?: readonly string[];
	toolErrors?: readonly RegExp[];
	hookLog?: string;
};

export async function formatExcerpt(input: ExcerptInput): Promise<string> {
	const header = [
		`status: ${input.status}`,
		`phase: ${input.phase}`,
		...(input.exitCode === undefined ? [] : [`exit: ${input.exitCode}`]),
		`tool: ${input.tool}`,
		`case: ${input.caseId}`,
		...(input.seed === undefined ? [] : [`seed: ${input.seed}`]),
		`log: ${input.log}`,
		"",
	];
	if (input.phase === "hook") {
		let tail: string[] = [];
		try {
			tail = readFileSync(input.hookLog ?? input.log, "utf8")
				.split("\n")
				.slice(-20);
		} catch {
			tail = ["(hook log not readable)"];
		}
		return `${[...header, "excerpt:", ...tail].join("\n")}\n`;
	}
	const details = input.details ?? [];
	const body = [
		...(details.length === 0
			? []
			: ["details:", ...details.map(([k, v]) => `  ${k}: ${v}`), ""]),
		"excerpt:",
		...(await excerptLines(
			input.log,
			input.toolErrors ?? [],
			input.highlight ?? [],
		)),
	];
	return `${[...header, ...body].join("\n")}\n`;
}
