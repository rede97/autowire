// Master faces inside `<bus>_bus_cfg`: APB / JTAG bridges and wb_cdc.
// Contract: docs/plugins/wishbone-master.md. The fabric keeps plain WB master
// ports; the wrapper hides them behind `{m}_fab_*` nets and exposes the native
// protocol ports instead.

import type {
	RenderConnect,
	RenderInst,
	RenderSignal,
} from "../../core/printer.ts";
import {
	type BusDef,
	domainWidth,
	isBridgedMaster,
	masterBridge,
	tagDomainsWidth,
	type WbMaster,
} from "./dsl.ts";
import { busModuleKind, busSystemModuleName, type FabricPort } from "./emit.ts";
import { tagPlan, tagPort } from "./tag.ts";

export const MASTER_MODULES = [
	"wb_sync_cell",
	"wb_cdc",
	"wb_apb2wb",
	"wb_jtag_tdr",
] as const;

type Role =
	| "adr"
	| "wdat"
	| "sel"
	| "tga"
	| "cyc"
	| "stb"
	| "we"
	| "rdat"
	| "ack";

const DECODER_ROLES: Record<string, Role> = {
	m_adr_i: "adr",
	m_dat_i: "wdat",
	m_sel_i: "sel",
	m_tga_i: "tga",
	m_cyc_i: "cyc",
	m_stb_i: "stb",
	m_we_i: "we",
	m_dat_o: "rdat",
	m_ack_o: "ack",
};

const IC_ROLES: Record<string, Role> = {
	o_wb_adr: "adr",
	o_wb_dat: "wdat",
	o_wb_sel: "sel",
	o_wb_tga_tag: "tga",
	o_wb_cyc: "cyc",
	o_wb_stb: "stb",
	o_wb_we: "we",
	i_wb_dat: "rdat",
	i_wb_ack: "ack",
};

function packedRange(width: number): string {
	return width > 1 ? `[${width - 1}:0]` : "";
}

export function bridgedMasters(def: BusDef): WbMaster[] {
	return def.masters.filter(isBridgedMaster);
}

export function busNeedsMasterModules(def: BusDef): boolean {
	return bridgedMasters(def).length > 0;
}

export function jtagMasters(def: BusDef): WbMaster[] {
	return def.masters.filter((m) => masterBridge(m) === "jtag");
}

/** Bridged master owning fabric port `name`, with the port's WB role. */
function fabricRole(
	def: BusDef,
	name: string,
): { m: WbMaster; role: Role } | undefined {
	if (busModuleKind(def) === "decoder") {
		const m = def.masters[0];
		const role = DECODER_ROLES[name];
		if (!m || !role || !isBridgedMaster(m)) return undefined;
		return { m, role };
	}
	for (const m of bridgedMasters(def)) {
		if (!name.startsWith(`${m.name}_`)) continue;
		const role = IC_ROLES[name.slice(m.name.length + 1)];
		if (role) return { m, role };
	}
	return undefined;
}

function fab(m: WbMaster, role: Role): string {
	return `${m.name}_fab_${role}`;
}

function src(m: WbMaster, role: Role | "err"): string {
	return `${m.name}_src_${role}`;
}

/** Fabric port hidden behind a bridged master (wrapper drives `{m}_fab_*`). */
export function isBridgedFabricPort(def: BusDef, name: string): boolean {
	return fabricRole(def, name) !== undefined;
}

/** Wrapper net for a fabric port owned by a bridged master. */
export function bridgedFabricNet(
	def: BusDef,
	name: string,
): string | undefined {
	const hit = fabricRole(def, name);
	return hit ? fab(hit.m, hit.role) : undefined;
}

