// Emit SystemVerilog for wishbone-bus decoder / interconnect.
// Slave ports use leaf-centric names: `{slave}_i_wb_*` / `{slave}_o_wb_*`
// so they identity-match wishbone-regfile. Masters stay flat m_* vectors when NM>1.

import type { BusDef, WbSlave } from "./dsl.ts";

function hex(n: number, width = 32): string {
	return n.toString(16).padStart(Math.ceil(width / 4), "0");
}

function wb(slave: string, stem: string): string {
	return `${slave}_${stem}`;
}

function packedRange(width: number): string {
	return width > 1 ? `[${width - 1}:0]` : "";
}

/** Decode-slot localparam: `SLOT_SD1` → `slot_sel[SLOT_SD1]`. */
function slotLp(name: string): string {
	return `SLOT_${name.toUpperCase()}`;
}

function slotSel(name: string): string {
	return `slot_sel[${slotLp(name)}]`;
}

/** Module basename: decoder if NM<=1, else interconnect. */
export function busModuleKind(def: BusDef): "decoder" | "interconnect" {
	return def.masters.length <= 1 ? "decoder" : "interconnect";
}

export function busModuleName(def: BusDef): string {
	return `${def.name.toLowerCase()}_${busModuleKind(def)}`;
}

/** Type-A wrapper that instantiates the fabric + attached regfile leaves. */
export function busSystemModuleName(def: BusDef): string {
	return `${def.name.toLowerCase()}_system`;
}

export type FabricPort = {
	readonly dir: "input" | "output";
	readonly packed: string;
	readonly name: string;
	readonly comment?: string;
};

function slaveWbPorts(s: WbSlave, aw: number): FabricPort[] {
	const n = s.name;
	const st = s.tag ?? 0;
	const ports: FabricPort[] = [
		{
			dir: "output",
			packed: packedRange(aw),
			name: wb(n, "i_wb_adr"),
			comment: `Slave ${n} — ${s.desc}`,
		},
		{ dir: "output", packed: "[31:0]", name: wb(n, "i_wb_dat") },
		{ dir: "output", packed: "[3:0]", name: wb(n, "i_wb_sel") },
	];
	if (st > 0) {
		ports.push({
			dir: "output",
			packed: packedRange(st),
			name: wb(n, "i_wb_tga"),
		});
	}
	ports.push(
		{ dir: "output", packed: "", name: wb(n, "i_wb_cyc") },
		{ dir: "output", packed: "", name: wb(n, "i_wb_stb") },
		{ dir: "output", packed: "", name: wb(n, "i_wb_we") },
		{ dir: "input", packed: "[31:0]", name: wb(n, "o_wb_dat") },
		{ dir: "input", packed: "", name: wb(n, "o_wb_ack") },
	);
	return ports;
}

function masterWbPorts(
	name: string,
	desc: string,
	aw: number,
	tw: number,
): FabricPort[] {
	const ports: FabricPort[] = [
		{
			dir: "input",
			packed: packedRange(aw),
			name: wb(name, "o_wb_adr"),
			comment: `Master ${name} — ${desc}`,
		},
		{ dir: "input", packed: "[31:0]", name: wb(name, "o_wb_dat") },
		{ dir: "input", packed: "[3:0]", name: wb(name, "o_wb_sel") },
	];
	if (tw > 0) {
		ports.push({
			dir: "input",
			packed: packedRange(tw),
			name: wb(name, "o_wb_tga"),
		});
	}
	ports.push(
		{ dir: "input", packed: "", name: wb(name, "o_wb_cyc") },
		{ dir: "input", packed: "", name: wb(name, "o_wb_stb") },
		{ dir: "input", packed: "", name: wb(name, "o_wb_we") },
		{ dir: "output", packed: "[31:0]", name: wb(name, "i_wb_dat") },
		{ dir: "output", packed: "", name: wb(name, "i_wb_ack") },
	);
	return ports;
}

