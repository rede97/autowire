// Colored address tree for a generated BusDef. Same information as master
// autowire/cfgbus/dump_decoder.py: absolute address, leaf name, broadcast,
// and shadow domains. Printed after the bus RTL is written.

import chalk from "chalk";
import {
	type BusDef,
	type WbSlave,
	type WbTagSource,
	windowBytes,
} from "./dsl.ts";

type Dye = (text: string) => string;

const paint: Record<string, Dye> = {
	blue: chalk.blue,
	bold: chalk.bold,
	cyan: chalk.cyan,
	green: chalk.green,
	grey: chalk.gray,
	magenta: chalk.magenta,
	red: chalk.red,
	yellow: chalk.yellow,
};

function color(name: keyof typeof paint, text: string): string {
	return paint[name](text);
}

function addrText(width: number, value: number): string {
	const digits = Math.max(1, Math.ceil(width / 4));
	return `0x${(value >>> 0).toString(16).padStart(digits, "0")}`;
}

function sizeText(bytes: number): string {
	return color("bold", `0x${bytes.toString(16)}`);
}

function fabricSpan(bus: BusDef): number {
	let end = 0;
	for (const slave of bus.slaves) {
		const span = slave.size ?? windowBytes(slave.mask, bus.addr_width);
		end = Math.max(end, (slave.base + span) >>> 0);
	}
	return end || windowBytes(0, bus.addr_width);
}

function tagLabel(tag: WbTagSource): string {
	const name = color("green", tag.domain.name);
	if (tag.source === "addr")
		return `${color("red", `addr[${tag.addr_bits}]`)}@${name}`;
	if (tag.source === "pin") return `${color("red", "pin")}@${name}`;
	if (tag.source === "reg")
		return `${color("red", tag.reg_field ?? "reg")}@${name}`;
	return `${color("grey", "*")}@${name}`;
}

function slaveMarks(slave: WbSlave): string {
	const marks: string[] = [];
	if (slave.regfile) marks.push(`*${color("blue", slave.regfile.name)}`);
	if (slave.broadcast)
		marks.push(color("magenta", `broadcast ${slave.broadcast}`));
	if (slave.broadcastBy && slave.broadcastBy.length > 0) {
		marks.push(
			`${color("grey", "broadcast-by:")} ${color("magenta", slave.broadcastBy.join("|"))}`,
		);
	}
	const shadows = slave.regfile?.shadows.map((s) => s.name) ?? [];
	if (shadows.length > 0) {
		marks.push(
			`${color("grey", "shadow:")} ${color("green", shadows.join("|"))}`,
		);
	}
	return marks.length > 0 ? ` ${marks.join(" ")}` : "";
}

type Row = { text: string; children: Row[] };

function slaveRow(
	bus: BusDef,
	slave: WbSlave,
	abs: number,
	seen: Set<string>,
): Row {
	const span = slave.size ?? windowBytes(slave.mask, bus.addr_width);
	const at = `${color("cyan", addrText(bus.addr_width, abs))}@${color("yellow", slave.name)}`;
	if (slave.bus) {
		const nested = !seen.has(slave.bus.name);
		if (nested) seen.add(slave.bus.name);
		return {
			text: `${at} ${color("grey", slave.bus.name)} ${color("grey", "size:")} ${sizeText(span)}${slaveMarks(slave)}`,
			children: nested ? busRows(slave.bus, abs, seen) : [],
		};
	}
	const kind = slave.broadcast ? "broadcast-size" : "size";
	return {
		text: `${at}${slaveMarks(slave)} ${color("grey", `${kind}:`)} ${sizeText(span)}`,
		children: [],
	};
}

function busRows(bus: BusDef, offset: number, seen: Set<string>): Row[] {
	const rows = [...bus.slaves]
		.sort((a, b) => a.base - b.base)
		.map((slave) => slaveRow(bus, slave, (offset + slave.base) >>> 0, seen));
	if (bus.tags.length > 0) {
		rows.push({
			text: `${color("grey", "tags:")} ${bus.tags.map(tagLabel).join(", ")}`,
			children: [],
		});
	}
	return rows;
}

function render(rows: readonly Row[], prefix: string, out: string[]): void {
	rows.forEach((row, index) => {
		const last = index === rows.length - 1;
		out.push(`${prefix}${last ? "`-- " : "|-- "}${row.text}`);
		render(row.children, `${prefix}${last ? "    " : "|   "}`, out);
	});
}

/** Print one fabric the way the master cfg decoder tree did. */
export function printBusTree(bus: BusDef): void {
	const head = `${color("blue", addrText(bus.addr_width, 0))}@${color("bold", bus.name)} ${color("grey", "size:")} ${sizeText(fabricSpan(bus))}`;
	const lines = [head];
	render(busRows(bus, 0, new Set([bus.name])), "", lines);
	console.log(lines.join("\n"));
}