function wbFacePorts(def: BusDef, m: WbMaster, aw: number): FabricPort[] {
	const n = m.name;
	const ports: FabricPort[] = [
		{ dir: "input", packed: "", name: `${n}_clk` },
		{ dir: "input", packed: "", name: `${n}_rst_n` },
		{ dir: "input", packed: packedRange(aw), name: `${n}_o_wb_adr` },
		{ dir: "input", packed: "[31:0]", name: `${n}_o_wb_dat` },
		{ dir: "input", packed: "[3:0]", name: `${n}_o_wb_sel` },
		...tagPlan(def).inherited.map((t) => ({
			dir: "input" as const,
			packed: packedRange(domainWidth(t.domain)),
			name: tagPort(`${n}_o_wb`, t.domain.name),
		})),
	];
	ports.push(
		{ dir: "input", packed: "", name: `${n}_o_wb_cyc` },
		{ dir: "input", packed: "", name: `${n}_o_wb_stb` },
		{ dir: "input", packed: "", name: `${n}_o_wb_we` },
		{ dir: "output", packed: "[31:0]", name: `${n}_i_wb_dat` },
		{ dir: "output", packed: "", name: `${n}_i_wb_ack` },
		{ dir: "output", packed: "", name: `${n}_i_wb_err` },
	);
	return ports;
}

function apbFacePorts(m: WbMaster, aw: number): FabricPort[] {
	const n = m.name;
	const ports: FabricPort[] = [];
	if (m.cdc) {
		ports.push(
			{ dir: "input", packed: "", name: `${n}_pclk` },
			{ dir: "input", packed: "", name: `${n}_presetn` },
		);
	}
	ports.push(
		{ dir: "input", packed: packedRange(aw), name: `${n}_paddr` },
		{ dir: "input", packed: "", name: `${n}_psel` },
		{ dir: "input", packed: "", name: `${n}_penable` },
		{ dir: "input", packed: "", name: `${n}_pwrite` },
		{ dir: "input", packed: "[31:0]", name: `${n}_pwdata` },
		{ dir: "input", packed: "[3:0]", name: `${n}_pstrb` },
		{ dir: "input", packed: "[2:0]", name: `${n}_pprot` },
		{ dir: "output", packed: "[31:0]", name: `${n}_prdata` },
		{ dir: "output", packed: "", name: `${n}_pready` },
		{ dir: "output", packed: "", name: `${n}_pslverr` },
	);
	return ports;
}

function jtagFacePorts(m: WbMaster): FabricPort[] {
	const n = m.name;
	return [
		{ dir: "input", packed: "", name: `${n}_tck` },
		{ dir: "input", packed: "", name: `${n}_trst_n` },
		{ dir: "input", packed: "", name: `${n}_sel` },
		{ dir: "input", packed: "", name: `${n}_capture_dr` },
		{ dir: "input", packed: "", name: `${n}_shift_dr` },
		{ dir: "input", packed: "", name: `${n}_update_dr` },
		{ dir: "input", packed: "", name: `${n}_tdi` },
		{ dir: "output", packed: "", name: `${n}_tdo` },
		{ dir: "input", packed: "", name: `${n}_en` },
	];
}

function faceComment(m: WbMaster): string {
	const b = masterBridge(m);
	const how =
		b === "apb"
			? `APB${m.cdc ? " + wb_cdc" : " (fabric clk)"}`
			: b === "jtag"
				? "JTAG TDR (DFT TAP / SIB client) + wb_cdc"
				: "WB + wb_cdc";
	return `Master ${m.name} — ${m.desc} [${how}]`;
}

/** Native wrapper ports of every bridged master. */
export function masterFacePorts(def: BusDef): FabricPort[] {
	const out: FabricPort[] = [];
	for (const m of bridgedMasters(def)) {
		const b = masterBridge(m);
		const ports =
			b === "apb"
				? apbFacePorts(m, def.addr_width)
				: b === "jtag"
					? jtagFacePorts(m)
					: wbFacePorts(def, m, def.addr_width);
		const [first, ...rest] = ports;
		if (!first) continue;
		out.push({ ...first, comment: faceComment(m) }, ...rest);
	}
	return out;
}

/** Signals / instances / tie-off assigns of the bridged masters. */
export interface MasterModel {
	signals: RenderSignal[];
	insts: RenderInst[];
	assigns: { lhs: string; rhs: string }[];
}

function sig(
	nt: string,
	packed: string,
	name: string,
	comment?: string,
): RenderSignal {
	return { name, packed, unpacked: "", nettype: nt, comment };
}

