// Error excerpts: on a non-clean result, capture the interesting lines
// instead of dumping the whole log. Full log always stays in the case dir.
import { readFileSync } from "node:fs";
import { type GradeDetails, kwMatchLine as kwMatch } from "./grade.ts";

const MAX_EXCERPT = 40;

export function excerptLines(args: {
	lines: readonly string[];
	kept: readonly string[];
	toolErrors: readonly RegExp[];
	errorKeywords: readonly string[];
}): string[] {
	const picked: Array<{ index: number; line: string }> = [];
	const seen = new Set<number>();
	const take = (index: number, line: string): void => {
		if (!seen.has(index)) {
			seen.add(index);
			picked.push({ index, line });
		}
	};
	args.lines.forEach((line, i) => {
		if (args.toolErrors.some((re) => re.test(line))) take(i, line);
	});
	const keptSet = new Set(args.kept);
	args.lines.forEach((line, i) => {
		if (!keptSet.has(line)) return; // waived lines are not errors
		if (args.errorKeywords.some((kw) => kwMatch(kw, line))) take(i, line);
	});
	if (picked.length < 8) {
		const start = Math.max(0, args.lines.length - 15);
		for (let i = start; i < args.lines.length; i++) {
			const line = args.lines[i];
			if (line !== undefined) take(i, line);
		}
	}
	picked.sort((a, b) => a.index - b.index);
	const out = picked.map((p) => p.line);
	if (out.length > MAX_EXCERPT) {
		return [...out.slice(0, MAX_EXCERPT), "(excerpt truncated)"];
	}
	return out;
}

export type ExcerptInput = {
	status: string;
	phase: "compile" | "sim" | "hook";
	exitCode?: number;
	tool: string;
	caseId: string;
	seed?: string;
	log: string;
	details?: GradeDetails;
	toolErrors?: readonly RegExp[];
	hookLog?: string;
};

export function formatExcerpt(input: ExcerptInput): string {
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
	const details = input.details;
	const lines = details?.lines ?? readTail(input.log);
	const kept = details?.kept ?? lines;
	const errors = Object.entries(details?.errorCounts ?? {});
	const body = [
		"error keywords:",
		...(errors.length === 0
			? ["  (none)"]
			: errors.map(([kw, n]) => `  ${kw}: ${n}`)),
		"missing expect:",
		...(details && details.missingExpect.length > 0
			? details.missingExpect.map((kw) => `  ${kw}`)
			: ["  (none)"]),
		"",
		"excerpt:",
		...excerptLines({
			lines,
			kept,
			toolErrors: input.toolErrors ?? [],
			errorKeywords: Object.keys(details?.errorCounts ?? {}),
		}),
	];
	return `${[...header, ...body].join("\n")}\n`;
}

function readTail(log: string): string[] {
	try {
		return readFileSync(log, "utf8").split("\n");
	} catch {
		return [];
	}
}
