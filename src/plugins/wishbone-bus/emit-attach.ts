// Type-A wrapper: fabric + attached wishbone-regfile leaves.
// Connect HTML instantiates this module instead of the attached *_regfile insts.

import { collectPorts, type PortDecl } from "../wishbone-regfile/emit.ts";
import { layoutRegfile } from "../wishbone-regfile/layout.ts";
import {
	type BusDef,
	domainWidth,
	UPLINK_MASTER,
	type WbSlave,
} from "./dsl.ts";
import {
	busModuleKind,
	busModuleName,
	busSystemModuleName,
	type FabricPort,
	listFabricPorts,
} from "./emit.ts";
import { attachedSlaves } from "./emit-map.ts";
import {
	bridgedFabricNet,
	bridgedMasters,
	emitMasterBlocks,
	isBridgedFabricPort,
	masterFacePorts,
	masterSummary,
} from "./emit-master.ts";
import { tagPlan, tagPort } from "./tag.ts";

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

function hasCascadeFace(def: BusDef): boolean {
	return def.masters.some((m) => m.name === UPLINK_MASTER);
}

function packedRange(width: number): string {
	return width > 1 ? `[${width - 1}:0]` : "";
}

function isUplinkMasterPort(name: string): boolean {
	return (
		name.startsWith(`${UPLINK_MASTER}_o_wb_`) ||
		name.startsWith(`${UPLINK_MASTER}_i_wb_`)
	);
}

function isDecoderMasterPort(name: string): boolean {
	return name.startsWith("m_") && (name.endsWith("_i") || name.endsWith("_o"));
}

/** Fabric port → wrapper net when the cascade face is remapped to i_wb_* / o_wb_*. */
function cascadeNet(fabricName: string, def: BusDef): string {
	if (!hasCascadeFace(def)) return fabricName;
	if (busModuleKind(def) === "decoder") {
		const inn = /^m_(\w+)_i$/.exec(fabricName);
		if (inn?.[1]) return `i_wb_${inn[1]}`;
		const out = /^m_(\w+)_o$/.exec(fabricName);
		if (out?.[1]) return `o_wb_${out[1]}`;
		return fabricName;
	}
	const oPre = `${UPLINK_MASTER}_o_wb_`;
	const iPre = `${UPLINK_MASTER}_i_wb_`;
	if (fabricName.startsWith(oPre))
		return `i_wb_${fabricName.slice(oPre.length)}`;
	if (fabricName.startsWith(iPre))
		return `o_wb_${fabricName.slice(iPre.length)}`;
	return fabricName;
}

function hidesCascadeFabricPort(p: FabricPort, def: BusDef): boolean {
	if (!hasCascadeFace(def)) return false;
	if (busModuleKind(def) === "decoder") return isDecoderMasterPort(p.name);
	return isUplinkMasterPort(p.name);
}

function cascadeWrapperPorts(def: BusDef): Array<{
	dir: "input" | "output";
	packed: string;
	name: string;
	comment?: string;
}> {
	const aw = def.addr_width;
	const inherited = tagPlan(def).inherited;
	const ports: Array<{
		dir: "input" | "output";
		packed: string;
		name: string;
		comment?: string;
	}> = [
		{
			dir: "input",
			packed: packedRange(aw),
			name: "i_wb_adr",
			comment: "Cascade uplink (slave face toward parent decoder)",
		},
		{ dir: "input", packed: "[31:0]", name: "i_wb_dat" },
		{ dir: "input", packed: "[3:0]", name: "i_wb_sel" },
		...inherited.map((t) => ({
			dir: "input" as const,
			packed: packedRange(domainWidth(t.domain)),
			name: tagPort("i_wb", t.domain.name),
		})),
	];
	ports.push(
		{ dir: "input", packed: "", name: "i_wb_cyc" },
		{ dir: "input", packed: "", name: "i_wb_stb" },
		{ dir: "input", packed: "", name: "i_wb_we" },
		{ dir: "output", packed: "[31:0]", name: "o_wb_dat" },
		{ dir: "output", packed: "", name: "o_wb_ack" },
	);
	return ports;
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
		const hide =
			[...attachedIds].some((id) => isSlaveWbPort(p.name, id)) ||
			hidesCascadeFabricPort(p, def) ||
			isBridgedFabricPort(def, p.name);
		if (hide) continue;
		ports.push(p);
	}
	if (hasCascadeFace(def)) {
		ports.push(...cascadeWrapperPorts(def));
	}
	ports.push(...masterFacePorts(def));
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
	const pairs = fabric.map((p) => ({
		port: p.name,
		net: bridgedFabricNet(def, p.name) ?? cascadeNet(p.name, def),
	}));
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
	const cascade = hasCascadeFace(def);
	const bridged = bridgedMasters(def).length > 0;
	if (attached.length === 0 && !cascade && !bridged) return null;
	const mod = busSystemModuleName(def);
	const ic = busModuleName(def);
	const lines: string[] = [
		`// Generated by autowire plugin wishbone (system ${def.name}). Do not edit.`,
		"// Type-A wrapper: fabric + attached wishbone-regfile leaves (analysis → RtlIndex).",
	];
	if (cascade) {
		lines.push(
			'// Cascade face Master("uplink") is remapped to i_wb_* / o_wb_* (parent SlaveBus).',
		);
	}
	lines.push(
		"//",
		"//------------------------------------------------------------------------------",
		`//  Module: ${mod}`,
		`//  Desc:   ${def.desc}`,
		`//  Fabric: ${ic}`,
		"//  Attached regfile hangs:",
	);
	for (const s of attached) {
		const rf = s.regfile;
		if (!rf) continue;
		lines.push(
			`//    ${s.name}  ${rf.name}_regfile  base=0x${hex(s.base)}  mask=0x${hex(s.mask)}`,
		);
	}
	if (bridged) {
		lines.push("//  Bridged masters (bridge / wb_cdc before the fabric):");
		lines.push(...masterSummary(def));
	}
	lines.push(
		"//------------------------------------------------------------------------------",
		"",
	);
	lines.push(`module ${mod} (`);
	lines.push(...formatPortList(wrapperPorts(def)));
	lines.push(");", "");
	lines.push(...internalWbNets(def));
	lines.push(...emitMasterBlocks(def));
	lines.push(...fabricInst(def), "");
	for (const s of attached) {
		lines.push(...leafInst(def, s), "");
	}
	lines.push("endmodule", "");
	return lines.join("\n");
}