function fabSignals(
	m: WbMaster,
	aw: number,
	tw: number,
	nt: string,
): RenderSignal[] {
	const out = [
		sig(nt, packedRange(aw), fab(m, "adr")),
		sig(nt, "[31:0]", fab(m, "wdat")),
		sig(nt, "[3:0]", fab(m, "sel")),
	];
	if (tw > 0) out.push(sig(nt, packedRange(tw), fab(m, "tga")));
	out.push(
		sig(nt, "", fab(m, "cyc")),
		sig(nt, "", fab(m, "stb")),
		sig(nt, "", fab(m, "we")),
		sig(nt, "[31:0]", fab(m, "rdat")),
		sig(nt, "", fab(m, "ack")),
	);
	return out;
}

function srcSignals(m: WbMaster, aw: number, nt: string): RenderSignal[] {
	return [
		sig(nt, "", src(m, "cyc")),
		sig(nt, "", src(m, "stb")),
		sig(nt, "", src(m, "we")),
		sig(nt, packedRange(aw), src(m, "adr")),
		sig(nt, "[31:0]", src(m, "wdat")),
		sig(nt, "[3:0]", src(m, "sel")),
		sig(nt, "", src(m, "ack")),
		sig(nt, "", src(m, "err")),
		sig(nt, "[31:0]", src(m, "rdat")),
	];
}

function conn(port: string, to: string): RenderConnect {
	return {
		port,
		to,
		part: "",
		type: "",
		dir: "",
		portPacked: "",
		portUnpacked: "",
	};
}

function bits3(v: number): string {
	return `3'b${v.toString(2).padStart(3, "0")}`;
}
type PortMeta = { dir: string; packed: string };

const inp = (packed = ""): PortMeta => ({ dir: "input", packed });
const out = (packed = ""): PortMeta => ({ dir: "output", packed });

/** Fill print-time port facts (dir / packed) of bridge connects from the
 *  plugin-owned module templates (docs/plugins/rtl/). */
function withMeta(
	connects: RenderConnect[],
	meta: Record<string, PortMeta>,
): void {
	for (const c of connects) {
		const m = meta[c.port];
		if (m) {
			c.dir = m.dir;
			c.portPacked = m.packed;
		}
	}
}

/** wb_cdc template ports. */
function cdcMeta(aw: number, tw: number): Record<string, PortMeta> {
	return {
		s_clk: inp(),
		s_rst_n: inp(),
		s_cyc: inp(),
		s_stb: inp(),
		s_we: inp(),
		s_adr: inp(packedRange(aw)),
		s_dat: inp("[31:0]"),
		s_sel: inp("[3:0]"),
		s_tga: inp(packedRange(tw)),
		s_ack: out(),
		s_err: out(),
		s_rdat: out("[31:0]"),
		clk: inp(),
		rst_n: inp(),
		m_cyc: out(),
		m_stb: out(),
		m_we: out(),
		m_adr: out(packedRange(aw)),
		m_dat: out("[31:0]"),
		m_sel: out("[3:0]"),
		m_tga: out(packedRange(tw)),
		m_ack: inp(),
		m_rdat: inp("[31:0]"),
	};
}

/** WB sink ports shared by wb_apb2wb and wb_jtag_tdr. */
function wbSinkMeta(aw: number): Record<string, PortMeta> {
	return {
		wb_cyc: out(),
		wb_stb: out(),
		wb_we: out(),
		wb_adr: out(packedRange(aw)),
		wb_dat: out("[31:0]"),
		wb_sel: out("[3:0]"),
		wb_ack: inp(),
		wb_err: inp(),
		wb_rdat: inp("[31:0]"),
	};
}

/** wb_apb2wb template ports (WB sink + APB face). */
function apbMeta(aw: number): Record<string, PortMeta> {
	return {
		...wbSinkMeta(aw),
		pclk: inp(),
		presetn: inp(),
		paddr: inp(packedRange(aw)),
		psel: inp(),
		penable: inp(),
		pwrite: inp(),
		pwdata: inp("[31:0]"),
		pstrb: inp("[3:0]"),
		pprot: inp("[2:0]"),
		prdata: out("[31:0]"),
		pready: out(),
		pslverr: out(),
	};
}

