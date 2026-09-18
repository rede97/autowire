// Wishbone-bus authoring DSL (SoT). Contract: docs/plugins/wishbone-bus.md.

import { isRegfileDef, type RegfileDef } from "../wishbone-regfile/dsl.ts";
import { layoutByteSpan, layoutRegfile } from "../wishbone-regfile/layout.ts";

export type SlaveOpts = {
	/** TGA width (bits) forwarded to this slave; omitted/0 = no TGA port. */
	readonly tag?: number;
	/**
	 * Posted-write / blocking-read register stages inserted on this slave
	 * port (0 = combinational). Master-side pipe is not configured here —
	 * it comes from the parent fabric that drives this bus's master ports.
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
	/** Override auto-derived window mask (pow2 span of the laid-out leaf). */
	readonly mask?: number;
	/** Override `RegfileDef.desc` on this hang. */
	readonly desc?: string;
};

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
	/** Mask was derived from layout span; Bus may re-derive with `addr_width`. */
	readonly mask_auto?: boolean;
};

export type WbMaster = {
	readonly name: string;
	readonly desc: string;
};

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
	requireIdent("slave", name);
	if (!Number.isInteger(base) || base < 0) {
		throw new Error(`wishbone-bus: slave ${name} base must be >= 0`);
	}
	const { tag: tagOpt, pipe } = parseSlaveOpts(name, {
		tag: opts.tag,
		pipe: opts.pipe,
	});
	const laid = layoutRegfile(regfile);
	const tga = laid.tga_width;
	if (tagOpt !== undefined && tagOpt !== tga) {
		throw new Error(
			`wishbone-bus: slave ${name} tag ${tagOpt} != regfile "${regfile.name}" tga_width ${tga}`,
		);
	}
	const tag = tga > 0 ? tga : undefined;
	const span = layoutByteSpan(laid);
	const maskAuto = opts.mask === undefined;
	const mask = maskAuto ? deriveWindowMask(span, 32) : opts.mask;
	if (!Number.isInteger(mask) || mask < 0) {
		throw new Error(`wishbone-bus: slave ${name} mask must be >= 0`);
	}
	if ((base & mask) >>> 0 !== base >>> 0) {
		throw new Error(
			`wishbone-bus: slave ${name} base 0x${base.toString(16)} is not aligned to mask 0x${mask.toString(16)}`,
		);
	}
	const win = windowBytes(mask, 32);
	if (win < span) {
		throw new Error(
			`wishbone-bus: slave ${name} window 0x${win.toString(16)} is smaller than layout span 0x${span.toString(16)}`,
		);
	}
	const desc = opts.desc ?? regfile.desc;
	return {
		name,
		desc,
		base,
		mask,
		pipe,
		regfile,
		...(tag ? { tag } : {}),
		...(maskAuto ? { mask_auto: true } : {}),
	};
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
	return { name, desc, base, mask, pipe, ...(tag ? { tag } : {}) };
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

export function Master(name: string, desc: string): WbMaster {
	requireIdent("master", name);
	return { name, desc };
}

function resolveAttached(s: WbSlave, addrWidth: number): WbSlave {
	const rf = s.regfile;
	if (!rf) return s;
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
	const mask = s.mask_auto ? deriveWindowMask(span, addrWidth) : s.mask;
	if ((s.base & mask) >>> 0 !== s.base >>> 0) {
		throw new Error(
			`wishbone-bus: slave ${s.name} base 0x${s.base.toString(16)} is not aligned to mask 0x${mask.toString(16)}`,
		);
	}
	const win = windowBytes(mask, addrWidth);
	if (win < span) {
		throw new Error(
			`wishbone-bus: slave ${s.name} window 0x${win.toString(16)} is smaller than layout span 0x${span.toString(16)}`,
		);
	}
	return { ...s, mask };
}

export function Bus(
	name: string,
	desc: string,
	opts: {
		masters?: readonly WbMaster[];
		slaves: readonly WbSlave[];
		addrWidth?: number;
		tagWidth?: number;
	},
): BusDef {
	requireIdent("bus", name);
	const masters = opts.masters ?? [];
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
	const tag_width =
		opts.tagWidth ?? Math.max(0, ...slaves.map((s) => s.tag ?? 0));
	if (!Number.isInteger(tag_width) || tag_width < 0) {
		throw new Error(`wishbone-bus: tag_width must be an integer >= 0`);
	}
	for (const s of slaves) {
		if ((s.tag ?? 0) > tag_width) {
			throw new Error(
				`wishbone-bus: slave ${s.name} tag exceeds bus tag width`,
			);
		}
	}
	return {
		kind: "wishbone-bus",
		name,
		desc,
		masters,
		slaves,
		addr_width,
		tag_width,
	};
}
