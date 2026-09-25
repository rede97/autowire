// Wishbone-bus authoring DSL (SoT). Contract: docs/plugins/wishbone-bus.md.

import {
	isRegfileDef,
	isShadowDomain,
	type RegfileDef,
	type ShadowDomainDef,
} from "../wishbone-regfile/dsl.ts";
import { layoutByteSpan, layoutRegfile } from "../wishbone-regfile/layout.ts";

/**
 * Where a tag domain's TGA value is produced (contract: wishbone-bus.md 2.1).
 * `uplink` = pass through from a master port; the others are produced here.
 */
export type WbTagSourceKind = "uplink" | "addr" | "pin" | "reg";

export type WbTagSource = {
	readonly kind: "wishbone-tag-source";
	readonly domain: ShadowDomainDef;
	readonly source: WbTagSourceKind;
	/** `addr` only: ADR slice "hi:lo" carved out of this level's address. */
	readonly addr_bits?: string;
	/** `reg` only: regbit that drives the tag (`<field>` of an attached leaf). */
	readonly reg_field?: string;
};

function tagSource(
	domain: ShadowDomainDef,
	source: WbTagSourceKind,
	extra: { addr_bits?: string; reg_field?: string } = {},
): WbTagSource {
	if (!isShadowDomain(domain)) {
		throw new Error(
			"wishbone-bus: tag source needs a ShadowDomain(...) as its first arg",
		);
	}
	return {
		kind: "wishbone-tag-source",
		domain,
		source,
		...(extra.addr_bits !== undefined ? { addr_bits: extra.addr_bits } : {}),
		...(extra.reg_field !== undefined ? { reg_field: extra.reg_field } : {}),
	};
}

export function isTagSource(v: unknown): v is WbTagSource {
	return (
		typeof v === "object" &&
		v !== null &&
		(v as WbTagSource).kind === "wishbone-tag-source"
	);
}

/** Produced here from an ADR slice; those bits are stripped from slave decode. */
export function TagFromAddr(
	domain: ShadowDomainDef,
	addrBits: string,
): WbTagSource {
	parseBits(`tag domain ${domain.name}`, addrBits);
	return tagSource(domain, "addr", { addr_bits: addrBits });
}

/** Produced here from a fabric input port (e.g. a global pstate controller). */
export function TagFromPin(domain: ShadowDomainDef): WbTagSource {
	return tagSource(domain, "pin");
}

/** Produced here from a regbit of an attached leaf (no round trip through the bus). */
export function TagFromReg(
	domain: ShadowDomainDef,
	regField: string,
): WbTagSource {
	return tagSource(domain, "reg", { reg_field: regField });
}

/** "hi:lo" → numeric bounds; also used to validate ShadowDomain slices. */
export function parseBits(
	what: string,
	bits: string,
): { hi: number; lo: number } {
	const m = /^(\d+)\s*:\s*(\d+)$/.exec(bits.trim());
	if (!m) {
		throw new Error(`wishbone-bus: ${what} bits "${bits}" must be hi:lo`);
	}
	const hi = Number(m[1]);
	const lo = Number(m[2]);
	if (hi < lo) {
		throw new Error(`wishbone-bus: ${what} bits "${bits}" has hi < lo`);
	}
	return { hi, lo };
}

/** Mask of the ADR bits a `TagFromAddr` source carves out. */
export function tagAddrMask(tags: readonly WbTagSource[]): number {
	let mask = 0;
	for (const t of tags) {
		if (t.source !== "addr" || t.addr_bits === undefined) continue;
		const { hi, lo } = parseBits(`tag domain ${t.domain.name}`, t.addr_bits);
		for (let b = lo; b <= hi; b++) mask |= 1 << b;
	}
	return mask >>> 0;
}

/** Width of one domain's own named TGA port. */
export function domainWidth(domain: ShadowDomainDef): number {
	return domain.tag_width;
}

/** Packed width of a path: sum of its domains, in declaration order. */
export function tagDomainsWidth(tags: readonly WbTagSource[]): number {
	return tags.reduce((sum, t) => sum + domainWidth(t.domain), 0);
}