/** Flattened fabric ports (clk/rst first; then masters; then slaves). */
export function listFabricPorts(def: BusDef): FabricPort[] {
	const kind = busModuleKind(def);
	const aw = def.addr_width;
	const tw = def.tag_width;
	const ports: FabricPort[] = [
		{ dir: "input", packed: "", name: "clk" },
		{ dir: "input", packed: "", name: "rst_n" },
	];
	if (kind === "interconnect") {
		ports.push({ dir: "input", packed: "", name: "rb_grant_en" });
	}
	if (kind === "decoder") {
		ports.push(
			{
				dir: "input",
				packed: packedRange(aw),
				name: "m_adr_i",
				comment: "Single master (flat; decoder mode)",
			},
			{ dir: "input", packed: "[31:0]", name: "m_dat_i" },
			{ dir: "input", packed: "[3:0]", name: "m_sel_i" },
		);
		if (tw > 0) {
			ports.push({ dir: "input", packed: packedRange(tw), name: "m_tga_i" });
		}
		ports.push(
			{ dir: "input", packed: "", name: "m_cyc_i" },
			{ dir: "input", packed: "", name: "m_stb_i" },
			{ dir: "input", packed: "", name: "m_we_i" },
			{ dir: "output", packed: "[31:0]", name: "m_dat_o" },
			{ dir: "output", packed: "", name: "m_ack_o" },
		);
	} else {
		for (const m of def.masters) {
			ports.push(...masterWbPorts(m.name, m.desc, aw, tw));
		}
	}
	for (const s of def.slaves) {
		ports.push(...slaveWbPorts(s, aw));
	}
	return ports;
}

function slavePortBlock(s: WbSlave, aw: number): string[] {
	const n = s.name;
	const adr = packedRange(aw).padEnd(7);
	const st = s.tag ?? 0;
	const lines = [
		`\t// Slave ${n} — ${s.desc}`,
		`\t//   base=0x${hex(s.base)}  mask=0x${hex(s.mask)}${s.pipe > 0 ? `  pipe=${s.pipe}` : ""}`,
		`\toutput logic ${adr}${wb(n, "i_wb_adr")},`,
		`\toutput logic [31:0] ${wb(n, "i_wb_dat")},`,
		`\toutput logic [3:0]  ${wb(n, "i_wb_sel")},`,
	];
	if (st > 0) {
		lines.push(
			`\toutput logic ${packedRange(st).padEnd(7)}${wb(n, "i_wb_tga")},`,
		);
	}
	lines.push(
		`\toutput logic ${"".padEnd(7)}${wb(n, "i_wb_cyc")},`,
		`\toutput logic ${"".padEnd(7)}${wb(n, "i_wb_stb")},`,
		`\toutput logic ${"".padEnd(7)}${wb(n, "i_wb_we")},`,
		`\tinput  logic [31:0] ${wb(n, "o_wb_dat")},`,
		`\tinput  logic ${"".padEnd(7)}${wb(n, "o_wb_ack")}`,
	);
	return lines;
}

/** Master port block (interconnect): leaf-centric `{m}_o_wb_*` in / `{m}_i_wb_*` out. */
function masterPortBlock(
	name: string,
	desc: string,
	aw: number,
	tw: number,
): string[] {
	const adr = packedRange(aw).padEnd(7);
	const lines = [
		`\t// Master ${name} — ${desc}`,
		`\tinput  logic ${adr}${wb(name, "o_wb_adr")},`,
		`\tinput  logic [31:0] ${wb(name, "o_wb_dat")},`,
		`\tinput  logic [3:0]  ${wb(name, "o_wb_sel")},`,
	];
	if (tw > 0) {
		lines.push(
			`\tinput  logic ${packedRange(tw).padEnd(7)}${wb(name, "o_wb_tga")},`,
		);
	}
	lines.push(
		`\tinput  logic ${"".padEnd(7)}${wb(name, "o_wb_cyc")},`,
		`\tinput  logic ${"".padEnd(7)}${wb(name, "o_wb_stb")},`,
		`\tinput  logic ${"".padEnd(7)}${wb(name, "o_wb_we")},`,
		`\toutput logic [31:0] ${wb(name, "i_wb_dat")},`,
		`\toutput logic ${"".padEnd(7)}${wb(name, "i_wb_ack")}`,
	);
	return lines;
}

