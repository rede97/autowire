// Type-A wrapper: fabric + attached wishbone-regfile leaves.
// Connect HTML instantiates this module instead of the attached *_regfile insts.

import { collectPorts, type PortDecl } from "../wishbone-regfile/emit.ts";
import { layoutRegfile } from "../wishbone-regfile/layout.ts";
import type { BusDef, WbSlave } from "./dsl.ts";
import {
	busModuleName,
	busSystemModuleName,
	type FabricPort,
	listFabricPorts,
} from "./emit.ts";
import { attachedSlaves } from "./emit-map.ts";

function hex(n: number): string {
	return n.toString(16).padStart(8, "0");
}

function isLeafClk(name: string): boolean {
	return name === "i_clk" || name === "i_rst_n";
}

function isLeafWb(name: string, table: string): boolean {
	return name.startsWith(`${table}_i_wb_`) || name.startsWith(`${table}_o_wb_`);
}

function isSlaveWbPort(name: string, slave: string): boolean {
	return name.startsWith(`${slave}_i_wb_`) || name.startsWith(`${slave}_o_wb_`);
}

function promoteName(slaveId: string, table: string, port: string): string {
	return slaveId === table ? port : `${slaveId}_${port}`;
}

function leafWbFromFabric(
	table: string,
	slaveId: string,
	fabricName: string,
): string {
	const suffix = fabricName.slice(slaveId.length + 1);
	return `${table}_${suffix}`;
}

function packedPad(p: string): string {
	return (p.length > 0 ? p : "").padEnd(7);
}

function svPort(
	dir: "input" | "output",
	packed: string,
	name: string,
	unpacked?: string,
): string {
	const unp = unpacked ? ` ${unpacked}` : "";
	return `\t${dir.padEnd(6)} logic ${packedPad(packed)}${name}${unp}`;
}

function svNet(packed: string, name: string, unpacked?: string): string {
	const unp = unpacked ? ` ${unpacked}` : "";
	return `\tlogic ${packedPad(packed)}${name}${unp};`;
}

function formatPortList(
	ports: Array<{
		dir: "input" | "output";
		packed: string;
		name: string;
		unpacked?: string;
		comment?: string;
	}>,
): string[] {
	const lines: string[] = [];
	for (const [i, p] of ports.entries()) {
		if (p.comment) {
			for (const c of p.comment.split("\n")) {
				lines.push(`\t// ${c}`);
			}
		}
		const body = svPort(p.dir, p.packed, p.name, p.unpacked);
		lines.push(i === ports.length - 1 ? body : `${body},`);
	}
	return lines;
}

function sidebandPorts(slave: WbSlave): PortDecl[] {
	const rf = slave.regfile;
	if (!rf) return [];
	const laid = layoutRegfile(rf);
	const table = rf.name;
	return collectPorts(laid).filter(
		(p) => !isLeafClk(p.name) && !isLeafWb(p.name, table),
	);
}

function wrapperPorts(def: BusDef): Array<{
	dir: "input" | "output";
	packed: string;
	name: string;
	unpacked?: string;
	comment?: string;
}> {
	const attached = attachedSlaves(def);
	const attachedIds = new Set(attached.map((s) => s.name));
	const ports: Array<{
		dir: "input" | "output";
		packed: string;
		name: string;
		unpacked?: string;
		comment?: string;
	}> = [];
	for (const p of listFabricPorts(def)) {
		const hide = [...attachedIds].some((id) => isSlaveWbPort(p.name, id));
		if (hide) continue;
		ports.push(p);
	}
	for (const s of attached) {
		const rf = s.regfile;
		if (!rf) continue;
		let banner = false;
		for (const p of sidebandPorts(s)) {
			const name = promoteName(s.name, rf.name, p.name);
			const comment = !banner
				? `Regfile ${rf.name} hang ${s.name} sidebands\n${p.comment ?? p.name}`
				: p.comment;
			banner = true;
			ports.push({
				dir: p.dir,
				packed: p.packed,
				name,
				unpacked: p.unpacked,
				comment,
			});
		}
	}
	return ports;
}