export type SlaveOpts = {
	/** TGA width (bits) forwarded to this slave; omitted/0 = no TGA port. */
	readonly tag?: number;
	/**
	 * Posted-write / blocking-read register stages inserted on this slave
	 * port (0 = combinational).
	 */
	readonly pipe?: number;
};

/** Extra options when `SlaveRegfile` attaches a `RegfileDef`. */
export type SlaveRegfileOpts = SlaveOpts & {
	/**
	 * Fabric slave id / interconnect port prefix. Defaults to `RegfileDef.name`.
	 * Distinct ids hang the same SoT leaf more than once.
	 */
	readonly id?: string;
	/** Override auto `Size(layout span)`. Must cover the laid-out leaf. */
	readonly size?: RegionSize;
	/** Override `RegfileDef.desc` on this hang. */
	readonly desc?: string;
};

/**
 * Cascade master name on a child `BusDef` (`SlaveBus` sugar).
 * Interconnect: named `{uplink}_o_wb_*` / `{uplink}_i_wb_*`.
 * Decoder (NM<=1): still flat `m_*`; the wrapper remaps them to `i_wb_*` / `o_wb_*`.
 */
export const UPLINK_MASTER = "uplink";

/** Extra options when `SlaveBus` hangs a child fabric. */
export type SlaveBusOpts = SlaveOpts & {
	/** Parent slave id. Defaults to `BusDef.name`. Distinct ids reuse one child RTL. */
	readonly id?: string;
	/** Override auto `Size(child span)`. Must cover `busByteSpan(child)`. */
	readonly size?: RegionSize;
	/** Override `BusDef.desc` on this hang. */
	readonly desc?: string;
	/** Child master that faces the parent window. Defaults to `uplink`. */
	readonly uplink?: string;
};

/** `raw` = `Slave(mask)` (unchecked). `region` = `SlaveRegion` / `SlaveRegfile`. */
export type SlaveWindow = "raw" | "region";

export type WbSlave = {
	readonly name: string;
	/** Byte base address (inclusive match with mask). */
	readonly base: number;
	/** Address mask: match when (adr & mask) == base. */
	readonly mask: number;
	readonly desc: string;
	/** TGA width (bits) forwarded to this slave; omitted/0 = no TGA port. */
	readonly tag?: number;
	/** Inline pipe stages on this slave (0 = none). */
	readonly pipe: number;
	/** Attached Type-A leaf (string slaves leave this unset). */
	readonly regfile?: RegfileDef;
	/** Child fabric hung via `SlaveBus` (generated once; instantiated per hang). */
	readonly bus?: BusDef;
	/** Child master that faces this parent window (`SlaveBus` only). */
	readonly uplink?: string;
	/** Author span in bytes when the window came from `SlaveRegion` / `Size`. */
	readonly size?: number;
	/** Mask was derived from layout span or `Size`; Bus may re-derive with `addr_width`. */
	readonly mask_auto?: boolean;
	readonly window: SlaveWindow;
};

/** Author-facing window span (bytes). Decode still uses a 2^N match mask. */
export type RegionSize = {
	readonly kind: "wishbone-region-size";
	readonly bytes: number;
};

export function Size(bytes: number): RegionSize {
	if (!Number.isInteger(bytes) || bytes < 1) {
		throw new Error("wishbone-bus: Size(bytes) must be an integer >= 1");
	}
	return { kind: "wishbone-region-size", bytes };
}

export function isRegionSize(v: unknown): v is RegionSize {
	return (
		typeof v === "object" &&
		v !== null &&
		(v as RegionSize).kind === "wishbone-region-size" &&
		typeof (v as RegionSize).bytes === "number"
	);
}

/** Native protocol on the `<bus>_system` face of a master. */
export type WbMasterBridge = "wb" | "apb" | "jtag";

export type ApbMasterOpts = {
	/** PPROT filter: accept iff `(PPROT & mask) === value`; mismatch → PSLVERR. */
	readonly pprot?: { readonly value: number; readonly mask?: number };
};