function formatAlignedPorts(blocks: string[][]): string[] {
	// Last port of last block has no trailing comma — strip commas then re-add.
	const flat: string[] = [];
	for (const [bi, block] of blocks.entries()) {
		for (const [li, line] of block.entries()) {
			const isLast = bi === blocks.length - 1 && li === block.length - 1;
			const trimmed = line.replace(/,\s*$/, "");
			flat.push(isLast ? trimmed : `${trimmed},`);
		}
	}
	return flat;
}

/** `assign <lhs> = t0 | t1 | …;` with aligned continuation lines. */
function pushOrAssign(out: string[], lhs: string, terms: string[]): void {
	const [first, ...rest] = terms;
	if (first === undefined) return;
	if (rest.length === 0) {
		out.push(`\tassign ${lhs} = ${first};`);
		return;
	}
	out.push(`\tassign ${lhs} = ${first}`);
	const cont = "\t" + " ".repeat(`assign ${lhs} `.length);
	for (const [i, t] of rest.entries()) {
		out.push(`${cont}| ${t}${i === rest.length - 1 ? ";" : ""}`);
	}
}

function emitDecoderBody(def: BusDef): string[] {
	const aw = def.addr_width;
	const tw = def.tag_width;
	const slaves = def.slaves;
	const out: string[] = [];
	out.push(
		`\tlogic ${packedRange(aw).padEnd(7)}g_adr;`,
		"\tlogic [31:0] g_wdata;",
		"\tlogic [3:0]  g_sel;",
	);
	if (tw > 0) {
		out.push(`\tlogic ${packedRange(tw).padEnd(7)}g_tga;`);
	}
	out.push(
		"\tlogic        g_cyc;",
		"\tlogic        g_stb;",
		"\tlogic        g_we;",
		"",
		"\tassign g_adr   = m_adr_i;",
		"\tassign g_wdata = m_dat_i;",
		"\tassign g_sel   = m_sel_i;",
	);
	if (tw > 0) {
		out.push("\tassign g_tga   = m_tga_i;");
	}
	out.push(
		"\tassign g_cyc   = m_cyc_i;",
		"\tassign g_stb   = m_stb_i;",
		"\tassign g_we    = m_we_i;",
		"",
	);
	out.push(...emitDecodeAndSlaves(def, "g_"));
	out.push("", "\tlogic [31:0] rsp_dat;", "\tlogic        rsp_ack;", "");
	out.push(...emitResponseMux(slaves, "rsp_dat", "rsp_ack", "g_stb"));
	out.push("\tassign m_dat_o = rsp_dat;", "\tassign m_ack_o = rsp_ack;", "");
	return out;
}

