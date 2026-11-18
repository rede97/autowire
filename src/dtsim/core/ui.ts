// Terminal rendering for dtsim: tables (cli-table3), trees, status colours,
// and a live dashboard on stderr (log-update). Colour follows chalk's
// detection, so pipes, LSF logs and CI get plain text; `plain()` strips any
// colour before text goes into a file.
import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";
import Table from "cli-table3";

export type Row = readonly string[];

/** Bordered table. `head` is optional; columns wrap at `maxWidth`. */
export function table(
	rows: readonly Row[],
	head?: Row,
	maxWidth = 100,
): string {
	const t = new Table({
		...(head ? { head: head.map((h) => chalk.bold(h)) } : {}),
		style: { head: [], border: [] },
		// No rule between body rows; a header still gets its own rule.
		chars: { mid: "", "left-mid": "", "mid-mid": "", "right-mid": "" },
	});
	for (const r of rows) t.push(r.map((cell) => wrap(cell, maxWidth)));
	const lines = t.toString().split("\n");
	// Header names are single-line: draw the top border again under them.
	if (head && lines[0]) {
		lines.splice(
			2,
			0,
			lines[0].replace("┌", "├").replace("┐", "┤").replaceAll("┬", "┼"),
		);
	}
	return lines.join("\n");
}

/** Titled key/value block, e.g. the Run and Summary blocks of `dtsim run`. */
export function block(
	title: string,
	rows: ReadonlyArray<readonly [string, string]>,
): string {
	const shown = rows.filter(([, v]) => v.length > 0);
	return `${chalk.bold(title)}\n${table(shown.map(([k, v]) => [chalk.dim(k), v]))}`;
}

export type TreeNode = { label: string; children?: readonly TreeNode[] };

/** `├─` / `└─` tree, one node per line. */
export function tree(nodes: readonly TreeNode[], prefix = ""): string[] {
	return nodes.flatMap((node, i) => {
		const last = i === nodes.length - 1;
		return [
			`${prefix}${last ? "└─ " : "├─ "}${node.label}`,
			...tree(node.children ?? [], `${prefix}${last ? "   " : "│  "}`),
		];
	});
}

/** Status text in its colour: PASS green, PASS WITH ERRORS yellow, rest red. */
export function status(text: string): string {
	if (text.startsWith("PASS WITH ERRORS")) return chalk.yellow(text);
	if (text.startsWith("PASS") || text === "OK") return chalk.green(text);
	return chalk.red(text);
}

/** Text for a file: colour codes removed. */
export function plain(text: string): string {
	return stripVTControlCharacters(text);
}

/**
 * Wrap plain lines at spaces to `width`; a word longer than `width` (a path)
 * is split. Coloured lines stay whole so escape codes are never cut.
 */
function wrap(cell: string, width: number): string {
	return cell
		.split("\n")
		.flatMap((line) => {
			if (line !== plain(line) || line.length <= width) return [line];
			const out: string[] = [];
			let cur = "";
			for (const word of line.split(" ")) {
				if (cur && cur.length + 1 + word.length > width) {
					out.push(cur);
					cur = "";
				}
				cur = cur ? `${cur} ${word}` : word;
				while (cur.length > width) {
					out.push(cur.slice(0, width));
					cur = cur.slice(width);
				}
			}
			if (cur) out.push(cur);
			return out;
		})
		.join("\n");
}