export type JtagMasterOpts = {
	/** Run-Test/Idle TCK cycles between launch and poll in the emitted PDL. */
	readonly idle?: number;
};

export type MasterOpts = {
	/**
	 * Posted-write / blocking-read stages on this master's fabric port
	 * (0 = combinational). Sits in front of the arbiter: the arbiter requests
	 * and holds the grant from the pipe's `s_cyc`, so a posted write stays
	 * owned until it drains. On a decoder the same pipe sits in front of decode.
	 */
	readonly pipe?: number;
	/** Master runs in its own clock: insert `wb_cdc` into the fabric `clk`. */
	readonly cdc?: boolean;
	/** Source-clock cycles before `wb_cdc` aborts with ERR (0 = off). */
	readonly timeout?: number;
	/** APB completer face (`wb_apb2wb`). */
	readonly apb?: true | ApbMasterOpts;
	/** IEEE 1149.1 / 1687 TDR face (`wb_jtag_tdr`); always crosses from TCK. */
	readonly jtag?: true | JtagMasterOpts;
};

export type WbMaster = {
	readonly name: string;
	readonly desc: string;
	/** Omitted = `wb` (fabric-clock WB port, no wrapper logic). */
	readonly bridge?: WbMasterBridge;
	readonly cdc?: boolean;
	readonly timeout?: number;
	readonly pprot?: { readonly value: number; readonly mask: number };
	readonly idle?: number;
	/** Fabric-side pipe stages (0 = combinational). */
	readonly pipe: number;
};

export function masterBridge(m: WbMaster): WbMasterBridge {
	return m.bridge ?? "wb";
}

/** Master needs bridge and/or CDC logic inside `<bus>_system`. */
export function isBridgedMaster(m: WbMaster): boolean {
	return masterBridge(m) !== "wb" || m.cdc === true;
}

export type BusDef = {
	readonly kind: "wishbone-bus";
	readonly name: string;
	readonly desc: string;
	/** Masters; length <= 1 → emit decoder only (no arbiter). */
	readonly masters: readonly WbMaster[];
	readonly slaves: readonly WbSlave[];
	/** Fabric ADR width (default 32). */
	readonly addr_width: number;
	/** Fabric TGA width in bits (0 = no TGA anywhere). */
	readonly tag_width: number;
	/** Tag domains carried on this fabric, low slice first (wishbone-bus.md 2.1). */
	readonly tags: readonly WbTagSource[];
};

export function isBusDef(v: unknown): v is BusDef {
	return (
		typeof v === "object" &&
		v !== null &&
		(v as BusDef).kind === "wishbone-bus" &&
		typeof (v as BusDef).name === "string"
	);
}

function parseSlaveOpts(
	name: string,
	tagOrOpts?: number | SlaveOpts,
): { tag?: number; pipe: number } {
	const opts: SlaveOpts =
		tagOrOpts === undefined
			? {}
			: typeof tagOrOpts === "number"
				? { tag: tagOrOpts }
				: tagOrOpts;
	const tag = opts.tag;
	const pipe = opts.pipe ?? 0;
	if (tag !== undefined && (!Number.isInteger(tag) || tag < 0)) {
		throw new Error(`wishbone-bus: slave ${name} tag must be >= 0`);
	}
	if (!Number.isInteger(pipe) || pipe < 0 || pipe > 16) {
		throw new Error(`wishbone-bus: slave ${name} pipe must be 0..16`);
	}
	return { ...(tag ? { tag } : {}), pipe };
}

function requireIdent(kind: string, name: string): void {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
		throw new Error(`wishbone-bus: bad ${kind} name "${name}"`);
	}
}

function addrOnes(addrWidth: number): number {
	return addrWidth >= 32 ? 0xffffffff : ((1 << addrWidth) - 1) >>> 0;
}

/** Decode window size in bytes from a match mask. */
export function windowBytes(mask: number, addrWidth: number): number {
	return ((~mask & addrOnes(addrWidth)) + 1) >>> 0;
}

