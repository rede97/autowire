// Wishbone-regfile authoring DSL (SoT factories + IR). Contract: docs/plugins/wishbone-regfile.md.
// Samples live in docs/examples/regfile/regfile.ts.
// - offset omitted by default → compiler-style pack by bytes_align
// - optional Cell/Block offset only to pin placement (regfile-relative / parent-relative)
// - Field.offset() is bit offset inside the cell (distinct from Cell/Block address offset)
// - DAT/cell fixed 32; field: width + optional offset (no bits=)
// - cell bits_align default Align8; values: BitsAlign enum (1|2|4|8|16)
// - block wide fields auto-split; sideband outputs auto-concat to full width; bytes_align ×4
// - Field / Cell / Block / Regfile: desc is required (maintainability)
// - opts: cascading XxxDefault.align(...).offset(...) (immutable)
// - Field: fluent .offset() / .reset() / .note() (no per-field shadow)
// - .note() is Excel-only (cell comment, or NOTES sheet for the regfile); not RTL/C/uvm
// - Field.reset: number | Record<copyIndex, number> (per-shadow-copy defaults)
// - Shadow only on Cell (+ Block.shadow as default for child cells); one cell → one shadow
// - Shadow(name, copies, tagBits).remaps({ from: bitmask }).innerShadowMux(bool); Access has RC, no W1S
// - tagBits is required (always owns a wb_tga slice; width must match ceil(log2(copies)))
// - remaps to = physical-copy bitmask (e.g. 0b0100 → copy2; 0b1111 → broadcast all 4)
// - Shadow.inner_shadow_mux default true: i_<domain>_mux_sel muxes sidebands; false: export all copies
//   (RWE: post-decode sel as-is; RO: shadow via bus tag, ignores inner_shadow_mux)

export enum Access {
	RC = "RC",
	RO = "RO",
	RW = "RW",
	RWW = "RWW",
	RWE = "RWE",
	W1P = "W1P",
	W1C = "W1C",
}

/**
 * Master-branch AccessType.prefix (RG_NAME_PREFIX on):
 * RO→ro, RW/RWW→rg, RWE→ext, W1P→p_rg, W1C→c_rg. RC has no sideband.
 */
export function accessPortPrefix(access: Access): string | null {
	switch (access) {
		case Access.RO:
			return "ro";
		case Access.RW:
		case Access.RWW:
			return "rg";
		case Access.RWE:
			return "ext";
		case Access.W1P:
			return "p_rg";
		case Access.W1C:
			return "c_rg";
		case Access.RC:
			return null;
	}
}

/** Master AccessType.ral_name. RC has no Python twin → RO. */
export function accessRalName(access: Access): string {
	switch (access) {
		case Access.RW:
		case Access.RWW:
		case Access.RWE:
			return "RW";
		case Access.W1P:
		case Access.W1C:
			return "W1C";
		case Access.RO:
		case Access.RC:
			return "RO";
	}
}

/** Master AccessType.ral_rand. */
export function accessRalRand(access: Access): boolean {
	return access === Access.RW || access === Access.RWW || access === Access.RWE;
}

/**
 * Sideband port stem (no i_/o_): `{prefix}_{field.name}`, or field.name if
 * it already starts with the Access prefix (same as master proc_name).
 */
export function sidebandStem(field: { name: string; access: Access }): string {
	const prefix = accessPortPrefix(field.access);
	if (prefix === null) {
		throw new Error(
			`Access.${field.access} field "${field.name}" has no sideband port`,
		);
	}
	if (field.name === prefix || field.name.startsWith(prefix)) {
		return field.name;
	}
	return `${prefix}_${field.name}`;
}

export enum BitsAlign {
	Align1 = 1,
	Align2 = 2,
	Align4 = 4,
	Align8 = 8,
	Align16 = 16,
}

/** Byte alignment; positive integer multiple of 4 (checked in *.align()). */
export type BytesAlign = number;