/** wb_jtag_tdr template ports (WB sink + JTAG face). */
function jtagMeta(aw: number): Record<string, PortMeta> {
	return {
		...wbSinkMeta(aw),
		tck: inp(),
		trst_n: inp(),
		sel: inp(),
		capture_dr: inp(),
		shift_dr: inp(),
		update_dr: inp(),
		tdi: inp(),
		tdo: out(),
		en: inp(),
	};
}

function cdcInst(
	m: WbMaster,
	aw: number,
	tw: number,
	clk: string,
	rst: string,
	s: Record<
		"cyc" | "stb" | "we" | "adr" | "wdat" | "sel" | "ack" | "err" | "rdat",
		string
	>,
	sTga: string | undefined,
): RenderInst {
	const connects = [
		conn("s_clk", clk),
		conn("s_rst_n", rst),
		conn("s_cyc", s.cyc),
		conn("s_stb", s.stb),
		conn("s_we", s.we),
		conn("s_adr", s.adr),
		conn("s_dat", s.wdat),
		conn("s_sel", s.sel),
	];
	if (tw > 0) connects.push(conn("s_tga", sTga ?? `${tw}'d0`));
	connects.push(
		conn("s_ack", s.ack),
		conn("s_err", s.err),
		conn("s_rdat", s.rdat),
		conn("clk", "clk"),
		conn("rst_n", "rst_n"),
		conn("m_cyc", fab(m, "cyc")),
		conn("m_stb", fab(m, "stb")),
		conn("m_we", fab(m, "we")),
		conn("m_adr", fab(m, "adr")),
		conn("m_dat", fab(m, "wdat")),
		conn("m_sel", fab(m, "sel")),
	);
	if (tw > 0) connects.push(conn("m_tga", fab(m, "tga")));
	connects.push(conn("m_ack", fab(m, "ack")), conn("m_rdat", fab(m, "rdat")));
	withMeta(connects, cdcMeta(aw, tw));
	return {
		id: `u_${m.name}_cdc`,
		mod: "wb_cdc",
		params: [
			{ name: "AW", value: String(aw) },
			{ name: "TW", value: String(tw) },
			{ name: "TIMEOUT", value: String(m.timeout ?? 0) },
		],
		connects,
	};
}

function srcMap(m: WbMaster) {
	return {
		cyc: src(m, "cyc"),
		stb: src(m, "stb"),
		we: src(m, "we"),
		adr: src(m, "adr"),
		wdat: src(m, "wdat"),
		sel: src(m, "sel"),
		ack: src(m, "ack"),
		err: src(m, "err"),
		rdat: src(m, "rdat"),
	};
}

function wbMasterInsts(m: WbMaster, aw: number, tw: number): RenderInst[] {
	const n = m.name;
	return [
		cdcInst(
			m,
			aw,
			tw,
			`${n}_clk`,
			`${n}_rst_n`,
			{
				cyc: `${n}_o_wb_cyc`,
				stb: `${n}_o_wb_stb`,
				we: `${n}_o_wb_we`,
				adr: `${n}_o_wb_adr`,
				wdat: `${n}_o_wb_dat`,
				sel: `${n}_o_wb_sel`,
				ack: `${n}_i_wb_ack`,
				err: `${n}_i_wb_err`,
				rdat: `${n}_i_wb_dat`,
			},
			tw > 0 ? tagPort(`${n}_o_wb`, "tag") : undefined,
		),
	];
}