function emitInterconnectBody(def: BusDef): string[] {
	const nm = def.masters.length;
	const aw = def.addr_width;
	const tw = def.tag_width;
	const slaves = def.slaves;
	const out: string[] = [];
	const masters = def.masters.map((m, i) => ({ ...m, i }));
	const onehot = (i: number) =>
		`${nm}'b${"0".repeat(nm - 1 - i)}1${"0".repeat(i)}`;

	const pk = `[${nm - 1}:0]`;
	const shiftFills: string[] = [];
	for (let s = 1; s < nm; s <<= 1) {
		shiftFills.push(`\t\trr_mask = rr_mask | (rr_mask >> ${s});`);
	}
	out.push(
		"\t//------------------------------------------------------------------------------",
		"\t//  Arbitration: locked while grant holds CYC",
		"\t//  rb_grant_en=0: lowest master index wins (fixed)",
		"\t//  rb_grant_en=1: round-robin — next requester after last_gnt, wrap to lowest",
		"\t//------------------------------------------------------------------------------",
		`\tlogic ${pk} grant;`,
		`\tlogic ${"".padEnd(pk.length)} busy;`,
		`\tlogic ${pk} grant_nxt;`,
		`\tlogic ${pk} prio_gnt;`,
		`\tlogic ${pk} rr_hi_gnt;`,
		`\tlogic ${pk} last_gnt;`,
		`\tlogic ${pk} rr_mask;`,
		`\tlogic ${pk} rr_req_hi;`,
		`\tlogic ${pk} m_cyc;`,
		`\tlogic ${pk} m_stb;`,
		`\tlogic ${pk} m_we;`,
		"",
	);
	// Slot vectors (bit i = masters[i]); vector channels mux by name below.
	for (const [sig, stem] of [
		["m_cyc", "o_wb_cyc"],
		["m_stb", "o_wb_stb"],
		["m_we ", "o_wb_we"],
	] as const) {
		const msbFirst = [...masters].reverse().map((m) => wb(m.name, stem));
		out.push(`\tassign ${sig} = {${msbFirst.join(", ")}};`);
	}
	const condPad = Math.max(
		...masters.map((m) => `(${wb(m.name, "o_wb_cyc")})`.length),
	);
	out.push("", "\talways_comb begin");
	for (const m of masters) {
		const kw = m.i === 0 ? "if      " : "else if ";
		const cond = `(${wb(m.name, "o_wb_cyc")})`.padEnd(condPad);
		out.push(`\t\t${kw}${cond} prio_gnt = ${onehot(m.i)};`);
	}
	out.push(
		`\t\t${"else".padEnd(`else if `.length + condPad + 1)}prio_gnt = ${nm}'b${"0".repeat(nm)};`,
		"\tend",
		"",
		"\talways_comb begin",
		"\t\trr_mask = last_gnt;",
		...shiftFills,
		"\tend",
		`\tassign rr_req_hi = m_cyc & ~rr_mask;`,
		"",
		"\talways_comb begin",
	);
	for (const m of masters) {
		const kw = m.i === 0 ? "if      " : "else if ";
		out.push(`\t\t${kw}(rr_req_hi[${m.i}]) rr_hi_gnt = ${onehot(m.i)};`);
	}
	out.push(
		`\t\telse              rr_hi_gnt = ${nm}'b${"0".repeat(nm)};`,
		"\tend",
		"",
		"\tassign grant_nxt = (rb_grant_en && |rr_req_hi) ? rr_hi_gnt : prio_gnt;",
		"",
		"\talways_ff @(posedge clk or negedge rst_n) begin",
		"\t\tif (!rst_n) begin",
		"\t\t\tbusy     <= 1'b0;",
		`\t\t\tgrant    <= ${nm}'b0;`,
		`\t\t\tlast_gnt <= ${nm}'b0;`,
		"\t\tend else if (!busy) begin",
		"\t\t\tif (|m_cyc) begin",
		"\t\t\t\tbusy     <= 1'b1;",
		"\t\t\t\tgrant    <= grant_nxt;",
		"\t\t\t\tlast_gnt <= grant_nxt;",
		"\t\t\tend",
		"\t\tend else if (!(|(m_cyc & grant))) begin",
		"\t\t\tbusy <= 1'b0;",
		"\t\tend",
		"\tend",
		"",
	);

	// Granted-request mux (master port arb): grant & replicate, OR-reduce.
	out.push(
		`\tlogic [${nm - 1}:0] gsel;`,
		`\tassign gsel = grant & {${nm}{busy}};`,
		"",
		`\tlogic ${packedRange(aw).padEnd(7)}g_adr;`,
		"\tlogic [31:0] g_wdata;",
		"\tlogic [3:0]  g_sel;",
	);
	if (tw > 0) {
		out.push(`\tlogic ${packedRange(tw).padEnd(7)}g_tga;`);
	}
	out.push(
		"\tlogic        g_cyc;",
		"\tlogic        g_stb;",
		"\tlogic        g_we;",
		"",
	);

	const muxVec = (lhs: string, stem: string, width: number) =>
		pushOrAssign(
			out,
			lhs,
			masters.map((m) => `({${width}{gsel[${m.i}]}} & ${wb(m.name, stem)})`),
		);
	muxVec("g_adr  ", "o_wb_adr", aw);
	muxVec("g_wdata", "o_wb_dat", 32);
	muxVec("g_sel  ", "o_wb_sel", 4);
	if (tw > 0) {
		muxVec("g_tga  ", "o_wb_tga", tw);
	}
	out.push(
		`\tassign g_cyc   = |(gsel & m_cyc);`,
		`\tassign g_stb   = |(gsel & m_stb);`,
		`\tassign g_we    = |(gsel & m_we);`,
		"",
	);

	out.push(...emitDecodeAndSlaves(def, "g_"));

	out.push("", "\tlogic [31:0] rsp_dat;", "\tlogic        rsp_ack;", "");
	out.push(...emitResponseMux(slaves, "rsp_dat", "rsp_ack", "g_stb"));

	out.push(
		"",
		"\t//------------------------------------------------------------------------------",
		"\t//  Master response: only the granted slot sees DAT/ACK",
		"\t//------------------------------------------------------------------------------",
	);
	const datPad = Math.max(...masters.map((m) => wb(m.name, "i_wb_dat").length));
	for (const m of masters) {
		const dat = wb(m.name, "i_wb_dat").padEnd(datPad);
		const ack = wb(m.name, "i_wb_ack").padEnd(datPad);
		out.push(
			`\tassign ${dat} = {32{gsel[${m.i}]}} & rsp_dat;`,
			`\tassign ${ack} = gsel[${m.i}] & rsp_ack;`,
		);
	}
	out.push("");
	return out;
}

