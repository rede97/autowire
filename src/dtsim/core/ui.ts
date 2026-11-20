// Terminal rendering for dtsim: tables (cli-table3), trees, status colours,
// and a live dashboard on stderr (log-update). Colour follows chalk's
// detection, so pipes, LSF logs and CI get plain text; `plain()` strips any
// colour before text goes into a file.
import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";
import Table from "cli-table3";
import type logUpdate from "log-update";

/** Print `text` above a live panel as one plain write, like `echo`: the panel
 *  is erased, the text goes out unchanged and the panel's next frame redraws
 *  below it. The terminal soft-wraps a long line, so a resize reflows it and
 *  a copied path stays whole (log-update's persist() hard-wraps at the
 *  current width). */
export function persistAbove(live: typeof logUpdate, text: string): void {
	live.clear();
	process.stderr.write(`${text}\n`);
}

export type Row = readonly string[];

/** Bordered table with grey rules and bold cyan header names. `head` is
 *  optional. On a terminal the table fills the width: the widest column grows
 *  to use the slack, or wraps so the whole row never exceeds it. A column is
 *  never shrunk below its header. Not a TTY (pipe, file) keeps the natural
 *  width (100-column cap), no padding. */
export function table(rows: readonly Row[], head?: Row): string {
	const all = head ? [head, ...rows] : rows;
	const cols = Math.max(0, ...all.map((r) => r.length));
	const widthOf = (c: string | undefined) =>
		Math.max(
			0,
			...plain(c ?? "")
				.split("\n")
				.map((l) => l.length),
		);
	// Natural content width of each column (header included, colour stripped).
	const target = Array.from({ length: cols }, (_, i) =>
		Math.max(1, ...all.map((r) => widthOf(r[i]))),
	);
	const floor = Array.from({ length: cols }, (_, i) =>
		Math.max(1, head ? widthOf(head[i]) : 1),
	);
	// cli-table3 adds 2 padding + 1 border per column plus a trailing border.
	const term = process.stdout.columns || 100;
	const budget = Math.max(cols, term - (cols * 3 + 1));
	// Shrink the widest shrinkable column a step at a time until the row fits.
	while (target.reduce((a, b) => a + b, 0) > budget) {
		let i = -1;
		let best = -1;
		for (let j = 0; j < cols; j++) {
			const w = target[j] ?? 0;
			if (w > (floor[j] ?? 0) && w > best) {
				best = w;
				i = j;
			}
		}
		if (i < 0) break;
		target[i] = (target[i] ?? 0) - 1;
	}
	// On a terminal, grow the widest column so the whole table fills the width.
	if (process.stdout.isTTY && cols > 0) {
		const slack = budget - target.reduce((a, b) => a + b, 0);
		if (slack > 0) {
			let i = 0;
			for (let j = 1; j < cols; j++)
				if ((target[j] ?? 0) >= (target[i] ?? 0)) i = j;
			target[i] = (target[i] ?? 0) + slack;
		}
	}
	const t = new Table({
		...(head ? { head: head.map((h) => chalk.bold.cyan(h)) } : {}),
		colWidths: target.map((w) => w + 2),
		style: { head: [], border: [] },
		// No rule between body rows; a header still gets its own rule.
		chars: { mid: "", "left-mid": "", "mid-mid": "", "right-mid": "" },
	});
	for (const r of rows)
		t.push(r.map((cell, i) => wrap(cell, target[i] as number)));
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

/** Titled key/value block, e.g. the Run and Summary blocks of `dtsim run`.
 *  A two-column table, so it fits the terminal width like every other table. */
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

/** Status text, bold, in its colour: PASS green, OK (a finished compile)
 *  blue, PASS WITH ERRORS yellow, the rest red. */
export function status(text: string): string {
	if (text.startsWith("PASS WITH ERRORS")) return chalk.bold.yellow(text);
	if (text.startsWith("PASS")) return chalk.bold.green(text);
	if (text === "OK") return chalk.bold.blue(text);
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
 * The words between a top and a bottom rule that each span `width` columns, the
 * title sitting in the top rule (`── cmd ─────`). There are no side borders, so
 * the command can be selected and copied verbatim. Words wrap at spaces to
 * `width`; a word longer than a row is split. `paint` colours a piece of word
 * `index`; widths use plain text.
 */
export function titledRules(
	title: string,
	words: readonly string[],
	width: number,
	paint: (piece: string, index: number) => string = (w) => w,
): string {
	const wrapWidth = Math.max(1, width);
	type Piece = { text: string; index: number };
	const rows: Piece[][] = [[]];
	let used = 0;
	words.forEach((word, index) => {
		for (let i = 0; i < Math.max(1, word.length); i += wrapWidth) {
			const text = word.slice(i, i + wrapWidth);
			if (used > 0 && used + 1 + text.length > wrapWidth) {
				rows.push([]);
				used = 0;
			}
			(rows[rows.length - 1] as Piece[]).push({ text, index });
			used += (used > 0 ? 1 : 0) + text.length;
		}
	});
	const g = chalk.gray;
	const fill = Math.max(0, width - (title.length + 4));
	const top = `${g("── ")}${chalk.bold(title)}${g(` ${"─".repeat(fill)}`)}`;
	const body = rows.map((row) =>
		row.map((p) => paint(p.text, p.index)).join(" "),
	);
	return [top, ...body, g("─".repeat(wrapWidth))].join("\n");
}