/**
 * Power-of-two window mask covering `spanBytes` (at least one 32-bit cell).
 * `mask` bits that must match; low bits that index the window are 0.
 */
export function deriveWindowMask(spanBytes: number, addrWidth: number): number {
	if (!Number.isInteger(spanBytes) || spanBytes < 1) {
		throw new Error(`wishbone-bus: layout span must be >= 1`);
	}
	let size = 4;
	while (size < spanBytes) {
		size *= 2;
		if (size > 0x1_0000_0000) {
			throw new Error(
				`wishbone-bus: layout span 0x${spanBytes.toString(16)} is too large`,
			);
		}
	}
	const ones = addrOnes(addrWidth);
	if (size > ones + 1 && addrWidth < 32) {
		throw new Error(
			`wishbone-bus: layout span 0x${spanBytes.toString(16)} exceeds addr_width ${addrWidth}`,
		);
	}
	return (ones ^ (size - 1)) >>> 0;
}

function attachRegfile(
	regfile: RegfileDef,
	base: number,
	opts: SlaveRegfileOpts,
): WbSlave {
	const name = opts.id ?? regfile.name;
	const laid = layoutRegfile(regfile);
	const tga = laid.tga_width;
	if (opts.tag !== undefined && opts.tag !== tga) {
		throw new Error(
			`wishbone-bus: slave ${name} tag ${opts.tag} != regfile "${regfile.name}" tga_width ${tga}`,
		);
	}
	const span = layoutByteSpan(laid);
	const size = opts.size ?? Size(span);
	if (!isRegionSize(size)) {
		throw new Error(
			`wishbone-bus: SlaveRegfile(${name}, ...) size must be Size(bytes)`,
		);
	}
	const win = windowBytes(deriveWindowMask(size.bytes, 32), 32);
	if (win < span) {
		throw new Error(
			`wishbone-bus: slave ${name} window 0x${win.toString(16)} is smaller than layout span 0x${span.toString(16)}`,
		);
	}
	const region = SlaveRegion(name, opts.desc ?? regfile.desc, base, size, {
		tag: tga > 0 ? tga : opts.tag,
		pipe: opts.pipe,
	});
	return { ...region, regfile };
}

export function Slave(
	name: string,
	desc: string,
	base: number,
	mask: number,
	tagOrOpts?: number | SlaveOpts,
): WbSlave {
	requireIdent("slave", name);
	if (!Number.isInteger(base) || base < 0) {
		throw new Error(`wishbone-bus: slave ${name} base must be >= 0`);
	}
	if (!Number.isInteger(mask) || mask < 0) {
		throw new Error(`wishbone-bus: slave ${name} mask must be >= 0`);
	}
	const { tag, pipe } = parseSlaveOpts(name, tagOrOpts);
	return {
		name,
		desc,
		base,
		mask,
		pipe,
		window: "raw",
		...(tag ? { tag } : {}),
	};
}

/**
 * String slave window by byte span (`Size`), not a raw match mask.
 * Decode still uses `deriveWindowMask` (ceil to 2^N); base must align.
 */
export function SlaveRegion(
	name: string,
	desc: string,
	base: number,
	size: RegionSize,
	tagOrOpts?: number | SlaveOpts,
): WbSlave {
	requireIdent("slave", name);
	if (!isRegionSize(size)) {
		throw new Error(
			`wishbone-bus: SlaveRegion(${name}, ...) fourth arg must be Size(bytes)`,
		);
	}
	if (!Number.isInteger(base) || base < 0) {
		throw new Error(`wishbone-bus: slave ${name} base must be >= 0`);
	}
	const { tag, pipe } = parseSlaveOpts(name, tagOrOpts);
	const mask = deriveWindowMask(size.bytes, 32);
	if ((base & mask) >>> 0 !== base >>> 0) {
		throw new Error(
			`wishbone-bus: slave ${name} base 0x${base.toString(16)} is not aligned to Size(0x${size.bytes.toString(16)}) mask 0x${mask.toString(16)}`,
		);
	}
	return {
		name,
		desc,
		base,
		mask,
		pipe,
		size: size.bytes,
		mask_auto: true,
		window: "region",
		...(tag ? { tag } : {}),
	};
}

