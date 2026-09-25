// Tag (TGA) plan for a fabric: who produces each domain, which ADR bits it
// carves out, and what the master faces still carry.
// Contract: docs/plugins/wishbone-bus.md 2.1.

import type { BusDef, WbTagSource } from "./dsl.ts";
import { parseBits, tagAddrMask } from "./dsl.ts";

export type TagPlan = {
	/** Fabric TGA width (`BusDef.tag_width`). */
	readonly width: number;
	/** ADR bits consumed by `TagFromAddr` domains (stripped from decode). */
	readonly addrMask: number;
	/** TGA width still arriving on master faces (0 = no master TGA port). */
	readonly masterWidth: number;
	/** Domains produced from a fabric input pin. */
	readonly pins: readonly WbTagSource[];
	/** Domains produced from an attached leaf regbit. */
	readonly regs: readonly WbTagSource[];
};

/** Input port name for a `TagFromPin` domain. */
export function tagPinPort(domain: string): string {
	return `${domain}_tag_i`;
}

export function tagPlan(def: BusDef): TagPlan {
	const width = def.tag_width;
	const addrMask = tagAddrMask(def.tags);
	// Tags declared but none inherited → master faces carry no TGA.
	const inherited =
		def.tags.length === 0 || def.tags.some((t) => t.source === "uplink");
	return {
		width,
		addrMask,
		masterWidth: inherited ? width : 0,
		pins: def.tags.filter((t) => t.source === "pin"),
		regs: def.tags.filter((t) => t.source === "reg"),
	};
}

type Seg = { readonly hi: number; readonly lo: number; readonly expr: string };

/**
 * Expression for the whole `g_tga` vector: locally produced slices sit at their
 * domain bit positions, everything else comes from the master face.
 */
export function tagValueExpr(
	def: BusDef,
	plan: TagPlan,
	adrExpr: string,
	masterExpr: string,
): string {
	if (plan.width === 0) return "";
	if (def.tags.length === 0) return masterExpr;
	const local: Seg[] = [];
	for (const t of def.tags) {
		if (t.source === "uplink") continue;
		const { hi, lo } = parseBits(t.domain.name, t.domain.tag_bits);
		local.push({ hi, lo, expr: localSliceExpr(t, adrExpr) });
	}
	if (local.length === 0) return masterExpr;
	local.sort((a, b) => a.lo - b.lo);
	const parts: string[] = [];
	let cursor = 0;
	const fill = (hi: number, lo: number) => {
		if (hi < lo) return;
		parts.push(
			plan.masterWidth > 0 ? `${masterExpr}[${hi}:${lo}]` : `${hi - lo + 1}'d0`,
		);
	};
	for (const seg of local) {
		fill(seg.lo - 1, cursor);
		parts.push(seg.expr);
		cursor = seg.hi + 1;
	}
	fill(plan.width - 1, cursor);
	// Concat is MSB-first.
	return parts.length === 1
		? `${parts[0]}`
		: `{${[...parts].reverse().join(", ")}}`;
}

function localSliceExpr(t: WbTagSource, adrExpr: string): string {
	if (t.source === "addr" && t.addr_bits !== undefined) {
		const { hi, lo } = parseBits(t.domain.name, t.addr_bits);
		return `${adrExpr}[${hi}:${lo}]`;
	}
	if (t.source === "pin") return tagPinPort(t.domain.name);
	if (t.source === "reg" && t.reg_field !== undefined) return t.reg_field;
	throw new Error(
		`wishbone-bus: tag domain "${t.domain.name}" has no usable local source`,
	);
}
