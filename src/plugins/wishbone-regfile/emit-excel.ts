// Excel docs export for the wishbone plugin pack.
// Field sheets follow master gen_excel_doc.py, minus unused columns
// (leading empty, Selection ADDRWIDTH). An Address Map sheet per independent
// bus tree shows the same information as the terminal tree: absolute address in
// column A, one 2-row x 3-column block per item indented 3 columns per level,
// leaves stopping at a regfile or an empty port. No reverse import to TS.

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import ExcelJS from "exceljs";
import type { BusDef, WbSlave, WbTagSource } from "../wishbone-bus/dsl.ts";
import { windowBytes } from "../wishbone-bus/dsl.ts";
import { effectiveSheet } from "./dsl.ts";
import { fieldsWithReserved } from "./emit-sw.ts";
import type { LaidCell, LaidRegfile } from "./layout.ts";

const CELL_BITS = 32;

/** Whole workbook is monospace: hex offsets and identifiers line up. */
const MONO_FONT = "Consolas";

const HEADER = [
	"Sub-Addr\n(Hex)",
	"Start\nBit",
	"End\nBit",
	"Bit\nWidth",
	"Default\nValue",
	"R/W\nProperty",
	"Register\nName",
	"Register Description",
	"Reset\nValue (Dec)",
	"Reset\nValue (Hex)",
	"Reset\nValue (Sum)",
	"SHADOW",
] as const;

const COL = {
	subAddr: 1,
	startBit: 2,
	endBit: 3,
	bitWidth: 4,
	defaultVal: 5,
	rw: 6,
	name: 7,
	desc: 8,
	resetDec: 9,
	resetHex: 10,
	resetSum: 11,
	shadow: 12,
} as const;

const HEADER_FILL: ExcelJS.FillPattern = {
	type: "pattern",
	pattern: "solid",
	fgColor: { argb: "FFCCFFCC" },
};
const CELL_FILL: ExcelJS.FillPattern = {
	type: "pattern",
	pattern: "solid",
	fgColor: { argb: "FFFFFF00" },
};
const RESERVED_FILL: ExcelJS.FillPattern = {
	type: "pattern",
	pattern: "solid",
	fgColor: { argb: "FFD0D0D0" },
};
const THIN: Partial<ExcelJS.Borders> = {
	top: { style: "thin", color: { argb: "FF000000" } },
	left: { style: "thin", color: { argb: "FF000000" } },
	bottom: { style: "thin", color: { argb: "FF000000" } },
	right: { style: "thin", color: { argb: "FF000000" } },
};
const HEADER_FONT: Partial<ExcelJS.Font> = {
	name: MONO_FONT,
	bold: true,
};
const HEADER_ALIGN: Partial<ExcelJS.Alignment> = {
	horizontal: "center",
	vertical: "middle",
	wrapText: true,
};
const FIELD_ALIGN: Partial<ExcelJS.Alignment> = {
	horizontal: "left",
	vertical: "top",
	wrapText: true,
};

function colLetter(n: number): string {
	return String.fromCharCode("A".charCodeAt(0) + n - 1);
}

function hexAddr(offset: number, addrWidth: number): string {
	const digits = Math.max(2, Math.ceil(addrWidth / 4));
	return offset.toString(16).padStart(digits, "0");
}

/** Description cell: one-line desc, then note on the following lines. Same cell. */
function descWithNote(desc: string, note: string | undefined): string {
	if (!note) return desc;
	return `${desc}\n${note}`;
}

function styleRange(
	ws: ExcelJS.Worksheet,
	row: number,
	cols: number,
	fill: ExcelJS.FillPattern,
	align?: Partial<ExcelJS.Alignment>,
): void {
	for (let c = 1; c <= cols; c++) {
		const cell = ws.getCell(row, c);
		cell.fill = fill;
		cell.border = THIN as ExcelJS.Borders;
		if (align) cell.alignment = align;
	}
}