/** Hang a wishbone-regfile leaf on this bus (distinct from string `Slave`). */
export function SlaveRegfile(
	regfile: RegfileDef,
	base: number,
	opts?: SlaveRegfileOpts,
): WbSlave {
	if (!isRegfileDef(regfile)) {
		throw new Error(
			"wishbone-bus: SlaveRegfile(...) first arg is not a RegfileDef",
		);
	}
	if (!Number.isInteger(base) || base < 0) {
		throw new Error(
			"wishbone-bus: SlaveRegfile(regfile, base, opts?) base must be >= 0",
		);
	}
	return attachRegfile(regfile, base, opts ?? {});
}

/**
 * Inclusive end of a slave decode window (`base + windowBytes`).
 * Used to size a parent `SlaveBus` hang over a child fabric.
 */
export function busByteSpan(def: BusDef): number {
	let end = 0;
	for (const s of def.slaves) {
		const win = windowBytes(s.mask, def.addr_width);
		const e = (s.base + win) >>> 0;
		if (e > end) end = e;
	}
	return end < 1 ? 1 : end;
}

/**
 * Hang a child `BusDef` as a Region window. Child RTL is generated once;
 * each hang is a separate instance. Child addresses are window-relative
 * (parent already forwards `adr & ~mask`). Child must declare `Master("uplink")`
 * (or `opts.uplink`) as the cascade face.
 */
export function SlaveBus(
	child: BusDef,
	base: number,
	opts?: SlaveBusOpts,
): WbSlave {
	if (!isBusDef(child)) {
		throw new Error("wishbone-bus: SlaveBus(...) first arg is not a BusDef");
	}
	if (!Number.isInteger(base) || base < 0) {
		throw new Error(
			"wishbone-bus: SlaveBus(bus, base, opts?) base must be >= 0",
		);
	}
	const uplink = opts?.uplink ?? UPLINK_MASTER;
	const face = child.masters.find((m) => m.name === uplink);
	if (!face) {
		throw new Error(
			`wishbone-bus: SlaveBus(${child.name}) needs Master("${uplink}") as the cascade face`,
		);
	}
	if (isBridgedMaster(face)) {
		throw new Error(
			`wishbone-bus: SlaveBus(${child.name}) cascade face "${uplink}" cannot use apb/jtag/cdc`,
		);
	}
	const span = busByteSpan(child);
	const size = opts?.size ?? Size(span);
	if (!isRegionSize(size)) {
		throw new Error(
			`wishbone-bus: SlaveBus(${opts?.id ?? child.name}, ...) size must be Size(bytes)`,
		);
	}
	const name = opts?.id ?? child.name;
	// Tag width is a property of the child fabric, not a per-hang hand-off.
	if (opts?.tag !== undefined && opts.tag !== child.tag_width) {
		throw new Error(
			`wishbone-bus: SlaveBus(${name}) tag ${opts.tag} != child "${child.name}" tag_width ${child.tag_width}`,
		);
	}
	const region = SlaveRegion(name, opts?.desc ?? child.desc, base, size, {
		tag: child.tag_width > 0 ? child.tag_width : opts?.tag,
		pipe: opts?.pipe,
	});
	const win = windowBytes(region.mask, 32);
	if (win < span) {
		throw new Error(
			`wishbone-bus: slave ${name} window 0x${win.toString(16)} is smaller than child "${child.name}" span 0x${span.toString(16)}`,
		);
	}
	return { ...region, bus: child, uplink };
}

/** Child fabrics hung via `SlaveBus`, depth-first, unique by `BusDef.name`. */
export function flattenBuses(listed: readonly BusDef[]): BusDef[] {
	const out: BusDef[] = [];
	const seen = new Set<string>();
	const walk = (def: BusDef): void => {
		for (const s of def.slaves) {
			if (s.bus) walk(s.bus);
		}
		if (seen.has(def.name)) return;
		seen.add(def.name);
		out.push(def);
	};
	for (const def of listed) walk(def);
	return out;
}