function requireBytesAlign(bytes_align: number): BytesAlign {
	if (
		!Number.isInteger(bytes_align) ||
		bytes_align <= 0 ||
		bytes_align % 4 !== 0
	) {
		throw new Error(
			`bytes_align must be a positive multiple of 4, got ${bytes_align}`,
		);
	}
	return bytes_align;
}

// ---------------------------------------------------------------------------
// Plain data (layout IR)
// ---------------------------------------------------------------------------

/**
 * Field reset / RC constant.
 * - `number`: one value for all copies (or non-shadowed field).
 * - `Record<copyIndex, number>`: per physical shadow-copy default (keys = copy indices).
 *   Omitted copies default to **0** at generate (not an error).
 */
export type FieldReset = number | Readonly<Record<number, number>>;

function requireFieldReset(value: FieldReset): FieldReset {
	if (typeof value === "number") {
		if (!Number.isInteger(value)) {
			throw new Error(`reset must be an integer, got ${value}`);
		}
		return value;
	}
	const out: Record<number, number> = {};
	for (const [k, v] of Object.entries(value)) {
		const idx = Number(k);
		if (!Number.isInteger(idx) || idx < 0) {
			throw new Error(
				`reset dict key must be a non-negative integer, got ${k}`,
			);
		}
		if (!Number.isInteger(v)) {
			throw new Error(
				`reset dict value for copy ${idx} must be an integer, got ${v}`,
			);
		}
		out[idx] = v;
	}
	return out;
}

/** Drop a blank template-literal frame and the shared indent. Empty → undefined. */
export function normalizeNote(text: string): string | undefined {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
	while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") {
		lines.pop();
	}
	if (lines.length === 0) return undefined;
	let min = Number.POSITIVE_INFINITY;
	for (const line of lines) {
		if (line.trim() === "") continue;
		const indent = /^[ \t]*/.exec(line);
		min = Math.min(min, indent ? indent[0].length : 0);
	}
	if (!Number.isFinite(min)) min = 0;
	const out = lines
		.map((line) => (line.trim() === "" ? "" : line.slice(min)))
		.join("\n");
	return out.length > 0 ? out : undefined;
}

export interface RegField {
	readonly name: string;
	readonly access: Access;
	readonly width: number;
	readonly desc: string;
	readonly offset?: number;
	readonly reset?: FieldReset;
	/** Excel cell comment only. Not emitted to RTL, C, or uvm_reg. */
	readonly note?: string;
}

export interface RegCell {
	readonly name: string;
	readonly desc: string;
	/** Address offset in the containing regfile (omit → auto layout). */
	readonly offset?: number;
	readonly bits_align?: BitsAlign;
	/**
	 * Shadow bank for this entire cell. All packed fields share it;
	 * mixing different shadows in one cell is forbidden.
	 */
	readonly shadow?: string;
	readonly fields: readonly RegField[];
}

export interface RegBlock {
	readonly name: string;
	readonly desc: string;
	/** Address offset relative to parent (omit → auto layout). */
	readonly offset?: number;
	readonly bytes_align?: BytesAlign;
	/** Default shadow for child cells that omit CellDefault.shadow(...). */
	readonly shadow?: string;
	/** Cells and/or wide fields (width>32 → generate auto-splits; outputs auto-concat). */
	readonly children: readonly (RegCell | RegField)[];
}

/**
 * from-index → physical-copy **bitmask** (bit k set ⇒ hit copy k).
 * Single copy k: `1 << k`. Broadcast all N copies: `(1 << N) - 1` (e.g. 4 → `0b1111`).
 * No separate broadcast symbol.
 */
export type ShadowRemapTo = number;
export type ShadowRemapMap = Readonly<Record<number, ShadowRemapTo>>;

