// Byte-address layout for wishbone-regfile (ADR=byte; cell=4 bytes).

import {
	BitsAlign as BA,
	type BitsAlign,
	type RegBlock,
	type RegCell,
	type RegField,
	type RegfileDef,
	type RegShadow,
} from "./dsl.ts";

const CELL_BYTES = 4;
const CELL_BITS = 32;

export interface LaidField {
	readonly field: RegField;
	readonly bit_offset: number;
	readonly logical_name: string;
	readonly slice_index: number | null;
	readonly slice_bit_base: number;
	readonly logical_width: number;
}

export interface LaidCell {
	readonly name: string;
	readonly desc: string;
	readonly byte_offset: number;
	readonly shadow?: string;
	readonly fields: readonly LaidField[];
}

export interface LaidRegfile {
	readonly def: RegfileDef;
	readonly cells: readonly LaidCell[];
	readonly shadows: readonly RegShadow[];
	readonly tga_width: number;
}

/** Exclusive end of the laid-out byte map (max cell offset + 4). */
export function layoutByteSpan(laid: LaidRegfile): number {
	if (laid.cells.length === 0) return CELL_BYTES;
	return Math.max(...laid.cells.map((c) => c.byte_offset + CELL_BYTES));
}

function alignUp(v: number, a: number): number {
	return Math.ceil(v / a) * a;
}

function bitsAlign(cell: RegCell): BitsAlign {
	return cell.bits_align ?? BA.Align8;
}

function packFields(
	cellName: string,
	fields: readonly RegField[],
	align: BitsAlign,
	logicalName: string,
	sliceIndex: number | null,
	sliceBitBase: number,
	logicalWidth: number,
): LaidField[] {
	let cursor = 0;
	const out: LaidField[] = [];
	const used = new Set<number>();
	for (const f of fields) {
		let bit: number;
		if (f.offset !== undefined) {
			bit = f.offset;
		} else {
			cursor = alignUp(cursor, align);
			bit = cursor;
		}
		if (bit < 0 || bit + f.width > CELL_BITS) {
			throw new Error(
				`cell "${cellName}" field "${f.name}" bits [${bit}+:${f.width}] exceed [0,31]`,
			);
		}
		for (let i = bit; i < bit + f.width; i++) {
			if (used.has(i)) {
				throw new Error(
					`cell "${cellName}" field "${f.name}" overlaps bit ${i}`,
				);
			}
			used.add(i);
		}
		out.push({
			field: f,
			bit_offset: bit,
			logical_name: logicalName,
			slice_index: sliceIndex,
			slice_bit_base: sliceBitBase,
			logical_width: logicalWidth,
		});
		cursor = Math.max(cursor, bit + f.width);
	}
	return out;
}

function logicalSliceLabel(
	name: string,
	fullWidth: number,
	lo: number,
	width: number,
): string {
	const hi = lo + width - 1;
	const top = fullWidth - 1;
	const piece = width === 1 ? `${name}[${lo}]` : `${name}[${hi}:${lo}]`;
	return `${piece} of [${top}:0]`;
}

function splitWideField(
	f: RegField,
): { name: string; fields: RegField[]; sliceBitBase: number }[] {
	const slices: { name: string; fields: RegField[]; sliceBitBase: number }[] =
		[];
	let remaining = f.width;
	let base = 0;
	let i = 0;
	const split = f.width > CELL_BITS;
	while (remaining > 0) {
		const w = Math.min(CELL_BITS, remaining);
		const name = split ? `${f.name}_${i}` : f.name;
		const loc = split
			? ` (${logicalSliceLabel(f.name, f.width, base, w)})`
			: "";
		slices.push({
			name,
			sliceBitBase: base,
			fields: [
				{
					name,
					access: f.access,
					width: w,
					desc: `${f.desc}${loc}`,
					reset: f.reset,
				},
			],
		});
		remaining -= w;
		base += w;
		i++;
	}
	return slices;
}