function assertAcyclicBus(def: BusDef, stack: string[]): void {
	if (stack.includes(def.name)) {
		throw new Error(
			`wishbone-bus: cyclic SlaveBus ${[...stack, def.name].join(" -> ")}`,
		);
	}
	const next = [...stack, def.name];
	for (const s of def.slaves) {
		if (s.bus) assertAcyclicBus(s.bus, next);
	}
}

export function Master(
	name: string,
	desc: string,
	opts: MasterOpts = {},
): WbMaster {
	requireIdent("master", name);
	if (opts.apb && opts.jtag) {
		throw new Error(`wishbone-bus: master ${name} cannot be both apb and jtag`);
	}
	const bridge: WbMasterBridge = opts.apb ? "apb" : opts.jtag ? "jtag" : "wb";
	if (bridge === "jtag" && opts.cdc === false) {
		throw new Error(
			`wishbone-bus: master ${name} jtag always crosses from TCK (cdc cannot be false)`,
		);
	}
	const cdc = bridge === "jtag" || opts.cdc === true;
	const pipe = opts.pipe ?? 0;
	if (!Number.isInteger(pipe) || pipe < 0 || pipe > 16) {
		throw new Error(`wishbone-bus: master ${name} pipe must be 0..16`);
	}
	const timeout = opts.timeout ?? 0;
	if (!Number.isInteger(timeout) || timeout < 0 || timeout > 0xffff) {
		throw new Error(`wishbone-bus: master ${name} timeout must be 0..65535`);
	}
	if (timeout > 0 && !cdc) {
		throw new Error(`wishbone-bus: master ${name} timeout needs cdc`);
	}
	if (bridge === "wb" && !cdc) return { name, desc, pipe };
	const m: WbMaster = { name, desc, bridge, cdc, timeout, pipe };
	if (bridge === "apb") {
		const p = opts.apb === true ? undefined : opts.apb?.pprot;
		if (p === undefined) return m;
		const mask = p.mask ?? 0b111;
		for (const [k, v] of [
			["value", p.value],
			["mask", mask],
		] as const) {
			if (!Number.isInteger(v) || v < 0 || v > 7) {
				throw new Error(`wishbone-bus: master ${name} pprot ${k} must be 0..7`);
			}
		}
		if ((p.value & ~mask) !== 0) {
			throw new Error(
				`wishbone-bus: master ${name} pprot value sets bits outside mask`,
			);
		}
		return { ...m, pprot: { value: p.value, mask } };
	}
	if (bridge === "jtag") {
		const idle = (opts.jtag === true ? undefined : opts.jtag?.idle) ?? 16;
		if (!Number.isInteger(idle) || idle < 1 || idle > 0xffff) {
			throw new Error(
				`wishbone-bus: master ${name} jtag idle must be 1..65535`,
			);
		}
		return { ...m, idle };
	}
	return m;
}

function resolveRegion(s: WbSlave, addrWidth: number): WbSlave {
	if (s.size === undefined) return s;
	const mask = deriveWindowMask(s.size, addrWidth);
	if ((s.base & mask) >>> 0 !== s.base >>> 0) {
		throw new Error(
			`wishbone-bus: slave ${s.name} base 0x${s.base.toString(16)} is not aligned to Size(0x${s.size.toString(16)}) mask 0x${mask.toString(16)}`,
		);
	}
	return { ...s, mask };
}

