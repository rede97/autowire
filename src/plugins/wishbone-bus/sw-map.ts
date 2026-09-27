// Software address view of a BusDef.
// RTL keeps one window and strips TagFromAddr bits. Software names each alias:
// the bus that produces the tag expands every sub-bus and leaf into one copy
// per shadow value. A child that only passes the tag through is not expanded
// again — its addresses stay relative to the copy the parent already named.
// Broadcast windows are real addresses (one write hits every subscriber).

import { effectiveSheet } from "../wishbone-regfile/dsl.ts";
import type { LaidCell, LaidRegfile } from "../wishbone-regfile/layout.ts";
import { layoutRegfile } from "../wishbone-regfile/layout.ts";
import type { BusDef, WbSlave, WbTagSource } from "./dsl.ts";
import { parseBits, windowBytes } from "./dsl.ts";

export type ShadowFix = {
	readonly domain: string;
	readonly copy: number;
};

export type MapNode = {
	/** Path of hang ids, shadow copies included (`ch0_pstate0`). */
	readonly name: string;
	/** Absolute byte address of this window. */
	readonly base: number;
	readonly size: number;
	readonly desc: string;
	readonly slave: WbSlave;
	/** Tag values already fixed by an ancestor TagFromAddr. */
	readonly shadows: readonly ShadowFix[];
	readonly regfile?: LaidRegfile;
	readonly sheet?: string;
	readonly children: readonly MapNode[];
};

function slaveSize(bus: BusDef, slave: WbSlave): number {
	return slave.size ?? windowBytes(slave.mask, bus.addr_width);
}

/** Tag domains this bus turns into address aliases. Uplink / pin / reg stay a TGA. */
function addrTags(bus: BusDef): WbTagSource[] {
	return bus.tags.filter(
		(t) => t.source === "addr" && t.addr_bits !== undefined,
	);
}

function copyStride(tag: WbTagSource): number {
	const { lo } = parseBits(
		`tag domain ${tag.domain.name}`,
		tag.addr_bits ?? "0:0",
	);
	return 1 << lo;
}

function copyBases(bus: BusDef): { shadows: ShadowFix[]; extra: number }[] {
	const tags = addrTags(bus);
	if (tags.length === 0) return [{ shadows: [], extra: 0 }];
	let rows: { shadows: ShadowFix[]; extra: number }[] = [
		{ shadows: [], extra: 0 },
	];
	for (const tag of tags) {
		const stride = copyStride(tag);
		const next: { shadows: ShadowFix[]; extra: number }[] = [];
		for (const row of rows) {
			for (let copy = 0; copy < tag.domain.copies; copy++) {
				next.push({
					shadows: [...row.shadows, { domain: tag.domain.name, copy }],
					extra: (row.extra + copy * stride) >>> 0,
				});
			}
		}
		rows = next;
	}
	return rows;
}

function shadowSuffix(shadows: readonly ShadowFix[]): string {
	return shadows.map((s) => `_${s.domain}${s.copy}`).join("");
}

function usesDomain(slave: WbSlave, domain: string): boolean {
	if (slave.regfile?.shadows.some((s) => s.name === domain)) return true;
	if (!slave.bus) return false;
	return slave.bus.tags.some((t) => t.domain.name === domain);
}

function walk(
	bus: BusDef,
	absBase: number,
	prefix: string,
	inherited: readonly ShadowFix[],
	expandInherited: boolean,
): MapNode[] {
	const copies = copyBases(bus);
	const out: MapNode[] = [];
	for (const slave of bus.slaves) {
		const size = slaveSize(bus, slave);
		const rows = copies.filter(
			(copy) =>
				copy.shadows.length === 0 ||
				copy.shadows.every((s) => usesDomain(slave, s.domain)),
		);
		const applied = rows.length > 0 ? rows : [{ shadows: [], extra: 0 }];
		for (const copy of applied) {
			const local = copy.shadows;
			const shadows = expandInherited ? [...inherited, ...local] : local;
			const name = `${prefix}${slave.name}${shadowSuffix(local)}`;
			const base = (absBase + slave.base + copy.extra) >>> 0;
			let regfile: LaidRegfile | undefined;
			let sheet: string | undefined;
			let children: MapNode[] = [];
			if (slave.regfile) {
				regfile = layoutRegfile(slave.regfile);
				sheet = effectiveSheet(slave.regfile);
			}
			if (slave.bus) {
				children = walk(slave.bus, base, `${name}_`, shadows, true);
			}
			out.push({
				name,
				base,
				size,
				desc: slave.desc,
				slave,
				shadows,
				...(regfile ? { regfile, sheet } : {}),
				children,
			});
		}
	}
	return out;
}

/**
 * Every window of `def`.
 * `expandInherited` is true for a parent walk (absolute aliases) and false when
 * emitting one bus's own block: a tag this bus only passes through is not split.
 */
export function mapTree(def: BusDef, expandInherited = true): MapNode[] {
	return walk(def, 0, "", [], expandInherited);
}

export function flattenMap(nodes: readonly MapNode[]): MapNode[] {
	const out: MapNode[] = [];
	const visit = (node: MapNode): void => {
		out.push(node);
		for (const child of node.children) visit(child);
	};
	for (const node of nodes) visit(node);
	return out;
}

/** Regfile hangs only. Shared by the C overlay and the uvm_reg block. */
export function regfileNodes(def: BusDef): MapNode[] {
	return flattenMap(mapTree(def)).filter((n) => n.regfile !== undefined);
}

export function broadcastNodes(def: BusDef): MapNode[] {
	return flattenMap(mapTree(def)).filter(
		(n) => n.slave.broadcast !== undefined,
	);
}

export function nodeCells(node: MapNode): readonly LaidCell[] {
	return node.regfile?.cells ?? [];
}
