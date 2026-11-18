// Terminal rendering for dtsim: tables (cli-table3), trees, status colours,
// and a live dashboard on stderr (log-update). Colour follows chalk's
// detection, so pipes, LSF logs and CI get plain text; `plain()` strips any
// colour before text goes into a file.
import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";
import Table from "cli-table3";

export type Row = readonly string[];

/** Bordered table with grey rules and bold cyan header names. `head` is
 *  optional; columns wrap at `maxWidth`. */
export function table(
	rows: readonly Row[],
	head?: Row,
	maxWidth = 100,
): string {
	const t = new Table({
		...(head ? { head: head.map((h) => chalk.bold.cyan(h)) } : {}),
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
	return lines.join("\n").replace(/[─│┌┐└┘├┤┬┴┼]+/g, (m) => chalk.gray(m));
}

/** Titled key/value block, e.g. the Run and Summary blocks of `dtsim run`. */
export function block(
	title: string,
	rows: ReadonlyArray<readonly [string, string]>,
): string {
	const shown = rows.filter(([, v]) => v.length > 0);
	return `${chalk.bold(title)}\n${table(shown.map(([k, v]) => [chalk.cyan(k), v]))}`;
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

/** Status text, bold, in its colour: PASS / OK green, PASS WITH ERRORS
 *  yellow, the rest red. */
export function status(text: string): string {
	if (text.startsWith("PASS WITH ERRORS")) return chalk.bold.yellow(text);
	if (text.startsWith("PASS") || text === "OK") return chalk.bold.green(text);
	return chalk.bold.red(text);
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

/** "512 B", "12.3 KiB", "3.4 MiB", "1.2 GiB" for a byte count. */
export function fmtSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KiB", "MiB", "GiB", "TiB"];
	let v = bytes / 1024;
	let u = 0;
	while (v >= 1024 && u < units.length - 1) {
		v /= 1024;
		u += 1;
	}
	return `${v.toFixed(1)} ${units[u]}`;
}

/**
 * Words in a grey box whose title sits in the top rule (`┌─ cmd ───┐`),
 * wrapped at spaces to fit `width` columns; a word longer than a row is
 * split. `paint` colours a piece of word `index`; widths use plain text.
 */
export function titledBox(
	title: string,
	words: readonly string[],
	width: number,
	paint: (piece: string, index: number) => string = (w) => w,
): string {
	const inner = Math.min(
		Math.max(title.length + 4, width - 4),
		Math.max(title.length + 3, words.join(" ").length),
	);
	type Piece = { text: string; index: number };
	const rows: Piece[][] = [[]];
	let used = 0;
	words.forEach((word, index) => {
		for (let i = 0; i < Math.max(1, word.length); i += inner) {
			const text = word.slice(i, i + inner);
			if (used > 0 && used + 1 + text.length > inner) {
				rows.push([]);
				used = 0;
			}
			(rows[rows.length - 1] as Piece[]).push({ text, index });
			used += (used > 0 ? 1 : 0) + text.length;
		}
	});
	const g = chalk.gray;
	const top = `${g("┌─ ")}${chalk.bold(title)}${g(` ${"─".repeat(inner - title.length - 1)}┐`)}`;
	const body = rows.map((row) => {
		const len = row.reduce((n, p, i) => n + (i > 0 ? 1 : 0) + p.text.length, 0);
		const text = row.map((p) => paint(p.text, p.index)).join(" ");
		return `${g("│")} ${text}${" ".repeat(inner - len)} ${g("│")}`;
	});
	return [top, ...body, g(`└${"─".repeat(inner + 2)}┘`)].join("\n");
}