function requireRemapMap(map: ShadowRemapMap, copies: number): ShadowRemapMap {
	const maxMask = (1 << copies) - 1;
	const out: Record<number, number> = {};
	for (const [k, v] of Object.entries(map)) {
		const from = Number(k);
		if (!Number.isInteger(from) || from < 0) {
			throw new Error(`remaps key must be a non-negative integer, got ${k}`);
		}
		if (!Number.isInteger(v) || v < 0) {
			throw new Error(
				`remaps[${from}] must be a non-negative integer bitmask, got ${v}`,
			);
		}
		if (v > maxMask) {
			throw new Error(
				`remaps[${from}]=${v} has bits beyond copies=${copies} (max mask ${maxMask})`,
			);
		}
		if (v === 0) {
			throw new Error(
				`remaps[${from}]=0 hits no copies; use a non-zero bitmask`,
			);
		}
		out[from] = v;
	}
	return out;
}

export interface RegShadow {
	readonly name: string;
	readonly copies: number;
	/** Width of this domain's own TGA port. Domains are never packed together. */
	readonly tag_width: number;
	/**
	 * Legacy global slice (`"hi:lo"`). Equal-width domains must not share one
	 * vector; new code uses `tag_width` and a named `*_tga_<domain>` port.
	 */
	readonly tag_bits?: string;
	readonly remaps?: ShadowRemapMap;
	/**
	 * When true (default): `i_<domain>_mux_sel` picks one copy for applicable
	 * Access sidebands. `o_<domain>_sel` stays the address-tag decode and is
	 * not that mux.
	 * When false: export per-copy sidebands (e.g. RWW `_strb`/`_hwdata` as arrays).
	 *
	 * Access.RO: ignored — RO inputs are always per-copy arrays; bus read ORs
	 * copies selected by the post-remap bitmask.
	 * Access.RWE: does not change data-port shape; post-decode sel is exported as-is.
	 */
	readonly inner_shadow_mux: boolean;
}

export interface RegfileOpts {
	readonly sheet?: string;
	readonly addr_width: number;
	readonly bytes_align?: BytesAlign;
	/**
	 * When true, Wishbone R/W that hit an RWE field may stall (ACK held)
	 * until the external window (e.g. FIFO) is ready.
	 * When false (default): non-blocking — ACK follows the table's normal timing.
	 */
	readonly read_write_block?: boolean;
	/** Table-level shadow library (omit when none). */
	readonly shadows?: readonly RegShadow[];
	/** Excel NOTES sheet only. Not emitted to RTL, C, or uvm_reg. */
	readonly note?: string;
}

export interface RegfileDef {
	readonly name: string;
	readonly desc: string;
	readonly sheet?: string;
	readonly addr_width: number;
	readonly bytes_align?: BytesAlign;
	readonly read_write_block: boolean;
	readonly shadows: readonly RegShadow[];
	/** Excel NOTES sheet only. Not emitted to RTL, C, or uvm_reg. */
	readonly note?: string;
	readonly body: readonly (RegBlock | RegCell)[];
}

/** Runtime guard for dynamically imported SoT exports. */
export function isRegfileDef(v: unknown): v is RegfileDef {
	if (v === null || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.name === "string" &&
		typeof o.desc === "string" &&
		typeof o.addr_width === "number" &&
		typeof o.read_write_block === "boolean" &&
		Array.isArray(o.shadows) &&
		Array.isArray(o.body)
	);
}

const SHEET_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Software/docs table id: `sheet` if set, else `name`. Shared by instances. */
export function effectiveSheet(
	def: Pick<RegfileDef, "name" | "sheet">,
): string {
	const raw = def.sheet?.trim() ?? "";
	const sheet = raw.length > 0 ? raw : def.name;
	if (!SHEET_IDENT.test(sheet)) {
		throw new Error(
			`wishbone-regfile: sheet "${sheet}" must match [A-Za-z_][A-Za-z0-9_]*`,
		);
	}
	return sheet;
}

export type RegBlockChild = RegCell | FieldElem;

// ---------------------------------------------------------------------------
// Cascading opts — XxxDefault.align(...).offset(...)
// ---------------------------------------------------------------------------

export class CellOptsElem {
	readonly #offset?: number;
	readonly #bits_align?: BitsAlign;
	readonly #shadow?: string;