function appendCellBlock(
	ws: ExcelJS.Worksheet,
	laid: LaidRegfile,
	cell: LaidCell,
): void {
	const bits = [...fieldsWithReserved(cell)].reverse();
	const cellRow = (ws.lastRow?.number ?? 0) + 1;
	const fieldBegin = cellRow + 1;
	const fieldEnd = fieldBegin + bits.length - 1;
	const e = colLetter(COL.bitWidth);
	const i = colLetter(COL.resetDec);
	const j = colLetter(COL.resetHex);
	const k = colLetter(COL.resetSum);
	const b = colLetter(COL.startBit);
	const c = colLetter(COL.endBit);

	ws.addRow([
		hexAddr(cell.byte_offset, laid.def.addr_width),
		"",
		"",
		{ formula: `SUM(${e}${fieldBegin}:${e}${fieldEnd})` },
		{ formula: `CONCATENATE("32'h",${j}${cellRow})` },
		"",
		cell.name,
		cell.desc,
		"",
		{ formula: `LOWER(DEC2HEX(${k}${cellRow}, 8))` },
		{ formula: `SUM(${k}${fieldBegin}:${k}${fieldEnd})` },
		cell.shadow ?? "",
	]);
	styleRange(ws, cellRow, HEADER.length, CELL_FILL);

	for (const bit of bits) {
		const r = (ws.lastRow?.number ?? 0) + 1;
		const start = bit.bit_offset;
		const end = bit.bit_offset + bit.width - 1;
		ws.addRow([
			"",
			start,
			end,
			{ formula: `${c}${r}-${b}${r}+1` },
			{ formula: `CONCATENATE(${e}${r},"'h",${j}${r})` },
			bit.access,
			bit.name,
			bit.reserved
				? bit.name.toUpperCase()
				: descWithNote(
						bit.desc,
						cell.fields.find((f) => f.field.name === bit.name)?.field.note,
					),
			bit.reset,
			{ formula: `LOWER(DEC2HEX((${i}${r})))` },
			{ formula: `${i}${r}*(2^${b}${r})` },
			"",
		]);
		for (let col = 1; col <= HEADER.length; col++) {
			const cellRef = ws.getCell(r, col);
			cellRef.border = THIN as ExcelJS.Borders;
			cellRef.alignment = FIELD_ALIGN;
			if (bit.reserved) cellRef.fill = RESERVED_FILL;
		}
	}
}

/** Excel field-sheet tab: "regfile_" + sheet, clamped to Excel's 31-char limit. */
function regfileSheetName(def: LaidRegfile["def"]): string {
	return `regfile_${effectiveSheet(def)}`.slice(0, 31);
}

function addSheet(wb: ExcelJS.Workbook, laid: LaidRegfile): void {
	const name = regfileSheetName(laid.def);
	const ws = wb.addWorksheet(name);
	ws.addRow([...HEADER]);
	// Header cells are 2-line labels; leave the row height unset so Excel
	// auto-fits the wrapped text (a fixed height clips wider-wrapping columns).
	for (let col = 1; col <= HEADER.length; col++) {
		const cell = ws.getCell(1, col);
		cell.font = HEADER_FONT;
		cell.fill = HEADER_FILL;
		cell.border = THIN as ExcelJS.Borders;
		cell.alignment = HEADER_ALIGN;
	}
	if (laid.def.note) {
		ws.getRow(1).getCell(COL.desc).note = descWithNote(
			laid.def.desc,
			laid.def.note,
		);
	}
	const dataWidth = (4.0 * CELL_BITS) / 8;
	ws.getColumn(COL.defaultVal).width = dataWidth;
	ws.getColumn(COL.name).width = 30;
	ws.getColumn(COL.desc).width = 40;
	ws.getColumn(COL.resetDec).width = dataWidth;
	ws.getColumn(COL.resetHex).width = dataWidth;
	ws.getColumn(COL.resetSum).width = dataWidth;
	ws.getColumn(COL.shadow).width = dataWidth;
	for (const cell of laid.cells) appendCellBlock(ws, laid, cell);
}