function layoutBlock(
	block: RegBlock,
	regAlign: number,
	cursorIn: number,
): { cells: LaidCell[]; cursor: number } {
	const align = block.bytes_align ?? regAlign;
	let cursor = cursorIn;
	if (block.offset !== undefined) {
		if (block.offset % align !== 0) {
			throw new Error(
				`block "${block.name}" offset ${block.offset} not aligned to ${align}`,
			);
		}
		cursor = block.offset;
	}
	const cells: LaidCell[] = [];
	const occupied = new Set<number>();

	const placeCell = (cell: RegCell, fields: LaidField[]) => {
		let at: number;
		if (cell.offset !== undefined) {
			if (cell.offset % align !== 0) {
				throw new Error(
					`cell "${cell.name}" offset ${cell.offset} not aligned to ${align}`,
				);
			}
			at = cell.offset;
		} else {
			cursor = alignUp(cursor, align);
			at = cursor;
		}
		for (let b = 0; b < CELL_BYTES; b++) {
			const addr = at + b;
			if (occupied.has(addr)) {
				throw new Error(
					`cell "${cell.name}" overlaps byte address 0x${addr.toString(16)}`,
				);
			}
			occupied.add(addr);
		}
		cells.push({
			name: cell.name,
			desc: cell.desc,
			byte_offset: at,
			...(cell.shadow !== undefined ? { shadow: cell.shadow } : {}),
			fields,
		});
		cursor = Math.max(cursor, at + CELL_BYTES);
	};

	for (const child of block.children) {
		if ("fields" in child) {
			const cell = child as RegCell;
			placeCell(
				cell,
				packFields(
					cell.name,
					cell.fields,
					bitsAlign(cell),
					cell.name,
					null,
					0,
					0,
				),
			);
			continue;
		}
		const f = child as RegField;
		const slices = splitWideField(f);
		for (const [si, sl] of slices.entries()) {
			const autoCell: RegCell = {
				name: slices.length > 1 ? `${block.name}_${sl.name}` : sl.name,
				desc: sl.fields[0]?.desc ?? f.desc,
				...(block.shadow !== undefined ? { shadow: block.shadow } : {}),
				fields: sl.fields,
			};
			placeCell(
				autoCell,
				packFields(
					autoCell.name,
					sl.fields,
					BA.Align8,
					f.name,
					slices.length > 1 ? si : null,
					sl.sliceBitBase,
					f.width,
				),
			);
		}
	}
	return { cells, cursor };
}

function tgaWidth(shadows: readonly RegShadow[]): number {
	let max = 0;
	for (const s of shadows) {
		const m = /^(\d+)\s*:\s*(\d+)$/.exec(s.tag_bits.trim());
		if (!m) {
			throw new Error(
				`shadow "${s.name}" tag_bits "${s.tag_bits}" must be hi:lo`,
			);
		}
		const hi = Number(m[1]);
		const lo = Number(m[2]);
		if (hi < lo) {
			throw new Error(`shadow "${s.name}" tag_bits hi < lo`);
		}
		const width = hi - lo + 1;
		const need = s.copies <= 1 ? 0 : Math.ceil(Math.log2(s.copies));
		if (need > 0 && width !== need) {
			throw new Error(
				`shadow "${s.name}" tag_bits width ${width} != ceil(log2(${s.copies}))=${need}`,
			);
		}
		max = Math.max(max, hi + 1);
	}
	return max;
}

function assertShadowRefs(def: RegfileDef, cells: readonly LaidCell[]): void {
	const names = new Set(def.shadows.map((s) => s.name));
	for (const c of cells) {
		if (c.shadow !== undefined && !names.has(c.shadow)) {
			throw new Error(
				`cell "${c.name}" shadow "${c.shadow}" not in table shadows library`,
			);
		}
	}
}

/** Flatten body to laid cells (byte addresses). */
export function layoutRegfile(def: RegfileDef): LaidRegfile {
	const regAlign = def.bytes_align ?? 4;
	let cursor = 0;
	const cells: LaidCell[] = [];
	const occupied = new Set<number>();

	const merge = (laid: LaidCell[]) => {
		for (const c of laid) {
			for (let b = 0; b < CELL_BYTES; b++) {
				const addr = c.byte_offset + b;
				if (occupied.has(addr)) {
					throw new Error(
						`layout overlap at byte 0x${addr.toString(16)} (cell "${c.name}")`,
					);
				}
				occupied.add(addr);
			}
			cells.push(c);
			cursor = Math.max(cursor, c.byte_offset + CELL_BYTES);
		}
	};

	for (const item of def.body) {
		if ("children" in item) {
			const { cells: bc, cursor: c2 } = layoutBlock(item, regAlign, cursor);
			merge(bc);
			cursor = c2;
		} else {
			const cell = item as RegCell;
			const align = regAlign;
			let at: number;
			if (cell.offset !== undefined) {
				at = cell.offset;
			} else {
				cursor = alignUp(cursor, align);
				at = cursor;
			}
			const fields = packFields(
				cell.name,
				cell.fields,
				bitsAlign(cell),
				cell.name,
				null,
				0,
				0,
			);
			merge([
				{
					name: cell.name,
					desc: cell.desc,
					byte_offset: at,
					...(cell.shadow !== undefined ? { shadow: cell.shadow } : {}),
					fields,
				},
			]);
			cursor = Math.max(cursor, at + CELL_BYTES);
		}
	}

	assertShadowRefs(def, cells);
	return {
		def,
		cells,
		shadows: def.shadows,
		tga_width: tgaWidth(def.shadows),
	};
}