function resolveAttached(s: WbSlave, addrWidth: number): WbSlave {
	const rf = s.regfile;
	if (!rf) return resolveRegion(s, addrWidth);
	const laid = layoutRegfile(rf);
	if ((s.tag ?? 0) !== laid.tga_width) {
		throw new Error(
			`wishbone-bus: slave ${s.name} tag ${s.tag ?? 0} != regfile "${rf.name}" tga_width ${laid.tga_width}`,
		);
	}
	if (rf.addr_width > addrWidth) {
		throw new Error(
			`wishbone-bus: slave ${s.name} regfile addr_width ${rf.addr_width} exceeds bus ${addrWidth}`,
		);
	}
	const span = layoutByteSpan(laid);
	const sizeBytes = s.size ?? span;
	const mask = deriveWindowMask(sizeBytes, addrWidth);
	if ((s.base & mask) >>> 0 !== s.base >>> 0) {
		throw new Error(
			`wishbone-bus: slave ${s.name} base 0x${s.base.toString(16)} is not aligned to Size(0x${sizeBytes.toString(16)}) mask 0x${mask.toString(16)}`,
		);
	}
	const win = windowBytes(mask, addrWidth);
	if (win < span) {
		throw new Error(
			`wishbone-bus: slave ${s.name} window 0x${win.toString(16)} is smaller than layout span 0x${span.toString(16)}`,
		);
	}
	return { ...s, mask, size: sizeBytes, window: "region" };
}

function hexWin(n: number): string {
	return `0x${(n >>> 0).toString(16)}`;
}

/**
 * Pow2-aligned regions overlap iff one decode window contains the other's base.
 * Raw `Slave(mask)` ports are excluded.
 */
export function regionWindowsOverlap(a: WbSlave, b: WbSlave): boolean {
	return (
		(a.base & b.mask) >>> 0 === b.base >>> 0 ||
		(b.base & a.mask) >>> 0 === a.base >>> 0
	);
}

function assertNoRegionOverlap(
	bus: string,
	slaves: readonly WbSlave[],
	addrWidth: number,
): void {
	const regions = slaves.filter((s) => s.window === "region");
	for (let i = 0; i < regions.length; i++) {
		for (let j = i + 1; j < regions.length; j++) {
			const a = regions[i];
			const b = regions[j];
			if (!a || !b || !regionWindowsOverlap(a, b)) continue;
			const aSize = a.size ?? windowBytes(a.mask, addrWidth);
			const bSize = b.size ?? windowBytes(b.mask, addrWidth);
			throw new Error(
				`wishbone-bus: bus ${bus} region "${a.name}" (${hexWin(a.base)} Size(${hexWin(aSize)})) overlaps "${b.name}" (${hexWin(b.base)} Size(${hexWin(bSize)}))`,
			);
		}
	}
}

export function Bus(
	name: string,
	desc: string,
	opts: {
		masters?: readonly WbMaster[];
		slaves: readonly WbSlave[];
		addrWidth?: number;
		tagWidth?: number;
		/** Tag domains, low slice first. Bare domain = pass through from uplink. */
		tags?: readonly (ShadowDomainDef | WbTagSource)[];
	},
): BusDef {
	requireIdent("bus", name);
	const masters = opts.masters ?? [];
	const masterNames = new Set<string>();
	for (const m of masters) {
		if (masterNames.has(m.name)) {
			throw new Error(`wishbone-bus: duplicate master "${m.name}"`);
		}
		masterNames.add(m.name);
		if (m.name === UPLINK_MASTER && isBridgedMaster(m)) {
			throw new Error(
				`wishbone-bus: bus ${name} cascade face "${UPLINK_MASTER}" cannot use apb/jtag/cdc`,
			);
		}
	}
	if (opts.slaves.length === 0) {
		throw new Error(`wishbone-bus: bus ${name} needs at least one slave`);
	}
	const addr_width = opts.addrWidth ?? 32;
	if (addr_width < 2 || addr_width > 64) {
		throw new Error(`wishbone-bus: addr_width out of range`);
	}
	const slaves = opts.slaves.map((s) => resolveAttached(s, addr_width));
	const seen = new Set<string>();
	for (const s of slaves) {
		if (seen.has(s.name)) {
			throw new Error(`wishbone-bus: duplicate slave "${s.name}"`);
		}
		seen.add(s.name);
	}
	assertNoRegionOverlap(name, slaves, addr_width);
	const declared = normalizeTags(name, opts.tags ?? []);
	const anonymous = anonymousTag(slaves, declared);
	const tags = anonymous ? [...declared, anonymous] : declared;
	const tag_width = opts.tagWidth ?? tagDomainsWidth(tags);
	if (!Number.isInteger(tag_width) || tag_width < 0) {
		throw new Error(`wishbone-bus: tag_width must be an integer >= 0`);
	}
	assertTagAddrFree(name, tags, slaves);
	for (const s of slaves) {
		if ((s.tag ?? 0) > tag_width) {
			throw new Error(
				`wishbone-bus: slave ${s.name} tag exceeds bus tag width`,
			);
		}
	}
	const def: BusDef = {
		kind: "wishbone-bus",
		name,
		desc,
		masters,
		slaves,
		addr_width,
		tag_width,
		tags,
	};
	assertAcyclicBus(def, []);
	assertTagSingleSource(def, new Map());
	return def;
}

