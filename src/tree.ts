// Colored dependency tree printing (termtree-style box-drawing + chalk colors).

import chalk from "chalk";
import type { HierNode, RtlIndex } from "./rtlindex.js";

function label(node: HierNode, source?: string, isTop = false): string {
	let name = node.cycle
		? chalk.red(node.module)
		: node.blackbox
			? chalk.yellow(node.module)
			: isTop
				? chalk.cyan.bold(node.module)
				: chalk.green(node.module);
	if (node.blackbox) name += chalk.yellow(" [blackbox]");
	if (node.cycle) name += chalk.red(" [cycle]");
	if (source) name += chalk.dim(` (${source})`);
	return name;
}

function renderInto(
	node: HierNode,
	prefix: string,
	isLast: boolean,
	depth: number,
	maxDepth: number,
	out: string[],
): void {
	out.push(prefix + (isLast ? "└── " : "├── ") + label(node));
	if (node.cycle || node.blackbox) return;
	const childPrefix = prefix + (isLast ? "    " : "│   ");
	if (depth + 1 >= maxDepth) {
		if (node.children.length > 0) out.push(childPrefix + chalk.dim("└── …"));
		return;
	}
	node.children.forEach((c, i) => {
		renderInto(
			c,
			childPrefix,
			i === node.children.length - 1,
			depth + 1,
			maxDepth,
			out,
		);
	});
}

/** Render all dependency trees of the index (one tree per top, returned line by line) */
export function renderTrees(
	index: RtlIndex,
	opts: { top?: string; depth?: number } = {},
): string[] {
	const maxDepth = opts.depth ?? Number.MAX_SAFE_INTEGER;
	let tops = index.tops;
	if (opts.top) {
		tops = tops.filter((t) => t.module === opts.top);
		if (tops.length === 0) throw new Error(`top module not found: ${opts.top}`);
	}
	const out: string[] = [];
	for (const t of tops) {
		out.push(label(t, index.moduleSource.get(t.module), true));
		t.children.forEach((c, i) => {
			renderInto(c, "", i === t.children.length - 1, 0, maxDepth, out);
		});
	}
	return out;
}

/** Summary lines (file/module/top counts + error file list) */
export function renderSummary(index: RtlIndex): string[] {
	const out = [
		chalk.dim(
			`tool=${index.tool} files=${index.files.length} modules=${index.moduleSource.size} tops=${index.tops.length}`,
		),
	];
	if (index.errorFiles.length > 0) {
		out.push(chalk.red(`error files: ${index.errorFiles.length}`));
		for (const f of index.errorFiles) out.push(chalk.red(`  ${f.source}`));
	}
	return out;
}
