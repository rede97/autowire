// Public Wishbone endpoint names are endpoint-centric; directions are fabric-facing.
import type { BusDef, WbSlave, WbTagSource } from "./dsl.ts";
import { domainWidth } from "./dsl.ts";
import { tagPlan } from "./tag.ts";

const WB_SCHEMA = {
	adr: { signal: "adr", request: true, width: "address" },
	wdat: { signal: "dat", request: true, width: 32 },
	sel: { signal: "sel", request: true, width: 4 },
	tga: { signal: "tga", request: true, width: "tag" },
	cyc: { signal: "cyc", request: true, width: 1 },
	stb: { signal: "stb", request: true, width: 1 },
	we: { signal: "we", request: true, width: 1 },
	rdat: { signal: "dat", request: false, width: 32 },
	ack: { signal: "ack", request: false, width: 1 },
	err: { signal: "err", request: false, width: 1 },
} as const;

export type WbRole = keyof typeof WB_SCHEMA;
export type WbEndpointKind = "master" | "slave";
export type WbEndpointTag = { readonly domain: string; readonly width: number };
export type WbSemantic = {
	readonly endpoint: string;
	readonly kind: WbEndpointKind;
	readonly role: WbRole;
	readonly domain?: string;
};

export type FabricPort = {
	readonly dir: "input" | "output";
	readonly packed: string;
	readonly name: string;
	readonly comment?: string;
	readonly wb?: WbSemantic;
};

export type WbEndpointPort = FabricPort & { readonly wb: WbSemantic };

/** The one naming rule, shared by declarations and all public WB references. */
export function wbPortName(
	kind: WbEndpointKind,
	name: string,
	role: WbRole,
	domain = "tag",
): string {
	const signal = WB_SCHEMA[role];
	const direction = signal.request === (kind === "master") ? "o" : "i";
	return `${name}_${direction}_wb_${signal.signal}${role === "tga" ? `_${domain}` : ""}`;
}

/** One schema for fabric endpoints and native WB/CDC wrapper faces. */
export function wbEndpointPorts(
	kind: WbEndpointKind,
	name: string,
	addrWidth: number,
	tags: readonly WbEndpointTag[] = [],
	err = false,
): WbEndpointPort[] {
	const ports: WbEndpointPort[] = [];
	for (const role of Object.keys(WB_SCHEMA) as WbRole[]) {
		if (role === "err" && !err) continue;
		const signal = WB_SCHEMA[role];
		const domains = role === "tga" ? tags : [undefined];
		for (const tag of domains) {
			const width =
				signal.width === "address"
					? addrWidth
					: signal.width === "tag"
						? (tag?.width ?? 0)
						: signal.width;
			ports.push({
				dir: signal.request === (kind === "master") ? "input" : "output",
				packed: width > 1 ? `[${width - 1}:0]` : "",
				name: wbPortName(kind, name, role, tag?.domain),
				wb: {
					endpoint: name,
					kind,
					role,
					...(tag ? { domain: tag.domain } : {}),
				},
			});
		}
	}
	return ports;
}

export function endpointTags(tags: readonly WbTagSource[]): WbEndpointTag[] {
	return tags.map((t) => ({
		domain: t.domain.name,
		width: domainWidth(t.domain),
	}));
}

export function masterEndpointPorts(
	def: BusDef,
	name: string,
	err = false,
): WbEndpointPort[] {
	return wbEndpointPorts(
		"master",
		name,
		def.addr_width,
		endpointTags(tagPlan(def).inherited),
		err,
	);
}

/**
 * A regfile slave port carries the leaf's own ADR width, so the downstream
 * face plugs straight into `<name>_regfile`. Other slaves keep the fabric width.
 */
export function slaveAddrWidth(def: BusDef, s: WbSlave): number {
	return s.regfile?.addr_width ?? def.addr_width;
}

export function slaveEndpointPorts(def: BusDef, s: WbSlave): WbEndpointPort[] {
	const tags = s.regfile
		? s.regfile.shadows.map((shadow) => ({
				domain: shadow.name,
				width: shadow.tag_width,
			}))
		: s.bus
			? endpointTags(tagPlan(s.bus).inherited)
			: (s.tag ?? 0) > 0
				? [{ domain: "tag", width: s.tag as number }]
				: [];
	return wbEndpointPorts("slave", s.name, slaveAddrWidth(def, s), tags);
}
