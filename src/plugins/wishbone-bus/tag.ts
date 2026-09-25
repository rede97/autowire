// Tag (TGA) plan for a fabric: who produces each domain, which ADR bits it
// carves out, and what the master faces still carry.
// Contract: docs/plugins/wishbone-bus.md 2.1.

import type { BusDef, WbTagSource } from "./dsl.ts";
import { domainWidth, tagAddrMask, tagDomainsWidth } from "./dsl.ts";

export type TagPlan = {
	/** Sum of every domain carried by this fabric. */
	readonly width: number;
	/** ADR bits consumed by `TagFromAddr` domains (stripped from decode). */
	readonly addrMask: number;
	/** Domains still arriving on a master face, in declaration order. */
	readonly inherited: readonly WbTagSource[];
	/** Domains produced from a fabric input pin. */
	readonly pins: readonly WbTagSource[];
	/** Domains produced from an attached leaf regbit. */
	readonly regs: readonly WbTagSource[];
};

/** Boundary port for one tag domain: `i_wb_tga_pstate`, `cpu_o_wb_tga_pstate`. */
export function tagPort(stem: string, domain: string): string {
	return `${stem}_tga_${domain}`;
}

export { domainWidth, tagDomainsWidth as domainsWidth };

/** Input port name for a `TagFromPin` domain. */
export function tagPinPort(domain: string): string {
	return `${domain}_tag_i`;
}

export function tagPlan(def: BusDef): TagPlan {
	return {
		width: tagDomainsWidth(def.tags),
		addrMask: tagAddrMask(def.tags),
		inherited: def.tags.filter((t) => t.source === "uplink"),
		pins: def.tags.filter((t) => t.source === "pin"),
		regs: def.tags.filter((t) => t.source === "reg"),
	};
}

/**
 * Packed expression for the domains crossing one pipe, declaration order, MSB first.
 * `source` maps a domain to the signal that supplies it.
 */
export function packedTagExpr(
	tags: readonly WbTagSource[],
	source: (tag: WbTagSource) => string,
): string {
	if (tags.length === 0) return "";
	if (tags.length === 1) {
		const only = tags[0];
		return only ? source(only) : "";
	}
	return `{${[...tags]
		.reverse()
		.map((t) => source(t))
		.join(", ")}}`;
}