// Address Map sheet: one 2-row x 3-column block per item, indented 3 columns
// per level. Column A is the absolute address, merged over the two rows.
const MAP_HEADER_1 = ["Abs Addr", "Offset", "Size", "Tag / Broadcast"] as const;
const MAP_HEADER_2 = ["Name", "Type", "Description"] as const;
const MAP_COLS = 3;

/** Low-contrast pastel fills: address column plus one per item type. */
const MAP_FILL = {
	addr: "FFDCE9F5",
	bus: "FFE4EEDC",
	regfile: "FFFDF3D8",
	broadcast: "FFEDE2F3",
	port: "FFECECEC",
	repeat: "FFF2E0DC",
	header: "FFE8E8E8",
} as const;

const MAP_BORDER: Partial<ExcelJS.Borders> = {
	top: { style: "hair", color: { argb: "FFBFBFBF" } },
	left: { style: "hair", color: { argb: "FFBFBFBF" } },
	bottom: { style: "hair", color: { argb: "FFBFBFBF" } },
	right: { style: "hair", color: { argb: "FFBFBFBF" } },
};

/** Outline around one 2-row x 3-column block; inner edges stay hair. */
const MAP_EDGE: ExcelJS.Border = {
	style: "thin",
	color: { argb: "FF9AA0A6" },
};

function blockBorder(
	top: boolean,
	bottom: boolean,
	left: boolean,
	right: boolean,
): Partial<ExcelJS.Borders> {
	return {
		top: top ? MAP_EDGE : MAP_BORDER.top,
		bottom: bottom ? MAP_EDGE : MAP_BORDER.bottom,
		left: left ? MAP_EDGE : MAP_BORDER.left,
		right: right ? MAP_EDGE : MAP_BORDER.right,
	};
}

function mapFill(argb: string): ExcelJS.FillPattern {
	return { type: "pattern", pattern: "solid", fgColor: { argb } };
}

export function busMapSheetName(def: BusDef): string {
	if (def.name.length === 0) {
		throw new Error("wishbone: Excel bus sheet name is empty");
	}
	return `bus_map_${def.name}`.slice(0, 31);
}

function hexWin(n: number, addrWidth = 32): string {
	const digits = Math.max(2, Math.ceil(addrWidth / 4));
	return `0x${(n >>> 0).toString(16).padStart(digits, "0")}`;
}

function tagText(tag: WbTagSource): string {
	const at = tag.domain.name;
	if (tag.source === "addr") return `${at}=ADR[${tag.addr_bits}]`;
	if (tag.source === "pin") return `${at}=pin`;
	if (tag.source === "reg") return `${at}=${tag.reg_field ?? "reg"}`;
	return `${at}=uplink`;
}

/** Row-1 third cell: tag domains of a child fabric, broadcast and shadow marks. */
function marksText(slave: WbSlave, repeat: boolean): string {
	const parts: string[] = [];
	if (slave.bus && repeat) parts.push(`repeat of ${slave.bus.name}`);
	if (slave.bus && !repeat && slave.bus.tags.length > 0) {
		parts.push(slave.bus.tags.map(tagText).join(", "));
	}
	if (slave.broadcast) parts.push(`broadcast ${slave.broadcast}`);
	if (slave.broadcastBy && slave.broadcastBy.length > 0) {
		parts.push(`broadcast-by: ${slave.broadcastBy.join("|")}`);
	}
	const shadows = slave.regfile?.shadows.map((s) => s.name) ?? [];
	if (shadows.length > 0) parts.push(`shadow: ${shadows.join("|")}`);
	return parts.join("  ");
}

type MapKind = keyof typeof MAP_FILL;

function slaveKind(slave: WbSlave, repeat: boolean): MapKind {
	if (slave.broadcast) return "broadcast";
	if (slave.bus) return repeat ? "repeat" : "bus";
	if (slave.regfile) return "regfile";
	return "port";
}