	private constructor(
		offset?: number,
		bits_align?: BitsAlign,
		shadow?: string,
	) {
		this.#offset = offset;
		this.#bits_align = bits_align;
		this.#shadow = shadow;
	}

	static empty(): CellOptsElem {
		return new CellOptsElem();
	}

	align(bits_align: BitsAlign): CellOptsElem {
		return new CellOptsElem(this.#offset, bits_align, this.#shadow);
	}

	/** Address offset in the regfile. */
	offset(offset: number): CellOptsElem {
		return new CellOptsElem(offset, this.#bits_align, this.#shadow);
	}

	/** Shadow for this entire cell (all packed fields share it). */
	shadow(name: string | ShadowDomainDef): CellOptsElem {
		return new CellOptsElem(
			this.#offset,
			this.#bits_align,
			isShadowDomain(name) ? name.name : name,
		);
	}

	toOpts(): {
		offset?: number;
		bits_align?: BitsAlign;
		shadow?: string;
	} {
		return {
			...(this.#offset !== undefined ? { offset: this.#offset } : {}),
			...(this.#bits_align !== undefined
				? { bits_align: this.#bits_align }
				: {}),
			...(this.#shadow !== undefined ? { shadow: this.#shadow } : {}),
		};
	}
}

export const CellDefault = CellOptsElem.empty();

export class BlockOptsElem {
	readonly #offset?: number;
	readonly #bytes_align?: BytesAlign;
	readonly #shadow?: string;

	private constructor(
		offset?: number,
		bytes_align?: BytesAlign,
		shadow?: string,
	) {
		this.#offset = offset;
		this.#bytes_align = bytes_align;
		this.#shadow = shadow;
	}

	static empty(): BlockOptsElem {
		return new BlockOptsElem();
	}

	byteAlign(bytes_align: number): BlockOptsElem {
		return new BlockOptsElem(
			this.#offset,
			requireBytesAlign(bytes_align),
			this.#shadow,
		);
	}

	/** Address offset relative to parent. */
	offset(offset: number): BlockOptsElem {
		return new BlockOptsElem(offset, this.#bytes_align, this.#shadow);
	}

	/** Default shadow for child cells that omit their own CellDefault.shadow(...). */
	shadow(name: string): BlockOptsElem {
		return new BlockOptsElem(this.#offset, this.#bytes_align, name);
	}

	toOpts(): {
		offset?: number;
		bytes_align?: BytesAlign;
		shadow?: string;
	} {
		return {
			...(this.#offset !== undefined ? { offset: this.#offset } : {}),
			...(this.#bytes_align !== undefined
				? { bytes_align: this.#bytes_align }
				: {}),
			...(this.#shadow !== undefined ? { shadow: this.#shadow } : {}),
		};
	}
}

export const BlockDefault = BlockOptsElem.empty();

export class RegfileOptsElem {
	readonly #sheet?: string;
	readonly #addr_width?: number;
	readonly #bytes_align?: BytesAlign;
	readonly #read_write_block?: boolean;
	readonly #shadows?: readonly RegShadow[];
	readonly #note?: string;

	private constructor(
		sheet?: string,
		addr_width?: number,
		bytes_align?: BytesAlign,
		read_write_block?: boolean,
		shadows?: readonly RegShadow[],
		note?: string,
	) {
		this.#sheet = sheet;
		this.#addr_width = addr_width;
		this.#bytes_align = bytes_align;
		this.#read_write_block = read_write_block;
		this.#shadows = shadows;
		this.#note = note;
	}

	static empty(): RegfileOptsElem {
		return new RegfileOptsElem();
	}

	align(bytes_align: number): RegfileOptsElem {
		return new RegfileOptsElem(
			this.#sheet,
			this.#addr_width,
			requireBytesAlign(bytes_align),
			this.#read_write_block,
			this.#shadows,
			this.#note,
		);
	}

	addrWidth(addr_width: number): RegfileOptsElem {
		return new RegfileOptsElem(
			this.#sheet,
			addr_width,
			this.#bytes_align,
			this.#read_write_block,
			this.#shadows,
			this.#note,
		);
	}

	sheet(sheet: string): RegfileOptsElem {
		return new RegfileOptsElem(
			sheet,
			this.#addr_width,
			this.#bytes_align,
			this.#read_write_block,
			this.#shadows,
			this.#note,
		);
	}

	/**
	 * Wishbone may stall on RWE hits (e.g. FIFO full/empty).
	 * Default / omit = false (non-blocking).
	 */
	readWriteBlock(enabled: boolean): RegfileOptsElem {
		return new RegfileOptsElem(
			this.#sheet,
			this.#addr_width,
			this.#bytes_align,
			enabled,
			this.#shadows,
			this.#note,
		);
	}

	/** Long delivery note. Excel NOTES sheet only; desc stays the one-line summary. */
	note(text: string): RegfileOptsElem {
		return new RegfileOptsElem(
			this.#sheet,
			this.#addr_width,
			this.#bytes_align,
			this.#read_write_block,
			this.#shadows,
			normalizeNote(text),
		);
	}

	shadows(...shadows: (ShadowElem | ShadowDomainDef)[]): RegfileOptsElem {
		return new RegfileOptsElem(
			this.#sheet,
			this.#addr_width,
			this.#bytes_align,
			this.#read_write_block,
			shadows.map((s) =>
				isShadowDomain(s) ? shadowOf(s).toShadow() : s.toShadow(),
			),
			this.#note,
		);
	}

	toOpts(): RegfileOpts {
		if (this.#addr_width === undefined) {
			throw new Error("Regfile opts require addrWidth(...)");
		}
		return {
			addr_width: this.#addr_width,
			...(this.#sheet !== undefined ? { sheet: this.#sheet } : {}),
			...(this.#bytes_align !== undefined
				? { bytes_align: this.#bytes_align }
				: {}),
			...(this.#read_write_block !== undefined
				? { read_write_block: this.#read_write_block }
				: {}),
			...(this.#shadows !== undefined ? { shadows: this.#shadows } : {}),
			...(this.#note !== undefined ? { note: this.#note } : {}),
		};
	}
}

/** Start cascade: RegfileDefault.align(4).addrWidth(8).shadows(...) */
export const RegfileDefault = RegfileOptsElem.empty();

// ---------------------------------------------------------------------------
// Field — fluent optional config: .offset() / .reset()
// ---------------------------------------------------------------------------

export class FieldElem {
	readonly name: string;
	readonly access: Access;
	readonly width: number;
	readonly desc: string;
	#offset?: number;
	#reset?: FieldReset;
	#note?: string;

	constructor(name: string, access: Access, width: number, desc: string) {
		this.name = name;
		this.access = access;
		this.width = width;
		this.desc = desc;
	}

	offset(bit: number): this {
		this.#offset = bit;
		return this;
	}

	/**
	 * Reset / RC constant: scalar for all copies, or `{ [copyIndex]: value }`
	 * for per-shadow-copy defaults when the containing cell is shadowed.
	 * RC fields must use a scalar integer.
	 */
	reset(value: FieldReset): this {
		const normalized = requireFieldReset(value);
		if (this.access === Access.RC && typeof normalized !== "number") {
			throw new Error(
				`Access.RC field "${this.name}" reset must be a scalar integer, not a per-copy dict`,
			);
		}
		this.#reset = normalized;
		return this;
	}

	/** Excel comment on this field's Description cell. Not emitted to RTL/C/uvm. */
	note(text: string): this {
		this.#note = normalizeNote(text);
		return this;
	}

	toField(): RegField {
		return {
			name: this.name,
			access: this.access,
			width: this.width,
			desc: this.desc,
			...(this.#offset !== undefined ? { offset: this.#offset } : {}),
			...(this.#reset !== undefined ? { reset: this.#reset } : {}),
			...(this.#note !== undefined ? { note: this.#note } : {}),
		};
	}
}

export function Field(
	name: string,
	access: Access,
	width: number,
	desc: string,
): FieldElem {
	return new FieldElem(name, access, width, desc);
}

// ---------------------------------------------------------------------------
// Cell / Block / Shadow — name, desc, opts cascade, define
// ---------------------------------------------------------------------------

export function Cell(
	name: string,
	desc: string,
	opts: CellOptsElem,
	fields: readonly FieldElem[],
): RegCell {
	const o = opts.toOpts();
	return {
		name,
		desc,
		fields: fields.map((f) => f.toField()),
		...(o.offset !== undefined ? { offset: o.offset } : {}),
		...(o.bits_align !== undefined ? { bits_align: o.bits_align } : {}),
		...(o.shadow !== undefined ? { shadow: o.shadow } : {}),
	};
}

export function Block(
	name: string,
	desc: string,
	opts: BlockOptsElem,
	children: readonly RegBlockChild[],
): RegBlock {
	const o = opts.toOpts();
	return {
		name,
		desc,
		children: children.map((x) => {
			if (x instanceof FieldElem) {
				// Wide field: generate auto-splits; split cells inherit block.shadow.
				return x.toField();
			}
			const cellShadow = x.shadow ?? o.shadow;
			return {
				...x,
				...(cellShadow !== undefined ? { shadow: cellShadow } : {}),
			};
		}),
		...(o.offset !== undefined ? { offset: o.offset } : {}),
		...(o.bytes_align !== undefined ? { bytes_align: o.bytes_align } : {}),
		...(o.shadow !== undefined ? { shadow: o.shadow } : {}),
	};
}

export class ShadowElem {
	readonly name: string;
	readonly copies: number;
	readonly tag_bits: string;
	#remaps?: ShadowRemapMap;
	#inner_shadow_mux = true;

	constructor(name: string, copies: number, tag_bits: string) {
		this.name = name;
		this.copies = copies;
		this.tag_bits = tag_bits;
	}

	remaps(map: ShadowRemapMap): this {
		this.#remaps = requireRemapMap(map, this.copies);
		return this;
	}

	/**
	 * Default true: `i_<domain>_mux_sel` muxes applicable Access sidebands.
	 * False: export per-copy sidebands (RWW `_strb`/`_hwdata` as arrays, one lane per copy).
	 * Access.RO: ignored (per-copy inputs; bus read ORs bitmask-selected copies).
	 * Access.RWE: does not change data-port shape (post-decode sel still exported as-is).
	 */
	innerShadowMux(enabled: boolean): this {
		this.#inner_shadow_mux = enabled;
		return this;
	}

	toShadow(): RegShadow {
		const { hi, lo } = parseTagBits(this.name, this.tag_bits);
		return {
			name: this.name,
			copies: this.copies,
			tag_width: hi - lo + 1,
			tag_bits: this.tag_bits,
			inner_shadow_mux: this.#inner_shadow_mux,
			...(this.#remaps !== undefined ? { remaps: this.#remaps } : {}),
		};
	}
}

/** tagBits is required: always allocates a wb_tga slice (bin; width = ceil(log2(copies))). */
export function Shadow(
	name: string,
	copies: number,
	tagBits: string,
): ShadowElem {
	return new ShadowElem(name, copies, tagBits);
}

/**
 * Shared shadow domain (contract: docs/plugins/wishbone-bus.md 2.1).
 * Declared once in its own module and imported by every RegfileDef that
 * replicates on it, plus the BusDef that carries its TGA slice. Replaces
 * copy/pasting `Shadow(name, copies, tagBits)` into each table.
 */
export interface ShadowDomainDef {
	readonly kind: "wishbone-shadow-domain";
	readonly name: string;
	readonly copies: number;
	/** Width of this domain only. Parallel domains do not share bit positions. */
	readonly tag_width: number;
	/** TGA value → physical-copy bitmask. Omitted values use identity. */
	readonly remapMap?: ShadowRemapMap;
	readonly innerShadowMux: boolean;
	readonly desc?: string;
}

export function ShadowDomain(
	name: string,
	copies: number,
	width: number,
	desc?: string,
): ShadowDomainBuilder {
	if (!Number.isInteger(copies) || copies < 1) {
		throw new Error(`shadow domain "${name}" copies must be >= 1`);
	}
	const need = copies <= 1 ? 0 : Math.ceil(Math.log2(copies));
	if (!Number.isInteger(width) || width < 1 || (need > 0 && width !== need)) {
		throw new Error(
			`shadow domain "${name}" width ${width} != ceil(log2(${copies}))=${need}`,
		);
	}
	return new ShadowDomainBuilder(name, copies, width, desc);
}

/** TGA→one-hot mapping shared by every regfile that imports the domain. */
class ShadowDomainBuilder implements ShadowDomainDef {
	readonly kind = "wishbone-shadow-domain" as const;

	constructor(
		readonly name: string,
		readonly copies: number,
		readonly tag_width: number,
		readonly desc?: string,
		readonly remapMap?: ShadowRemapMap,
		readonly innerShadowMux = true,
	) {}

	withInnerShadowMux(enabled: boolean): ShadowDomainDef {
		return new ShadowDomainBuilder(
			this.name,
			this.copies,
			this.tag_width,
			this.desc,
			this.remapMap,
			enabled,
		);
	}

	/** Domain-wide mapping. Unlisted TGA values keep `1 << tga`. */
	remap(map: ShadowRemapMap): ShadowDomainDef {
		const checked = requireRemapMap(map, this.copies);
		const space = (1 << this.tag_width) - 1;
		for (const key of Object.keys(checked)) {
			if (Number(key) > space) {
				throw new Error(
					`shadow domain "${this.name}" remap TGA ${key} exceeds width ${this.tag_width}`,
				);
			}
		}
		return new ShadowDomainBuilder(
			this.name,
			this.copies,
			this.tag_width,
			this.desc,
			checked,
		);
	}
}

function parseTagBits(
	name: string,
	bits: string,
): { hi: number; lo: number } {
	const m = /^(\d+)\s*:\s*(\d+)$/.exec(bits.trim());
	if (!m) throw new Error(`shadow "${name}" tag_bits "${bits}" must be hi:lo`);
	const hi = Number(m[1]);
	const lo = Number(m[2]);
	if (hi < lo) throw new Error(`shadow "${name}" tag_bits hi < lo`);
	return { hi, lo };
}

export function isShadowDomain(v: unknown): v is ShadowDomainDef {
	return (
		typeof v === "object" &&
		v !== null &&
		(v as ShadowDomainDef).kind === "wishbone-shadow-domain"
	);
}

/** Domain → local ShadowElem. The domain remap is authoritative. */
export function shadowOf(domain: ShadowDomainDef): ShadowElem {
	const hi = domain.tag_width - 1;
	const shadow = new ShadowElem(domain.name, domain.copies, `${hi}:0`);
	return (domain.remapMap ? shadow.remaps(domain.remapMap) : shadow).innerShadowMux(
		domain.innerShadowMux,
	);
}

// ---------------------------------------------------------------------------
// Regfile — name, desc (required), opts cascade, body
// ---------------------------------------------------------------------------

export function Regfile(
	name: string,
	desc: string,
	opts: RegfileOptsElem,
	define: readonly (RegBlock | RegCell)[],
): RegfileDef {
	const o = opts.toOpts();
	return {
		name,
		desc,
		addr_width: o.addr_width,
		read_write_block: o.read_write_block ?? false,
		...(o.note !== undefined ? { note: o.note } : {}),
		...(o.sheet !== undefined ? { sheet: o.sheet } : {}),
		...(o.bytes_align !== undefined ? { bytes_align: o.bytes_align } : {}),
		shadows: o.shadows ?? [],
		body: define,
	};
}