function emitDecodeAndSlaves(def: BusDef, gPrefix: string): string[] {
	const slaves = def.slaves;
	const ns = slaves.length;
	const aw = def.addr_width;
	const out: string[] = [];
	const lpPad = Math.max(...slaves.map((s) => slotLp(s.name).length));
	out.push(
		"\t//------------------------------------------------------------------------------",
		"\t//  Address decode: lowest matching slave wins (mutually exclusive)",
		"\t//------------------------------------------------------------------------------",
	);
	for (let i = 0; i < ns; i++) {
		const s = slaves[i];
		if (s === undefined) continue;
		out.push(
			`\tlocalparam int unsigned ${slotLp(s.name).padEnd(lpPad)} = ${i};`,
		);
	}
	out.push(
		`\tlogic [${ns - 1}:0] slot_sel;`,
		"\tlogic        unmapped;",
		"",
		"\talways_comb begin",
		`\t\tslot_sel = ${ns}'b0;`,
		"\t\tunmapped = 1'b1;",
	);
	// High→low so the last write is the lowest index (priority).
	for (let i = ns - 1; i >= 0; i--) {
		const s = slaves[i];
		if (s === undefined) continue;
		out.push(
			`\t\tif ((${gPrefix}adr & ${aw}'h${hex(s.mask, aw)}) == ${aw}'h${hex(s.base, aw)}) begin`,
			`\t\t\tslot_sel = ${ns}'d1 << ${slotLp(s.name)};`,
			"\t\t\tunmapped = 1'b0;",
			"\t\tend",
		);
	}
	out.push("\tend", "");

	out.push(
		"\t//------------------------------------------------------------------------------",
		"\t//  Named slave drive (window offset ADR)",
		"\t//------------------------------------------------------------------------------",
	);
	const combo = slaves.filter((s) => (s.pipe ?? 0) === 0);
	const namePad =
		combo.length > 0
			? Math.max(...combo.map((s) => wb(s.name, "i_wb_adr").length))
			: 0;
	const slotPad = Math.max(...slaves.map((s) => slotSel(s.name).length));
	for (let i = 0; i < ns; i++) {
		const s = slaves[i];
		if (s === undefined) continue;
		if ((s.pipe ?? 0) > 0) {
			out.push(...emitSlavePipe(s, aw, gPrefix));
		} else {
			out.push(...emitSlaveCombo(s, aw, gPrefix, namePad, slotPad));
		}
		if (i < ns - 1) out.push("");
	}
	return out;
}