/** Bare domain → pass-through source; reject duplicate domains on one bus. */
function normalizeTags(
	bus: string,
	tags: readonly (ShadowDomainDef | WbTagSource)[],
): WbTagSource[] {
	const out: WbTagSource[] = [];
	const seen = new Set<string>();
	for (const t of tags) {
		const src = isTagSource(t)
			? t
			: isShadowDomain(t)
				? tagSource(t, "uplink")
				: null;
		if (!src) {
			throw new Error(
				`wishbone-bus: bus ${bus} tags entry must be a ShadowDomain or TagFrom*(...)`,
			);
		}
		if (seen.has(src.domain.name)) {
			throw new Error(
				`wishbone-bus: bus ${bus} declares tag domain "${src.domain.name}" twice`,
			);
		}
		seen.add(src.domain.name);
		out.push(src);
	}
	return out;
}

/** A numeric Slave tag with no declared domains is one anonymous pass-through. */
function anonymousTag(
	slaves: readonly WbSlave[],
	declared: readonly WbTagSource[],
): WbTagSource | undefined {
	const width = Math.max(0, ...slaves.map((s) => s.tag ?? 0));
	if (width === 0 || declared.length > 0) return undefined;
	return tagSource(
		{
			kind: "wishbone-shadow-domain",
			name: "tag",
			copies: 1 << width,
			tag_width: width,
			innerShadowMux: true,
		},
		"uplink",
	);
}

/**
 * `TagFromAddr` bits are stripped from decode, so they must not be a window
 * offset bit of any slave (mask==0 region) nor set in any base.
 */
function assertTagAddrFree(
	bus: string,
	tags: readonly WbTagSource[],
	slaves: readonly WbSlave[],
): void {
	const mask = tagAddrMask(tags);
	if (mask === 0) return;
	const hex = (n: number) => `0x${n.toString(16)}`;
	for (const s of slaves) {
		const inside = (mask & ~s.mask) >>> 0;
		if (inside !== 0) {
			throw new Error(
				`wishbone-bus: bus ${bus} tag address bits ${hex(inside)} fall inside slave "${s.name}" window (mask ${hex(s.mask)})`,
			);
		}
		if ((s.base & mask) >>> 0) {
			throw new Error(
				`wishbone-bus: bus ${bus} slave "${s.name}" base ${hex(s.base)} sets tag address bits ${hex(mask)}`,
			);
		}
	}
}

/** A domain may be produced at most once along an uplink path. */
function assertTagSingleSource(
	def: BusDef,
	produced: Map<string, string>,
): void {
	const here = new Map(produced);
	for (const t of def.tags) {
		if (t.source === "uplink") continue;
		const owner = here.get(t.domain.name);
		if (owner !== undefined) {
			throw new Error(
				`wishbone-bus: tag domain "${t.domain.name}" is produced by bus "${owner}" and again by "${def.name}"`,
			);
		}
		here.set(t.domain.name, def.name);
	}
	for (const s of def.slaves) {
		if (s.bus) assertTagSingleSource(s.bus, here);
	}
}
