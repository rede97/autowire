// Master faces inside `<bus>_system`: APB / JTAG bridges and wb_cdc.
// Contract: docs/plugins/wishbone-master.md. The fabric keeps plain WB master
// ports; the wrapper hides them behind `{m}_fab_*` nets and exposes the native
// protocol ports instead.

import {
	type BusDef,
	domainWidth,
	isBridgedMaster,
	masterBridge,
	tagDomainsWidth,
	type WbMaster,
} from "./dsl.ts";
import { busModuleKind, busSystemModuleName, type FabricPort } from "./emit.ts";
import { packedTagExpr, tagPlan, tagPort } from "./tag.ts";

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

function net(packed: string, name: string): string {
	return `\tlogic ${packed.padEnd(7)}${name};`;
}

function fabNets(m: WbMaster, aw: number, tw: number): string[] {
	const lines = [
		net(packedRange(aw), fab(m, "adr")),
		net("[31:0]", fab(m, "wdat")),
		net("[3:0]", fab(m, "sel")),
	];
	if (tw > 0) lines.push(net(packedRange(tw), fab(m, "tga")));
	lines.push(
		net("", fab(m, "cyc")),
		net("", fab(m, "stb")),
		net("", fab(m, "we")),
		net("[31:0]", fab(m, "rdat")),
		net("", fab(m, "ack")),
	);
	return lines;
}

function srcNets(m: WbMaster, aw: number): string[] {
	return [
		net("", src(m, "cyc")),
		net("", src(m, "stb")),
		net("", src(m, "we")),
		net(packedRange(aw), src(m, "adr")),
		net("[31:0]", src(m, "wdat")),
		net("[3:0]", src(m, "sel")),
		net("", src(m, "ack")),
		net("", src(m, "err")),
		net("[31:0]", src(m, "rdat")),
	];
}

function conns(pairs: ReadonlyArray<readonly [string, string]>): string[] {
	const pad = Math.max(...pairs.map(([p]) => p.length));
	return pairs.map(
		([p, n], i) =>
			`\t\t.${p.padEnd(pad)}(${n})${i === pairs.length - 1 ? "" : ","}`,
	);
}

function bits3(v: number): string {
	return `3'b${v.toString(2).padStart(3, "0")}`;
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
): string[] {
	const pairs: Array<readonly [string, string]> = [
		["s_clk", clk],
		["s_rst_n", rst],
		["s_cyc", s.cyc],
		["s_stb", s.stb],
		["s_we", s.we],
		["s_adr", s.adr],
		["s_dat", s.wdat],
		["s_sel", s.sel],
	];
	if (tw > 0) pairs.push(["s_tga", sTga ?? `${tw}'d0`]);
	pairs.push(
		["s_ack", s.ack],
		["s_err", s.err],
		["s_rdat", s.rdat],
		["clk", "clk"],
		["rst_n", "rst_n"],
		["m_cyc", fab(m, "cyc")],
		["m_stb", fab(m, "stb")],
		["m_we", fab(m, "we")],
		["m_adr", fab(m, "adr")],
		["m_dat", fab(m, "wdat")],
		["m_sel", fab(m, "sel")],
	);
	if (tw > 0) pairs.push(["m_tga", fab(m, "tga")]);
	pairs.push(["m_ack", fab(m, "ack")], ["m_rdat", fab(m, "rdat")]);
	return [
		`\twb_cdc #(.AW(${aw}), .TW(${tw}), .TIMEOUT(${m.timeout ?? 0})) u_${m.name}_cdc (`,
		...conns(pairs),
		"\t);",
	];
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

function emitWbMaster(m: WbMaster, aw: number, tw: number): string[] {
	const n = m.name;
	return cdcInst(
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
	);
}

function emitApbMaster(m: WbMaster, aw: number, tw: number): string[] {
	const n = m.name;
	const out: string[] = [];
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
	out.push(
		`\twb_apb2wb #(.AW(${aw}), .PPROT_MASK(${bits3(mask)}), .PPROT_VAL(${bits3(val)})) u_${n}_apb (`,
		...conns([
			["pclk", pclk],
			["presetn", presetn],
			["paddr", `${n}_paddr`],
			["psel", `${n}_psel`],
			["penable", `${n}_penable`],
			["pwrite", `${n}_pwrite`],
			["pwdata", `${n}_pwdata`],
			["pstrb", `${n}_pstrb`],
			["pprot", `${n}_pprot`],
			["prdata", `${n}_prdata`],
			["pready", `${n}_pready`],
			["pslverr", `${n}_pslverr`],
			["wb_cyc", w.cyc],
			["wb_stb", w.stb],
			["wb_we", w.we],
			["wb_adr", w.adr],
			["wb_dat", w.wdat],
			["wb_sel", w.sel],
			["wb_ack", w.ack],
			["wb_err", w.err],
			["wb_rdat", w.rdat],
		]),
		"\t);",
	);
	if (m.cdc) {
		out.push("", ...cdcInst(m, aw, tw, pclk, presetn, srcMap(m), undefined));
	} else if (tw > 0) {
		out.push(`\tassign ${fab(m, "tga")} = ${tw}'d0;`);
	}
	return out;
}

function emitJtagMaster(m: WbMaster, aw: number, tw: number): string[] {
	const n = m.name;
	const s = srcMap(m);
	return [
		`\twb_jtag_tdr #(.AW(${aw})) u_${n}_jtag (`,
		...conns([
			["tck", `${n}_tck`],
			["trst_n", `${n}_trst_n`],
			["sel", `${n}_sel`],
			["capture_dr", `${n}_capture_dr`],
			["shift_dr", `${n}_shift_dr`],
			["update_dr", `${n}_update_dr`],
			["tdi", `${n}_tdi`],
			["tdo", `${n}_tdo`],
			["en", `${n}_en`],
			["wb_cyc", s.cyc],
			["wb_stb", s.stb],
			["wb_we", s.we],
			["wb_adr", s.adr],
			["wb_dat", s.wdat],
			["wb_sel", s.sel],
			["wb_ack", s.ack],
			["wb_err", s.err],
			["wb_rdat", s.rdat],
		]),
		"\t);",
		"",
		...cdcInst(m, aw, tw, `${n}_tck`, `${n}_trst_n`, s, undefined),
	];
}

/** Internal nets + bridge / CDC instances for every bridged master. */
export function emitMasterBlocks(def: BusDef): string[] {
	const aw = def.addr_width;
	const tw = tagDomainsWidth(tagPlan(def).inherited);
	const out: string[] = [];
	for (const m of bridgedMasters(def)) {
		const b = masterBridge(m);
		out.push(
			"\t//------------------------------------------------------------------------------",
			`\t//  ${faceComment(m)}`,
			"\t//------------------------------------------------------------------------------",
			...fabNets(m, aw, tw),
		);
		if (b !== "wb" && m.cdc) out.push(...srcNets(m, aw));
		out.push("");
		if (b === "apb") out.push(...emitApbMaster(m, aw, tw));
		else if (b === "jtag") out.push(...emitJtagMaster(m, aw, tw));
		else out.push(...emitWbMaster(m, aw, tw));
		out.push("");
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

/** IEEE 1687 ICL for the JTAG TDR clients on `<bus>_system`. */
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
