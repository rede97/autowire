// Source file handle for the fsm compiler: every diagnostic carries file:line:col.

import type { Node } from "@babel/types";

export class FsmError extends Error {}

export class Src {
	constructor(
		/** Workspace-relative path (posix), printed in errors and the file header. */
		readonly file: string,
		readonly text: string,
	) {}

	/** Nodes carry their own file (parsed with sourceFilename), so code inlined
	 *  from another source reports where it was written. */
	fail(node: Node | null | undefined, msg: string): never {
		const p = node?.loc?.start;
		const file = node?.loc?.filename ?? this.file;
		throw new FsmError(
			p ? `${file}:${p.line}:${p.column + 1}: ${msg}` : `${file}: ${msg}`,
		);
	}

	/** Source text of a node, whitespace runs collapsed (for SV comments). */
	textOf(node: Node): string {
		return this.text
			.slice(node.start ?? 0, node.end ?? 0)
			.replace(/\s+/g, " ")
			.trim();
	}
}

const SV_ID = /^[A-Za-z_][A-Za-z0-9_]*$/;

// IEEE 1800-2017 keywords an author is likely to pick as a port or state name.
const SV_KEYWORDS = new Set(
	"always always_comb always_ff always_latch and assign automatic begin bit buf byte case casex casez cmos config const default defparam design disable do edge else end endcase endfunction endmodule endpackage endtask enum event final for force forever fork function generate genvar if import initial inout input int integer interface join localparam logic longint module nand negedge nor not or output package parameter posedge priority real reg repeat return shortint signed static string struct task time tri type typedef union unique unsigned var void wait while wire xor".split(
		" ",
	),
);

/** Name usable verbatim as an SV identifier (ports, states, modules). */
export function checkSvId(src: Src, node: Node, name: string, what: string) {
	if (!SV_ID.test(name))
		src.fail(node, `${what} "${name}" is not a valid SystemVerilog identifier`);
	if (SV_KEYWORDS.has(name))
		src.fail(node, `${what} "${name}" is a SystemVerilog keyword`);
}

/** State label → enum style: SendMsg → SEND_MSG, HTTPReq → HTTP_REQ, Work0 → WORK0. */
export function upperSnake(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
		.toUpperCase();
}