function slaveType(slave: WbSlave, repeat: boolean): string {
	if (slave.broadcast) return "broadcast";
	if (slave.bus) {
		const shape = slave.bus.masters.length > 1 ? "interconnect" : "bus";
		return repeat ? `${shape} (repeat)` : shape;
	}
	if (slave.regfile) return "regfile";
	return "port";
}

/**
 * One item: absolute address in column A, then 3 columns x 2 rows at `depth`,
 * outlined as a block. `top` reuses an existing row pair (offset 0 keeps the
 * item on its parent's two rows instead of moving down); otherwise a new pair
 * is appended. Returns the top row of the block.
 */
function addMapBlock(
	ws: ExcelJS.Worksheet,
	depth: number,
	abs: string,
	kind: MapKind,
	row1: readonly [string, string, string],
	row2: readonly [string, string, string],
	top?: number,
): number {
	const first = 2 + depth * MAP_COLS;
	if (top === undefined) {
		const at = (ws.lastRow?.number ?? 0) + 1;
		const addr = ws.getCell(at, 1);
		addr.value = abs;
		addr.fill = mapFill(MAP_FILL.addr);
		addr.alignment = { horizontal: "left", vertical: "middle" };
		ws.getCell(at + 1, 1).fill = mapFill(MAP_FILL.addr);
		ws.mergeCells(at, 1, at + 1, 1);
		ws.getCell(at, 1).border = blockBorder(true, false, true, true);
		ws.getCell(at + 1, 1).border = blockBorder(false, true, true, true);
		top = at;
	}
	const fill = mapFill(MAP_FILL[kind]);
	for (const [offset, values] of [row1, row2].entries()) {
		for (const [i, text] of values.entries()) {
			const cell = ws.getCell(top + offset, first + i);
			cell.value = text;
			cell.fill = fill;
			cell.border = blockBorder(
				offset === 0,
				offset === 1,
				i === 0,
				i === values.length - 1,
			);
			cell.alignment = { horizontal: "left", vertical: "top", wrapText: true };
		}
	}
	return top;
}

/** Roots are listed buses that no other listed bus hangs. */
function busRoots(buses: readonly BusDef[]): BusDef[] {
	const hung = new Set<string>();
	const walk = (bus: BusDef): void => {
		for (const slave of bus.slaves) {
			if (!slave.bus) continue;
			hung.add(slave.bus.name);
			walk(slave.bus);
		}
	};
	for (const bus of buses) walk(bus);
	return buses.filter((bus) => !hung.has(bus.name));
}

function busSpan(bus: BusDef): number {
	let end = 0;
	for (const slave of bus.slaves) {
		const span = slave.size ?? windowBytes(slave.mask, bus.addr_width);
		end = Math.max(end, (slave.base + span) >>> 0);
	}
	return end || windowBytes(0, bus.addr_width);
}

/** Deepest level reached; repeated subtrees and broadcast ports stay closed. */
function busDepth(bus: BusDef, seen: Set<string>): number {
	let depth = 0;
	for (const slave of bus.slaves) {
		if (!slave.bus || slave.broadcast || seen.has(slave.bus.name)) {
			depth = Math.max(depth, 1);
			continue;
		}
		seen.add(slave.bus.name);
		depth = Math.max(depth, 1 + busDepth(slave.bus, seen));
	}
	return depth;
}

function addMapHeader(ws: ExcelJS.Worksheet, groups: number): void {
	const cols = 1 + groups * MAP_COLS;
	for (let c = 1; c <= cols; c++) {
		for (const r of [1, 2]) {
			const cell = ws.getCell(r, c);
			cell.font = HEADER_FONT;
			cell.fill = mapFill(MAP_FILL.header);
			cell.border = MAP_BORDER as ExcelJS.Borders;
			cell.alignment = HEADER_ALIGN;
		}
	}
	MAP_HEADER_1.forEach((text, i) => {
		ws.getCell(1, 1 + i).value = text;
	});
	MAP_HEADER_2.forEach((text, i) => {
		ws.getCell(2, 2 + i).value = text;
	});
	ws.mergeCells(1, 1, 2, 1);
	ws.getColumn(1).width = 14;
	for (let g = 0; g < groups; g++) {
		ws.getColumn(2 + g * MAP_COLS).width = 18;
		ws.getColumn(3 + g * MAP_COLS).width = 16;
		ws.getColumn(4 + g * MAP_COLS).width = 34;
	}
}

