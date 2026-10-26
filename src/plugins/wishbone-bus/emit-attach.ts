// Type-A wrapper: fabric + inline wishbone-regfile leaves.
// External regfile hangs expose their fabric WB ports for upper-level leaves.

import {
	type PrintStyle,
	printSv,
	type RenderInst,
	type RenderModule,
	type RenderSignal,
} from "../../core/printer.ts";
import { collectPorts, type PortDecl } from "../wishbone-regfile/emit.ts";
import { layoutRegfile } from "../wishbone-regfile/layout.ts";
import type { BusDef, WbSlave } from "./dsl.ts";
import {
	busModuleKind,
	busModuleName,
	busSystemModuleName,
	listFabricPorts,
} from "./emit.ts";
import { attachedSlaves } from "./emit-map.ts";
import {
	bridgedFabricNet,
	bridgedMasters,
	isBridgedFabricPort,
	masterFacePorts,
	masterModel,
	masterSummary,
} from "./emit-master.ts";

/** The [workspace.style] switches this wrapper follows (PrintStyle) plus the
 *  net keyword: the plugin's own modules are all logic, so "auto" inherits
 *  logic here; "wire" writes wire. */
export type WrapperStyle = PrintStyle & {
	netType: "logic" | "wire" | "auto";
};

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
	return def.cascadeFace !== undefined;
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

function sidebandPorts(slave: WbSlave): PortDecl[] {
	const rf = slave.regfile;
	if (!rf) return [];
	const laid = layoutRegfile(rf);
	const table = rf.name;
	return collectPorts(laid).filter(
		(p) => !isLeafClk(p.name) && !isLeafWb(p.name, table),
	);
}

function assertExternalTagSources(
	def: BusDef,
	external: readonly WbSlave[],
): void {
	for (const tag of def.tags) {
		if (tag.source !== "reg") continue;
		const field = tag.reg_field ?? "";
		for (const slave of external) {
			const table = slave.regfile?.name;
			if (!table) continue;
			const used = sidebandPorts(slave).some(
				(p) => promoteName(slave.name, table, p.name) === field,
			);
			if (used) {
				throw new Error(
					`wishbone-bus: bus ${def.name} TagFromReg field "${field}" belongs to external regfile hang "${slave.name}"; use TagFromPin or keep the regfile internal`,
				);
			}
		}
	}
}