function emitSlaveCombo(
	s: WbSlave,
	aw: number,
	gPrefix: string,
	namePad: number,
	slotPad: number,
): string[] {
	const n = s.name;
	const port = (stem: string) => wb(n, stem).padEnd(namePad);
	const slot = slotSel(n).padEnd(slotPad);
	const out = [
		`\tassign ${port("i_wb_adr")} = ${slot} ? ${gPrefix}adr & ~${aw}'h${hex(s.mask, aw)} : ${aw}'d0;`,
		`\tassign ${port("i_wb_dat")} = ${gPrefix}wdata;`,
		`\tassign ${port("i_wb_sel")} = ${gPrefix}sel;`,
	];
	const st = s.tag ?? 0;
	if (st > 0) {
		out.push(`\tassign ${port("i_wb_tga")} = ${gPrefix}tga[${st - 1}:0];`);
	}
	out.push(
		`\tassign ${port("i_wb_cyc")} = ${slot} & ${gPrefix}cyc;`,
		`\tassign ${port("i_wb_stb")} = ${slot} & ${gPrefix}stb;`,
		`\tassign ${port("i_wb_we ")} = ${gPrefix}we;`,
	);
	return out;
}

/** Instantiate wb_cfg_pipe. TGA ports stay on the module; omit them when tag=0. */
function emitSlavePipe(s: WbSlave, aw: number, gPrefix: string): string[] {
	const n = s.name;
	const pipe = s.pipe;
	const st = s.tag ?? 0;
	const slot = slotSel(n);
	const winAdr = `${slot} ? ${gPrefix}adr & ~${aw}'h${hex(s.mask, aw)} : ${aw}'d0`;
	const ack = `${n}_pipe_ack`;
	const rdat = `${n}_pipe_rdat`;
	const out: string[] = [
		"\t//------------------------------------------------------------------------------",
		`\t//  Slave ${n} — wb_cfg_pipe PIPE=${pipe} (posted write / blocking read)`,
		"\t//------------------------------------------------------------------------------",
		`\tlogic        ${ack};`,
		`\tlogic [31:0] ${rdat};`,
		`\twb_cfg_pipe #(.PIPE(${pipe}), .AW(${aw}), .TW(${st})) u_${n}_pipe (`,
		"\t\t.clk(clk),",
		"\t\t.rst_n(rst_n),",
		`\t\t.m_cyc(${slot} & ${gPrefix}cyc),`,
		`\t\t.m_stb(${slot} & ${gPrefix}stb),`,
		`\t\t.m_we(${gPrefix}we),`,
		`\t\t.m_adr(${winAdr}),`,
		`\t\t.m_dat(${gPrefix}wdata),`,
		`\t\t.m_sel(${gPrefix}sel),`,
	];
	if (st > 0) {
		out.push(`\t\t.m_tga(${gPrefix}tga[${st - 1}:0]),`);
	}
	out.push(
		`\t\t.m_ack(${ack}),`,
		`\t\t.m_rdat(${rdat}),`,
		`\t\t.s_cyc(${wb(n, "i_wb_cyc")}),`,
		`\t\t.s_stb(${wb(n, "i_wb_stb")}),`,
		`\t\t.s_we(${wb(n, "i_wb_we")}),`,
		`\t\t.s_adr(${wb(n, "i_wb_adr")}),`,
		`\t\t.s_dat(${wb(n, "i_wb_dat")}),`,
		`\t\t.s_sel(${wb(n, "i_wb_sel")}),`,
	);
	if (st > 0) {
		out.push(`\t\t.s_tga(${wb(n, "i_wb_tga")}),`);
	}
	out.push(
		`\t\t.s_ack(${wb(n, "o_wb_ack")}),`,
		`\t\t.s_rdat(${wb(n, "o_wb_dat")})`,
		"\t);",
	);
	return out;
}

