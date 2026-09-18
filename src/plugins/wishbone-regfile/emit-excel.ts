// Excel docs export from a laid-out wishbone-regfile.
// Column layout follows master gen_excel_doc.py, minus unused columns
// (leading empty, Selection ADDRWIDTH). Leaf cell offset is documented;
// fabric window / TGA stay with wishbone-bus. No reverse import to TS.

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import ExcelJS from "exceljs";
import { effectiveSheet } from "./dsl.ts";
import { fieldsWithReserved } from "./emit-sw.ts";
import type { LaidCell, LaidRegfile } from "./layout.ts";

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
			bit.reserved ? bit.name.toUpperCase() : bit.desc,
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
	const dataWidth = (4.0 * CELL_BITS) / 8;
	ws.getColumn(COL.defaultVal).width = dataWidth;
	ws.getColumn(COL.name).width = 30;
	ws.getColumn(COL.desc).width = 40;
	ws.getColumn(COL.resetHex).width = dataWidth;
	ws.getColumn(COL.resetSum).width = dataWidth;
	ws.getColumn(COL.shadow).width = dataWidth;
	for (const cell of laid.cells) appendCellBlock(ws, laid, cell);
}

/** Build one workbook: one worksheet per unique sheet identity. */
export function buildRegfileWorkbook(
	tables: readonly LaidRegfile[],
): ExcelJS.Workbook {
	const wb = new ExcelJS.Workbook();
	wb.creator = "autowire";
	wb.lastModifiedBy = "autowire";
	wb.created = new Date(0);
	wb.modified = new Date(0);
	for (const laid of tables) addSheet(wb, laid);
	return wb;
}

export async function writeRegfileExcel(
	path: string,
	tables: readonly LaidRegfile[],
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const wb = buildRegfileWorkbook(tables);
	const buf = await wb.xlsx.writeBuffer();
	await Bun.write(path, buf);
}