function wrapperPorts(def: BusDef): Array<{
	dir: "input" | "output";
	packed: string;
	name: string;
	unpacked?: string;
	comment?: string;
}> {
	const attached = attachedSlaves(def).filter((s) => !s.external);
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
			(p.wb?.kind === "slave" && attachedIds.has(p.wb.endpoint)) ||
			isBridgedFabricPort(def, p);
		if (hide) continue;
		ports.push(p);
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

function leafPairs(
	def: BusDef,
	slave: WbSlave,
): Array<{
	port: string;
	net: string;
	part: string;
	type: string;
	dir: string;
	packed: string;
	unpacked: string;
}> {
	const rf = slave.regfile;
	if (!rf) return [];
	const laid = layoutRegfile(rf);
	const table = rf.name;
	const ports = collectPorts(laid);
	const wbPorts = listFabricPorts(def).filter((p) =>
		isSlaveWbPort(p.name, slave.name),
	);
	const pairs: Array<{
		port: string;
		net: string;
		part: string;
		type: string;
		dir: string;
		packed: string;
		unpacked: string;
	}> = [];
	for (const p of ports) {
		const meta = {
			part: "",
			type: "",
			dir: p.dir,
			packed: p.packed,
			unpacked: p.unpacked ?? "",
		};
		if (p.name === "i_clk") {
			pairs.push({ port: p.name, net: "clk", ...meta });
			continue;
		}
		if (p.name === "i_rst_n") {
			pairs.push({ port: p.name, net: "rst_n", ...meta });
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
			pairs.push({ port: p.name, ...meta, net: fabric.name });
			continue;
		}
		pairs.push({
			port: p.name,
			net: promoteName(slave.name, table, p.name),
			...meta,
		});
	}
	return pairs;
}

function leafInst(def: BusDef, slave: WbSlave): RenderInst | null {
	const rf = slave.regfile;
	if (!rf || slave.external) return null;
	return {
		id: `u_${slave.name}`,
		mod: `${rf.name.toLowerCase()}_regfile`,
		params: [],
		connects: leafPairs(def, slave).map((x) => ({
			port: x.port,
			to: x.net,
			part: x.part,
			type: x.type,
			dir: x.dir,
			portPacked: x.packed,
			portUnpacked: x.unpacked,
		})),
	};
}

/** Internal WB nets: fabric slave face ↔ attached regfile leaf. */
function internalWbSignals(def: BusDef, nt: string): RenderSignal[] {
	const out: RenderSignal[] = [];
	for (const s of attachedSlaves(def).filter((s) => !s.external)) {
		const wb = listFabricPorts(def).filter((p) =>
			isSlaveWbPort(p.name, s.name),
		);
		for (const [i, p] of wb.entries()) {
			out.push({
				name: p.name,
				packed: p.packed,
				unpacked: "",
				nettype: nt,
				comment:
					i === 0
						? `Internal WB: fabric slave ${s.name} ↔ ${s.regfile?.name}_regfile`
						: undefined,
			});
		}
	}
	return out;
}

/** Fabric instance: every fabric port onto its wrapper net. */
function fabricInst(def: BusDef): RenderInst {
	return {
		id: `u_${busModuleKind(def)}`,
		mod: busModuleName(def),
		params: [],
		connects: listFabricPorts(def).map((p) => ({
			port: p.name,
			to: bridgedFabricNet(def, p) ?? p.name,
			part: "",
			type: "",
			dir: p.dir,
			portPacked: p.packed,
			portUnpacked: "",
		})),
	};
}

export function emitBusSystemSv(
	def: BusDef,
	style: WrapperStyle,
): string | null {
	const attached = attachedSlaves(def);
	const external = attached.filter((s) => s.external);
	assertExternalTagSources(def, external);
	const cascade = hasCascadeFace(def);
	const bridged = bridgedMasters(def).length > 0;
	if (attached.length === 0 && !cascade && !bridged) return null;
	const mod = busSystemModuleName(def);
	const ic = busModuleName(def);
	// The plugin's own modules are all logic: auto inherits logic here.
	const nt = style.netType === "wire" ? "wire" : "logic";
	const header: string[] = [
		`// Generated by autowire plugin wishbone (system ${def.name}). Do not edit.`,
		"// Type-A wrapper: fabric + attached wishbone-regfile leaves (analysis → RtlIndex).",
	];
	if (external.length > 0) {
		header.push(
			"// External regfile hangs expose fabric WB ports; leaves are instantiated above.",
		);
	}
	if (cascade) {
		header.push(
			"// Cascade face (.uplink()) preserves the selected master's named WB ports.",
		);
	}
	header.push(
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
		const placement =
			external.length > 0 ? `  ${s.external ? "external" : "inline"}` : "";
		header.push(
			`//    ${s.name}  ${rf.name}_regfile  base=0x${hex(s.base)}  mask=0x${hex(s.mask)}${placement}`,
		);
	}
	if (bridged) {
		header.push("//  Bridged masters (bridge / wb_cdc before the fabric):");
		header.push(...masterSummary(def));
	}
	header.push(
		"//------------------------------------------------------------------------------",
		"",
	);
	const masters = masterModel(def, nt);
	const m: RenderModule = {
		name: mod,
		header,
		params: [],
		imports: [],
		localparams: [],
		ports: wrapperPorts(def).map((p) => ({
			name: p.name,
			dir: p.dir,
			packed: p.packed,
			unpacked: p.unpacked ?? "",
			nettype: nt,
			interface: "",
			modport: "",
			comment: p.comment,
		})),
		signals: [...internalWbSignals(def, nt), ...masters.signals],
		insts: [
			...masters.insts,
			fabricInst(def),
			...attached.flatMap((s) => {
				const inst = leafInst(def, s);
				return inst ? [inst] : [];
			}),
		],
		assigns: masters.assigns,
		children: [],
		footer:
			masters.cdcTgaNc.length === 0
				? undefined
				: [
						"\t/* verilator lint_off UNUSEDSIGNAL */",
						`\twire _unused_cdc_tga = &{1'b0, ${masters.cdcTgaNc.join(", ")}};`,
						"\t/* verilator lint_on UNUSEDSIGNAL */",
					],
	};
	return printSv(m, mod, style);
}
