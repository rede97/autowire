// Wishbone-bus authoring DSL (SoT). Contract: docs/plugins/wishbone-bus.md.

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

export function Slave(
	name: string,
	desc: string,
	base: number,
	mask: number,
	tagOrOpts?: number | SlaveOpts,
): WbSlave {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
		throw new Error(`wishbone-bus: bad slave name "${name}"`);
	}
	if (!Number.isInteger(base) || base < 0) {
		throw new Error(`wishbone-bus: slave ${name} base must be >= 0`);
	}
	if (!Number.isInteger(mask) || mask < 0) {
		throw new Error(`wishbone-bus: slave ${name} mask must be >= 0`);
	}
	const { tag, pipe } = parseSlaveOpts(name, tagOrOpts);
	return { name, desc, base, mask, pipe, ...(tag ? { tag } : {}) };
}

export function Master(name: string, desc: string): WbMaster {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
		throw new Error(`wishbone-bus: bad master name "${name}"`);
	}
	return { name, desc };
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
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
		throw new Error(`wishbone-bus: bad bus name "${name}"`);
	}
	const masters = opts.masters ?? [];
	const slaves = opts.slaves;
	if (slaves.length === 0) {
		throw new Error(`wishbone-bus: bus ${name} needs at least one slave`);
	}
	const seen = new Set<string>();
	for (const s of slaves) {
		if (seen.has(s.name)) {
			throw new Error(`wishbone-bus: duplicate slave "${s.name}"`);
		}
		seen.add(s.name);
	}
	const addr_width = opts.addrWidth ?? 32;
	if (addr_width < 2 || addr_width > 64) {
		throw new Error(`wishbone-bus: addr_width out of range`);
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