function apbMasterInsts(
	m: WbMaster,
	aw: number,
	tw: number,
): { insts: RenderInst[]; assigns: { lhs: string; rhs: string }[] } {
	const n = m.name;
	const w = m.cdc
		? srcMap(m)
		: {
				cyc: fab(m, "cyc"),
				stb: fab(m, "stb"),
				we: fab(m, "we"),
				adr: fab(m, "adr"),
				wdat: fab(m, "wdat"),
				sel: fab(m, "sel"),
				ack: fab(m, "ack"),
				err: "1'b0",
				rdat: fab(m, "rdat"),
			};
	const pclk = m.cdc ? `${n}_pclk` : "clk";
	const presetn = m.cdc ? `${n}_presetn` : "rst_n";
	const mask = m.pprot?.mask ?? 0;
	const val = m.pprot?.value ?? 0;
	const apb: RenderInst = {
		id: `u_${n}_apb`,
		mod: "wb_apb2wb",
		params: [
			{ name: "AW", value: String(aw) },
			{ name: "PPROT_MASK", value: bits3(mask) },
			{ name: "PPROT_VAL", value: bits3(val) },
		],
		connects: [
			conn("pclk", pclk),
			conn("presetn", presetn),
			conn("paddr", `${n}_paddr`),
			conn("psel", `${n}_psel`),
			conn("penable", `${n}_penable`),
			conn("pwrite", `${n}_pwrite`),
			conn("pwdata", `${n}_pwdata`),
			conn("pstrb", `${n}_pstrb`),
			conn("pprot", `${n}_pprot`),
			conn("prdata", `${n}_prdata`),
			conn("pready", `${n}_pready`),
			conn("pslverr", `${n}_pslverr`),
			conn("wb_cyc", w.cyc),
			conn("wb_stb", w.stb),
			conn("wb_we", w.we),
			conn("wb_adr", w.adr),
			conn("wb_dat", w.wdat),
			conn("wb_sel", w.sel),
			conn("wb_ack", w.ack),
			conn("wb_err", w.err),
			conn("wb_rdat", w.rdat),
		],
	};
	withMeta(apb.connects, apbMeta(aw));
	const insts = [apb];
	const assigns: { lhs: string; rhs: string }[] = [];
	if (m.cdc)
		insts.push(cdcInst(m, aw, tw, pclk, presetn, srcMap(m), undefined));
	else if (tw > 0) assigns.push({ lhs: fab(m, "tga"), rhs: `${tw}'d0` });
	return { insts, assigns };
}

function jtagMasterInsts(m: WbMaster, aw: number, tw: number): RenderInst[] {
	const n = m.name;
	const s = srcMap(m);
	const jtag: RenderInst = {
		id: `u_${n}_jtag`,
		mod: "wb_jtag_tdr",
		params: [{ name: "AW", value: String(aw) }],
		connects: [
			conn("tck", `${n}_tck`),
			conn("trst_n", `${n}_trst_n`),
			conn("sel", `${n}_sel`),
			conn("capture_dr", `${n}_capture_dr`),
			conn("shift_dr", `${n}_shift_dr`),
			conn("update_dr", `${n}_update_dr`),
			conn("tdi", `${n}_tdi`),
			conn("tdo", `${n}_tdo`),
			conn("en", `${n}_en`),
			conn("wb_cyc", s.cyc),
			conn("wb_stb", s.stb),
			conn("wb_we", s.we),
			conn("wb_adr", s.adr),
			conn("wb_dat", s.wdat),
			conn("wb_sel", s.sel),
			conn("wb_ack", s.ack),
			conn("wb_err", s.err),
			conn("wb_rdat", s.rdat),
		],
	};
	withMeta(jtag.connects, jtagMeta(aw));
	return [jtag, cdcInst(m, aw, tw, `${n}_tck`, `${n}_trst_n`, s, undefined)];
}

/** Internal nets + bridge / CDC instances for every bridged master. */
export function masterModel(def: BusDef, nt: string): MasterModel {
	const aw = def.addr_width;
	const tw = tagDomainsWidth(tagPlan(def).inherited);
	const out: MasterModel = { signals: [], insts: [], assigns: [] };
	for (const m of bridgedMasters(def)) {
		const b = masterBridge(m);
		const fs = fabSignals(m, aw, tw, nt);
		if (fs[0])
			fs[0].comment = `${"-".repeat(78)}\n ${faceComment(m)}\n${"-".repeat(78)}`;
		out.signals.push(...fs);
		if (b !== "wb" && m.cdc) out.signals.push(...srcSignals(m, aw, nt));
		if (b === "apb") {
			const r = apbMasterInsts(m, aw, tw);
			out.insts.push(...r.insts);
			out.assigns.push(...r.assigns);
		} else if (b === "jtag") out.insts.push(...jtagMasterInsts(m, aw, tw));
		else out.insts.push(...wbMasterInsts(m, aw, tw));
	}
	return out;
}
/** One-line header summary per bridged master. */
export function masterSummary(def: BusDef): string[] {
	return bridgedMasters(def).map((m) => `//    ${faceComment(m)}`);
}