function instConns(
	pairs: Array<{ port: string; net: string }>,
	align: number,
): string[] {
	const lines: string[] = [];
	for (const [i, x] of pairs.entries()) {
		const pad = x.port.padEnd(align);
		const comma = i === pairs.length - 1 ? "" : ",";
		lines.push(`\t\t.${pad}(${x.net})${comma}`);
	}
	return lines;
}

function maxPort(names: string[]): number {
	return Math.max(8, ...names.map((n) => n.length));
}

function fabricInst(def: BusDef): string[] {
	const fabric = listFabricPorts(def);
	const ic = busModuleName(def);
	const align = maxPort(fabric.map((p) => p.name));
	const pairs = fabric.map((p) => ({ port: p.name, net: p.name }));
	return [`\t${ic} u_ic (`, ...instConns(pairs, align), "\t);"];
}

function leafInst(def: BusDef, slave: WbSlave): string[] {
	const rf = slave.regfile;
	if (!rf) return [];
	const laid = layoutRegfile(rf);
	const table = rf.name;
	const mod = `${table.toLowerCase()}_regfile`;
	const ports = collectPorts(laid);
	const wbPorts = listFabricPorts(def).filter((p) =>
		isSlaveWbPort(p.name, slave.name),
	);
	const pairs: Array<{ port: string; net: string }> = [];
	for (const p of ports) {
		if (p.name === "i_clk") {
			pairs.push({ port: p.name, net: "clk" });
			continue;
		}
		if (p.name === "i_rst_n") {
			pairs.push({ port: p.name, net: "rst_n" });
			continue;
		}
		if (isLeafWb(p.name, table)) {
			const fabric = wbPorts.find(
				(f) => leafWbFromFabric(table, slave.name, f.name) === p.name,
			);
			if (!fabric) {
				throw new Error(
					`wishbone-bus: wrapper ${slave.name} missing fabric port for ${p.name}`,
				);
			}
			pairs.push({ port: p.name, net: fabric.name });
			continue;
		}
		pairs.push({
			port: p.name,
			net: promoteName(slave.name, table, p.name),
		});
	}
	const align = maxPort(pairs.map((p) => p.port));
	return [`\t${mod} u_${slave.name} (`, ...instConns(pairs, align), "\t);"];
}

function internalWbNets(def: BusDef): string[] {
	const lines: string[] = [];
	for (const s of attachedSlaves(def)) {
		const wb: FabricPort[] = listFabricPorts(def).filter((p) =>
			isSlaveWbPort(p.name, s.name),
		);
		if (wb.length === 0) continue;
		lines.push(
			`\t// Internal WB: fabric slave ${s.name} ↔ ${s.regfile?.name}_regfile`,
		);
		for (const p of wb) {
			lines.push(svNet(p.packed, p.name));
		}
		lines.push("");
	}
	return lines;
}

export function emitBusSystemSv(def: BusDef): string | null {
	const attached = attachedSlaves(def);
	if (attached.length === 0) return null;
	const mod = busSystemModuleName(def);
	const ic = busModuleName(def);
	const lines: string[] = [
		`// Generated by autowire plugin wishbone (system ${def.name}). Do not edit.`,
		"// Type-A wrapper: fabric + attached wishbone-regfile leaves (analysis → RtlIndex).",
		"//",
		"//------------------------------------------------------------------------------",
		`//  Module: ${mod}`,
		`//  Desc:   ${def.desc}`,
		`//  Fabric: ${ic}`,
		"//  Attached regfile hangs:",
	];
	for (const s of attached) {
		const rf = s.regfile;
		if (!rf) continue;
		lines.push(
			`//    ${s.name}  ${rf.name}_regfile  base=0x${hex(s.base)}  mask=0x${hex(s.mask)}`,
		);
	}
	lines.push(
		"//------------------------------------------------------------------------------",
		"",
	);
	lines.push(`module ${mod} (`);
	lines.push(...formatPortList(wrapperPorts(def)));
	lines.push(");", "");
	lines.push(...internalWbNets(def));
	lines.push(...fabricInst(def), "");
	for (const s of attached) {
		lines.push(...leafInst(def, s), "");
	}
	lines.push("endmodule", "");
	return lines.join("\n");
}