/** Response OR-reduction (slot_sel is one-hot; unmapped ACKs immediately). */
function emitResponseMux(
	slaves: readonly WbSlave[],
	dat: string,
	ack: string,
	stb: string,
): string[] {
	const out: string[] = [];
	pushOrAssign(
		out,
		dat,
		slaves.map((s) =>
			(s.pipe ?? 0) > 0
				? `({32{${slotSel(s.name)}}} & ${s.name}_pipe_rdat)`
				: `({32{${slotSel(s.name)}}} & ${wb(s.name, "o_wb_dat")})`,
		),
	);
	pushOrAssign(out, ack, [
		`(unmapped & ${stb})`,
		...slaves.map((s) =>
			(s.pipe ?? 0) > 0
				? `(${s.name}_pipe_ack)`
				: `(${slotSel(s.name)} & ${wb(s.name, "o_wb_ack")})`,
		),
	]);
	return out;
}

export function emitBusSv(def: BusDef): string {
	const kind = busModuleKind(def);
	const mod = busModuleName(def);
	const aw = def.addr_width;
	const nm = def.masters.length;
	const tw = def.tag_width;
	const lines: string[] = [];
	lines.push(
		`// Generated by autowire plugin wishbone (${kind} ${def.name}). Do not edit.`,
		"//",
		"//------------------------------------------------------------------------------",
		`//  Module: ${mod}`,
		`//  Desc:   ${def.desc}`,
		`//  Masters: ${nm} (${kind === "decoder" ? "decoder-only; no arbiter" : "arbiter: rb_grant_en=0 fixed / 1 round-robin"})`,
		`//  Slaves:  ${def.slaves.length} (named {slave}_i_wb_* / {slave}_o_wb_*)`,
	);
	if (tw > 0) {
		lines.push(`//  Tag:     TGA ${tw} bit (forwarded, not interpreted)`);
	}
	if (def.slaves.some((s) => (s.pipe ?? 0) > 0)) {
		lines.push(
			"//  Slave PIPE: wb_cfg_pipe per port (posted write / blocking read; master PIPE is parent)",
		);
	}
	lines.push(
		"//------------------------------------------------------------------------------",
		"//  Address map:",
	);
	for (const s of def.slaves) {
		const pipeNote = (s.pipe ?? 0) > 0 ? `  pipe=${s.pipe}` : "";
		lines.push(
			`//    0x${hex(s.base)}  mask=0x${hex(s.mask)}  ${s.name} — ${s.desc}${pipeNote}`,
		);
	}
	lines.push(
		"//------------------------------------------------------------------------------",
		"",
	);
	lines.push(`module ${mod} (`);
	lines.push("\tinput  logic        clk,");
	lines.push("\tinput  logic        rst_n,");
	if (kind === "interconnect") {
		lines.push("\tinput  logic        rb_grant_en,");
	}

	const portBlocks: string[][] = [];
	if (kind === "decoder") {
		const tr = packedRange(tw);
		const block = [
			"\t// Single master (flat; decoder mode)",
			`\tinput  logic ${packedRange(aw) ? `${packedRange(aw)} ` : ""}m_adr_i`,
			"\tinput  logic [31:0] m_dat_i",
			"\tinput  logic [3:0]  m_sel_i",
		];
		if (tw > 0) {
			block.push(`\tinput  logic ${tr ? `${tr} ` : ""}m_tga_i`);
		}
		block.push(
			"\tinput  logic        m_cyc_i",
			"\tinput  logic        m_stb_i",
			"\tinput  logic        m_we_i",
			"\toutput logic [31:0] m_dat_o",
			"\toutput logic        m_ack_o",
		);
		portBlocks.push(block);
	} else {
		for (const m of def.masters) {
			portBlocks.push(masterPortBlock(m.name, m.desc, aw, tw));
		}
	}
	for (const s of def.slaves) {
		portBlocks.push(slavePortBlock(s, aw));
	}
	lines.push(...formatAlignedPorts(portBlocks));
	lines.push(");", "");

	if (kind === "decoder") {
		lines.push(...emitDecoderBody(def));
	} else {
		lines.push(...emitInterconnectBody(def));
	}
	lines.push("endmodule", "");
	return lines.join("\n");
}