export function jtagDrWidth(def: BusDef): number {
	return 2 + def.addr_width + 32;
}

/** IEEE 1687 ICL for the JTAG TDR clients on `<bus>_bus_cfg`. */
export function emitBusIcl(def: BusDef): string | null {
	const jt = jtagMasters(def);
	if (jt.length === 0) return null;
	const mod = busSystemModuleName(def);
	const aw = def.addr_width;
	const w = jtagDrWidth(def);
	const lines = [
		`// Generated by autowire plugin wishbone (ICL ${mod}). Do not edit.`,
		"// IEEE 1687 instrument view of the wb_jtag_tdr clients. Wire the ScanInterface",
		"// to the chip TAP user instruction or a SIB; see docs/plugins/wishbone-master.md.",
		"",
		`Module ${mod} {`,
	];
	for (const m of jt) {
		const n = m.name;
		lines.push(
			`\t// ${m.name} — ${m.desc}`,
			`\tScanInPort    ${n}_tdi;`,
			`\tScanOutPort   ${n}_tdo { Source ${n}_dr[0]; }`,
			`\tShiftEnPort   ${n}_shift_dr;`,
			`\tCaptureEnPort ${n}_capture_dr;`,
			`\tUpdateEnPort  ${n}_update_dr;`,
			`\tSelectPort    ${n}_sel;`,
			`\tTCKPort       ${n}_tck;`,
			`\tResetPort     ${n}_trst_n { ActivePolarity 0; }`,
			`\tDataInPort    ${n}_en;`,
			`\tScanInterface ${n} {`,
			`\t\tPort ${n}_tdi; Port ${n}_tdo; Port ${n}_shift_dr; Port ${n}_capture_dr;`,
			`\t\tPort ${n}_update_dr; Port ${n}_sel; Port ${n}_tck; Port ${n}_trst_n;`,
			"\t}",
			`\tScanRegister ${n}_dr[${w - 1}:0] {`,
			`\t\tScanInSource ${n}_tdi;`,
			`\t\tResetValue ${w}'b0;`,
			"\t}",
			`\tAlias ${n}_op[1:0]      = ${n}_dr[${w - 1}:${w - 2}];`,
			`\tAlias ${n}_st[1:0]      = ${n}_dr[${w - 1}:${w - 2}];`,
			`\tAlias ${n}_adr[${aw - 1}:0] = ${n}_dr[${31 + aw}:32];`,
			`\tAlias ${n}_dat[31:0]    = ${n}_dr[31:0];`,
			"",
		);
	}
	lines.push("}", "");
	return lines.join("\n");
}

/** IEEE 1687 PDL read / write procedures (launch, idle, poll status). */
export function emitBusPdl(def: BusDef): string | null {
	const jt = jtagMasters(def);
	if (jt.length === 0) return null;
	const mod = busSystemModuleName(def);
	const lines = [
		`# Generated by autowire plugin wishbone (PDL ${mod}). Do not edit.`,
		"# op 0b01 read / 0b10 write; st 0b00 ok, 0b01 busy, 0b10 err (sticky).",
		"",
		`iProcsForModule ${mod}`,
		"",
	];
	for (const m of jt) {
		const n = m.name;
		const idle = m.idle ?? 16;
		lines.push(
			`iProc ${n}_write { addr data } {`,
			`\tiWrite ${n}_op 0b10`,
			`\tiWrite ${n}_adr $addr`,
			`\tiWrite ${n}_dat $data`,
			"\tiApply",
			`\tiRunLoop ${idle} -tck`,
			`\tiWrite ${n}_op 0b00`,
			`\tiRead  ${n}_st 0b00`,
			"\tiApply",
			"}",
			"",
			`iProc ${n}_read { addr data } {`,
			`\tiWrite ${n}_op 0b01`,
			`\tiWrite ${n}_adr $addr`,
			`\tiWrite ${n}_dat 0`,
			"\tiApply",
			`\tiRunLoop ${idle} -tck`,
			`\tiWrite ${n}_op 0b00`,
			`\tiRead  ${n}_st 0b00`,
			`\tiRead  ${n}_dat $data`,
			"\tiApply",
			"}",
			"",
		);
	}
	return lines.join("\n");
}
