// Type-A wrapper: fabric + inline wishbone-regfile leaves.
// External regfile hangs expose their fabric WB ports for upper-level leaves.

import {
	type PrintStyle,
	printSv,
	type RenderConnect,
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

function cdcTargetWbNet(slave: WbSlave, port: string): string {
	return `${slave.name}_cdc_${port}`;
}

function cdcTgaNet(slave: WbSlave): string {
	return `${slave.name}_cdc_tga`;
}

function cdcTgaPart(slave: WbSlave, domain: string): string {
	const shadows = slave.regfile?.shadows ?? [];
	let lo = 0;
	for (const shadow of shadows) {
		if (shadow.name === domain) {
			return shadow.tag_width === 1
				? String(lo)
				: `${lo + shadow.tag_width - 1}:${lo}`;
		}
		lo += shadow.tag_width;
	}
	return "";
}

function cdcPortName(slave: WbSlave, suffix: "clock" | "reset"): string {
	return slave.cdc?.[suffix] ?? "";
}

function cdcTagPack(
	slave: WbSlave,
	source: (domain: string) => string,
): string {
	const shadows = slave.regfile?.shadows ?? [];
	if (shadows.length === 0) return "1'b0";
	if (shadows.length === 1) return source(shadows[0]?.name ?? "");
	return `{${[...shadows]
		.reverse()
		.map((s) => source(s.name))
		.join(", ")}}`;
}

function cdcConn(port: string, to: string, packed = ""): RenderConnect {
	return {
		port,
		to,
		part: "",
		type: "",
		dir: "",
		portPacked: packed,
		portUnpacked: "",
	};
}

function cdcInst(slave: WbSlave): RenderInst {
	const rf = slave.regfile;
	if (!rf || !slave.cdc)
		throw new Error(`wishbone: slave ${slave.name} has no CDC leaf`);
	const aw = rf.addr_width;
	const tw = Math.max(
		1,
		rf.shadows.reduce((n, s) => n + s.tag_width, 0),
	);
	const sourceTga = cdcTagPack(
		slave,
		(domain) => `${slave.name}_i_wb_tga_${domain}`,
	);
	const conns = [
		cdcConn("s_clk", "clk"),
		cdcConn("s_rst_n", "rst_n"),
		cdcConn("s_cyc", `${slave.name}_i_wb_cyc`),
		cdcConn("s_stb", `${slave.name}_i_wb_stb`),
		cdcConn("s_we", `${slave.name}_i_wb_we`),
		cdcConn("s_adr", `${slave.name}_i_wb_adr`, packedRange(aw)),
		cdcConn("s_dat", `${slave.name}_i_wb_dat`, "[31:0]"),
		cdcConn("s_sel", `${slave.name}_i_wb_sel`, "[3:0]"),
		cdcConn("s_tga", sourceTga, packedRange(tw)),
		cdcConn("s_ack", `${slave.name}_o_wb_ack`),
		cdcConn("s_err", cdcTargetWbNet(slave, "err")),
		cdcConn("clk", cdcPortName(slave, "clock")),
		cdcConn("rst_n", cdcPortName(slave, "reset")),
		cdcConn("m_cyc", cdcTargetWbNet(slave, "cyc")),
		cdcConn("m_stb", cdcTargetWbNet(slave, "stb")),
		cdcConn("m_we", cdcTargetWbNet(slave, "we")),
		cdcConn("m_adr", cdcTargetWbNet(slave, "adr"), packedRange(aw)),
		cdcConn("m_dat", cdcTargetWbNet(slave, "dat"), "[31:0]"),
		cdcConn("m_sel", cdcTargetWbNet(slave, "sel"), "[3:0]"),
		cdcConn("m_tga", cdcTgaNet(slave), packedRange(tw)),
		cdcConn("m_ack", cdcTargetWbNet(slave, "ack")),
		cdcConn("m_rdat", cdcTargetWbNet(slave, "rdat"), "[31:0]"),
	];
	return {
		id: `u_${slave.name}_cdc`,
		mod: "wb_cdc",
		params: [
			{ name: "AW", value: String(aw) },
			{ name: "TW", value: String(tw) },
		],
		connects: conns,
	};
}

function packedRange(width: number): string {
	return width > 1 ? `[${width - 1}:0]` : "";
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

function readyNames(slave: WbSlave): Set<string> {
	const rf = slave.regfile;
	if (!rf) return new Set();
	return new Set(
		layoutRegfile(rf)
			.cells.map((c) => c.ready)
			.filter((name): name is string => name !== undefined)
			.map((name) => `i_${name}`),
	);
}

function readyPorts(slave: WbSlave): PortDecl[] {
	const rf = slave.regfile;
	if (!rf) return [];
	const names = readyNames(slave);
	return collectPorts(layoutRegfile(rf)).filter((p) => names.has(p.name));
}

function cdcPortDecl(slave: WbSlave): PortDecl[] {
	if (!slave.cdc) return [];
	return [
		{
			dir: "input",
			packed: "",
			name: slave.cdc.clock,
			comment: `Regfile CDC clock for ${slave.name}`,
		},
		{
			dir: "input",
			packed: "",
			name: slave.cdc.reset,
			comment: `Regfile CDC reset for ${slave.name}`,
		},
	];
}

// Ready roles are deliberately shared by exact i_<name>; unlike ordinary sidebands,
// aliases never receive a promoted hang prefix.
function sidebandPorts(slave: WbSlave): PortDecl[] {
	const rf = slave.regfile;
	if (!rf) return [];
	const laid = layoutRegfile(rf);
	const table = rf.name;
	const ready = readyNames(slave);
	return collectPorts(laid).filter(
		(p) => !isLeafClk(p.name) && !isLeafWb(p.name, table) && !ready.has(p.name),
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
	const readyPortNames = new Set<string>();
	for (const s of attached) {
		for (const p of readyPorts(s)) {
			if (ports.some((x) => x.name === p.name)) {
				if (!readyPortNames.has(p.name)) {
					throw new Error(
						`wishbone-bus: wrapper ${def.name} port collision on ready input "${p.name}"`,
					);
				}
				const prior = ports.find((x) => x.name === p.name);
				if (prior?.packed !== p.packed || prior.unpacked !== p.unpacked) {
					throw new Error(
						`wishbone-bus: wrapper ${def.name} ready input collision on "${p.name}" has mismatched width`,
					);
				}
				continue;
			}
			ports.push({ ...p, comment: `Regfile ready input ${p.name.slice(2)}` });
			readyPortNames.add(p.name);
		}
	}
	const resetPortNames = new Set<string>(["i_rst_n"]);
	for (const s of attached) {
		for (const name of s.regfile?.reset_domains ?? [])
			resetPortNames.add(`i_${name}`);
	}
	for (const name of readyPortNames) {
		if (resetPortNames.has(name))
			throw new Error(
				`wishbone-bus: wrapper ${def.name} ready input collides with reset domain "${name}"`,
			);
	}

	for (const s of attached) {
		const rf = s.regfile;
		if (!rf) continue;
		let banner = false;
		for (const p of sidebandPorts(s)) {
			const name = promoteName(s.name, rf.name, p.name);
			if (ports.some((x) => x.name === name)) {
				// Same-named reset domain from another hang: one shared wrapper
				// input feeds every leaf that declared it. Anything else
				// colliding here is a bug, not a merge.
				const isDomainPort =
					p.name.startsWith("i_") &&
					(rf.reset_domains ?? []).includes(p.name.slice(2));
				if (isDomainPort && !readyPortNames.has(name)) continue;
				throw new Error(
					`wishbone-bus: wrapper ${def.name} port collision on "${name}"`,
				);
			}
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
	for (const s of attached) {
		for (const p of cdcPortDecl(s)) {
			if (ports.some((x) => x.name === p.name)) {
				throw new Error(
					`wishbone-bus: wrapper ${def.name} CDC port collision on "${p.name}"`,
				);
			}
			ports.push(p);
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
	const ready = new Set(
		laid.cells.flatMap((c) => (c.ready === undefined ? [] : [`i_${c.ready}`])),
	);
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
			pairs.push({ port: p.name, net: slave.cdc?.clock ?? "clk", ...meta });
			continue;
		}
		if (p.name === "i_rst_n") {
			pairs.push({ port: p.name, net: slave.cdc?.reset ?? "rst_n", ...meta });
			continue;
		}
		if (ready.has(p.name)) {
			pairs.push({ port: p.name, net: p.name, ...meta });
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
			if (!slave.cdc) {
				pairs.push({ port: p.name, ...meta, net: fabric.name });
				continue;
			}
			const input = p.name.startsWith(`${table}_i_wb_`);
			const suffix = p.name.slice(`${table}_${input ? "i" : "o"}_wb_`.length);
			if (suffix.startsWith("tga_")) {
				pairs.push({
					port: p.name,
					...meta,
					net: cdcTgaNet(slave),
					part: cdcTgaPart(slave, suffix.slice(4)),
				});
			} else {
				const target = suffix === "dat" ? (input ? "dat" : "rdat") : suffix;
				pairs.push({
					port: p.name,
					...meta,
					net: cdcTargetWbNet(slave, target),
				});
			}
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

function cdcInstForSlave(slave: WbSlave): RenderInst | null {
	return slave.cdc ? cdcInst(slave) : null;
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

function cdcSignals(slave: WbSlave, nt: string): RenderSignal[] {
	if (!slave.cdc || !slave.regfile) return [];
	const aw = slave.regfile.addr_width;
	const tw = Math.max(
		1,
		slave.regfile.shadows.reduce((n, s) => n + s.tag_width, 0),
	);
	return [
		{
			name: cdcTargetWbNet(slave, "adr"),
			packed: packedRange(aw),
			unpacked: "",
			nettype: nt,
		},
		{
			name: cdcTargetWbNet(slave, "dat"),
			packed: "[31:0]",
			unpacked: "",
			nettype: nt,
		},
		{
			name: cdcTargetWbNet(slave, "sel"),
			packed: "[3:0]",
			unpacked: "",
			nettype: nt,
		},
		{
			name: cdcTargetWbNet(slave, "cyc"),
			packed: "",
			unpacked: "",
			nettype: nt,
		},
		{
			name: cdcTargetWbNet(slave, "stb"),
			packed: "",
			unpacked: "",
			nettype: nt,
		},
		{
			name: cdcTargetWbNet(slave, "we"),
			packed: "",
			unpacked: "",
			nettype: nt,
		},
		{
			name: cdcTargetWbNet(slave, "ack"),
			packed: "",
			unpacked: "",
			nettype: nt,
		},
		{
			name: cdcTargetWbNet(slave, "rdat"),
			packed: "[31:0]",
			unpacked: "",
			nettype: nt,
		},
		{
			name: cdcTargetWbNet(slave, "err"),
			packed: "",
			unpacked: "",
			nettype: nt,
		},
		{
			name: cdcTgaNet(slave),
			packed: packedRange(tw),
			unpacked: "",
			nettype: nt,
		},
	];
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
	const cdcAttached = attached.filter((s) => s.cdc);
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
		signals: [
			...internalWbSignals(def, nt),
			...cdcAttached.flatMap((s) => cdcSignals(s, nt)),
			...masters.signals,
		],
		insts: [
			...masters.insts,
			fabricInst(def),
			...attached.flatMap((s) => {
				const cdc = cdcInstForSlave(s);
				const leaf = leafInst(def, s);
				return [...(cdc ? [cdc] : []), ...(leaf ? [leaf] : [])];
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
