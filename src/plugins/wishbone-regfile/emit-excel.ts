// Excel docs export for the wishbone plugin pack.
// Field sheets follow master gen_excel_doc.py, minus unused columns
// (leading empty, Selection ADDRWIDTH). MAP_<bus> sheets add Slave window +
// cell absolute addresses. No reverse import to TS.

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import ExcelJS from "exceljs";
import type { BusDef } from "../wishbone-bus/dsl.ts";
import { mapHangsDeep } from "../wishbone-bus/emit-map.ts";
import { effectiveSheet } from "./dsl.ts";
import { fieldsWithReserved } from "./emit-sw.ts";
import type { LaidCell, LaidRegfile } from "./layout.ts";
import { layoutRegfile } from "./layout.ts";

const CELL_BITS = 32;

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
	name: "Calibri",
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

function addSheet(wb: ExcelJS.Workbook, laid: LaidRegfile): void {
	const name = effectiveSheet(laid.def);
	const ws = wb.addWorksheet(name);
	ws.addRow([...HEADER]);
	ws.getRow(1).height = 30;
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
	ws.getColumn(COL.resetHex).width = dataWidth;
	ws.getColumn(COL.resetSum).width = dataWidth;
	ws.getColumn(COL.shadow).width = dataWidth;
	for (const cell of laid.cells) appendCellBlock(ws, laid, cell);
}

const MAP_HEADER = [
	"Slave",
	"Base",
	"Mask",
	"Pipe",
	"Tag",
	"Cell",
	"Sheet",
	"Offset",
	"Absolute",
	"Shadow",
	"Description",
] as const;

export function busMapSheetName(def: BusDef): string {
	const name = `MAP_${def.name}`;
	if (name.length > 31) {
		throw new Error(
			`wishbone: Excel MAP sheet name "${name}" exceeds 31 characters`,
		);
	}
	return name;
}

function hexWin(n: number): string {
	return `0x${n.toString(16).padStart(8, "0")}`;
}

function addBusMapSheet(wb: ExcelJS.Workbook, def: BusDef): void {
	const hangs = mapHangsDeep(def);
	if (hangs.length === 0) return;
	const name = busMapSheetName(def);
	const ws = wb.addWorksheet(name);
	ws.addRow([...MAP_HEADER]);
	ws.getRow(1).height = 20;
	for (let col = 1; col <= MAP_HEADER.length; col++) {
		const cell = ws.getCell(1, col);
		cell.font = HEADER_FONT;
		cell.fill = HEADER_FILL;
		cell.border = THIN as ExcelJS.Borders;
		cell.alignment = HEADER_ALIGN;
	}
	ws.getColumn(1).width = 16;
	ws.getColumn(6).width = 20;
	ws.getColumn(7).width = 16;
	ws.getColumn(11).width = 40;
	for (const slave of hangs) {
		const rf = slave.regfile;
		if (!rf) continue;
		const laid = layoutRegfile(rf);
		const sheet = effectiveSheet(rf);
		for (const cell of laid.cells) {
			const r = (ws.lastRow?.number ?? 0) + 1;
			ws.addRow([
				slave.name,
				hexWin(slave.base),
				hexWin(slave.mask),
				slave.pipe,
				slave.tag ?? 0,
				cell.name,
				sheet,
				hexWin(cell.byte_offset),
				hexWin(slave.base + cell.byte_offset),
				cell.shadow ?? "",
				cell.desc,
			]);
			styleRange(ws, r, MAP_HEADER.length, CELL_FILL, FIELD_ALIGN);
		}
	}
}

/** Build one workbook: field sheets plus optional MAP_<bus> sheets. */
export function buildRegfileWorkbook(
	tables: readonly LaidRegfile[],
	buses: readonly BusDef[] = [],
): ExcelJS.Workbook {
	const wb = new ExcelJS.Workbook();
	wb.creator = "autowire";
	wb.lastModifiedBy = "autowire";
	wb.created = new Date(0);
	wb.modified = new Date(0);
	const fieldNames = new Set(tables.map((t) => effectiveSheet(t.def)));
	for (const bus of buses) {
		if (mapHangsDeep(bus).length === 0) continue;
		const mapName = busMapSheetName(bus);
		if (fieldNames.has(mapName)) {
			throw new Error(
				`wishbone: Excel field sheet "${mapName}" collides with a bus MAP sheet`,
			);
		}
	}
	for (const laid of tables) addSheet(wb, laid);
	for (const bus of buses) addBusMapSheet(wb, bus);
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
