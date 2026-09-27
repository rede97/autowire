// Colored dependency tree printing (termtree-style box-drawing + chalk colors).

import chalk from "chalk";
import type { HierNode, RtlIndex } from "./rtlindex.ts";

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

/** Render dependency trees. `top` selects one module anywhere in the hierarchy. */
export function renderTrees(
	index: RtlIndex,
	opts: { top?: string; depth?: number } = {},
): string[] {
	const maxDepth = opts.depth ?? Number.MAX_SAFE_INTEGER;
	let tops = index.tops;
	if (opts.top) {
		const found = findNode(index.tops, opts.top);
		if (!found) throw new Error(`module not found: ${opts.top}`);
		tops = [found];
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

function findNode(
	nodes: readonly HierNode[],
	name: string,
): HierNode | undefined {
	for (const n of nodes) {
		if (n.module === name) return n;
		const child = findNode(n.children, name);
		if (child) return child;
	}
	return undefined;
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