function addBusMapSheet(wb: ExcelJS.Workbook, def: BusDef): void {
	const ws = wb.addWorksheet(busMapSheetName(def));
	addMapHeader(ws, 1 + busDepth(def, new Set([def.name])));
	const width = def.addr_width;
	const rootTop = addMapBlock(
		ws,
		0,
		hexWin(0, width),
		"bus",
		[
			hexWin(0, width),
			hexWin(busSpan(def), width),
			def.tags.map(tagText).join(", "),
		],
		[def.name, def.masters.length > 1 ? "interconnect" : "bus", def.desc],
	);
	const seen = new Set<string>([def.name]);
	const walk = (
		bus: BusDef,
		absBase: number,
		depth: number,
		parentTop: number,
	): void => {
		for (const slave of [...bus.slaves].sort((a, b) => a.base - b.base)) {
			const abs = (absBase + slave.base) >>> 0;
			const span = slave.size ?? windowBytes(slave.mask, bus.addr_width);
			const open = slave.bus !== undefined && !seen.has(slave.bus.name);
			const repeat = slave.bus !== undefined && !open;
			// Offset 0 starts at the parent address: keep it on the parent's rows.
			const top = addMapBlock(
				ws,
				depth,
				hexWin(abs, width),
				slaveKind(slave, repeat),
				[
					hexWin(slave.base, bus.addr_width),
					hexWin(span, bus.addr_width),
					marksText(slave, repeat),
				],
				[slave.name, slaveType(slave, repeat), slave.desc],
				slave.base === 0 ? parentTop : undefined,
			);
			if (slave.bus && open) {
				seen.add(slave.bus.name);
				walk(slave.bus, abs, depth + 1, top);
			}
		}
	};
	walk(def, 0, 1, rootTop);
}

/** Every sheet is read as hex and identifiers: one monospace face workbook-wide. */
function applyMonoFont(wb: ExcelJS.Workbook): void {
	for (const ws of wb.worksheets) {
		ws.eachRow({ includeEmpty: true }, (row) => {
			row.eachCell({ includeEmpty: true }, (cell) => {
				cell.font = { ...cell.font, name: MONO_FONT };
			});
		});
	}
}

/** Build one workbook: field sheets plus one sheet per independent bus tree. */
export function buildRegfileWorkbook(
	tables: readonly LaidRegfile[],
	buses: readonly BusDef[] = [],
): ExcelJS.Workbook {
	const wb = new ExcelJS.Workbook();
	wb.creator = "autowire";
	wb.lastModifiedBy = "autowire";
	wb.created = new Date(0);
	wb.modified = new Date(0);
	const fieldNames = new Set(tables.map((t) => regfileSheetName(t.def)));
	for (const bus of busRoots(buses)) {
		const mapName = busMapSheetName(bus);
		if (fieldNames.has(mapName)) {
			throw new Error(
				`wishbone: Excel field sheet "${mapName}" collides with bus sheet "${bus.name}"`,
			);
		}
	}
	for (const laid of tables) addSheet(wb, laid);
	for (const bus of busRoots(buses)) addBusMapSheet(wb, bus);
	applyMonoFont(wb);
	return wb;
}

export async function writeRegfileExcel(
	path: string,
	tables: readonly LaidRegfile[],
	buses: readonly BusDef[] = [],
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const wb = buildRegfileWorkbook(tables, buses);
	const buf = await wb.xlsx.writeBuffer();
	await Bun.write(path, buf);
}
