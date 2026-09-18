// Emit SystemVerilog for a laid-out wishbone-regfile leaf.
// Port / signal columns follow workspace [style] port_align / signal_align
// (same rules as src/core/printer.ts).

import {
	Access,
	type FieldReset,
	type RegShadow,
	sidebandStem,
} from "./dsl.ts";
import type { LaidCell, LaidField, LaidRegfile } from "./layout.ts";

function hex(n: number, width = 0): string {
	const h = n.toString(16);
	return width > 0 ? h.padStart(Math.ceil(width / 4), "0") : h;
}

function resetVal(r: FieldReset | undefined, copy: number): number {
	if (r === undefined) return 0;
	if (typeof r === "number") return r;
	return r[copy] ?? 0;
}

function parseTag(tag_bits: string): { hi: number; lo: number } {
	const m = /^(\d+)\s*:\s*(\d+)$/.exec(tag_bits.trim());
	if (!m) throw new Error(`bad tag_bits ${tag_bits}`);
	return { hi: Number(m[1]), lo: Number(m[2]) };
}

function shadowByName(shadows: readonly RegShadow[], name: string): RegShadow {
	const s = shadows.find((x) => x.name === name);
	if (!s) throw new Error(`missing shadow ${name}`);
	return s;
}

function packedRange(width: number): string {
	return width > 1 ? `[${width - 1}:0]` : "";
}

/**
 * SEL byte-enable mask expanded over field bits [hi:lo] (cell-relative).
 * Field bit i (cell bit lo+i) is writable iff i_wb_sel[(lo+i)/8].
 */
function selMask(hi: number, lo: number, i_wb_sel: string): string {
	const chunks: string[] = [];
	let pos = hi + 1;
	while (pos > lo) {
		const lane = Math.floor((pos - 1) / 8);
		const laneLo = lane * 8;
		const n = pos - Math.max(lo, laneLo);
		chunks.push(
			n === 1 ? `${i_wb_sel}[${lane}]` : `{${n}{${i_wb_sel}[${lane}]}}`,
		);
		pos = Math.max(lo, laneLo);
	}
	const first = chunks[0];
	return chunks.length === 1 && first !== undefined
		? first
		: `{${chunks.join(", ")}}`;
}

/** Named Wishbone port: `{table}_i_wb_cyc` / `{table}_o_wb_ack` (leaf ↔ interconnect). */
function wbPortName(table: string, stem: string): string {
	return `${table}_${stem}`;
}

type PortDecl = {
	dir: "input" | "output";
	packed: string;
	name: string;
	/** Unpacked dimension after the name, e.g. "[4]". */
	unpacked?: string;
	/** Optional line(s) printed above the port (field / bus docs). */
	comment?: string;
};

type SigDecl = {
	packed: string;
	name: string;
	unpacked?: string;
};

/** Match printer port_align: dir / type / packed columns; names left-aligned. */
function formatPortLines(ports: readonly PortDecl[]): string[] {
	const dirPad = Math.max(...ports.map((p) => p.dir.length), 0);
	const typePad = 5; // "logic"
	const packPad = Math.max(...ports.map((p) => p.packed.length), 0);
	const lines: string[] = [];
	for (const p of ports) {
		if (p.comment) {
			for (const c of p.comment.split("\n")) {
				lines.push(`\t// ${c}`);
			}
		}
		const packCol = packPad > 0 ? ` ${p.packed.padEnd(packPad)}` : "";
		const ud = p.unpacked ? ` ${p.unpacked}` : "";
		lines.push(
			`\t${p.dir.padEnd(dirPad)} ${"logic".padEnd(typePad)}${packCol} ${p.name}${ud}`,
		);
	}
	return lines;
}

function section(title: string): string[] {
	return [
		"",
		"\t//------------------------------------------------------------------------------",
		`\t//  ${title}`,
		"\t//------------------------------------------------------------------------------",
		"",
	];
}

function fieldBits(lf: LaidField): string {
	const hi = lf.bit_offset + lf.field.width - 1;
	const lo = lf.bit_offset;
	return hi === lo ? `[${lo}]` : `[${hi}:${lo}]`;
}

/** `[hi:lo]`, collapsing to `[lo]` for single bits. */
function bitRange(hi: number, lo: number): string {
	return hi === lo ? `[${lo}]` : `[${hi}:${lo}]`;
}

/** Column pads for cell / field map comments (module-wide). */
type FieldCommentPads = {
	addrHexBits: number;
	cellName: number;
	bits: number;
	access: number;
	name: number;
};

function fieldCommentPads(
	cells: readonly LaidCell[],
	addrWidth: number,
): FieldCommentPads {
	let cellName = 0;
	let bits = 0;
	let access = 0;
	let name = 0;
	for (const c of cells) {
		cellName = Math.max(cellName, c.name.length);
		for (const lf of c.fields) {
			bits = Math.max(bits, fieldBits(lf).length);
			access = Math.max(access, lf.field.access.length);
			name = Math.max(name, lf.field.name.length);
		}
	}
	return {
		addrHexBits: addrWidth,
		cellName,
		bits,
		access,
		name,
	};
}

function fieldMapComment(c: LaidCell, pads: FieldCommentPads): string[] {
	const lines = [
		`\t// Addr: 0x${hex(c.byte_offset, pads.addrHexBits)}  RegCell: ${c.name.padEnd(pads.cellName)} — ${c.desc}`,
	];
	if (c.shadow) {
		lines.push(`\t//   shadow=${c.shadow}`);
	}
	for (const lf of c.fields) {
		const f = lf.field;
		lines.push(
			`\t//   ${fieldBits(lf).padEnd(pads.bits)}  ${f.access.padEnd(pads.access)}  ${f.name.padEnd(pads.name)} — ${f.desc}`,
		);
	}
	return lines;
}

function fieldInlineComment(lf: LaidField, pads: FieldCommentPads): string {
	const f = lf.field;
	return `${f.access.padEnd(pads.access)} ${fieldBits(lf).padEnd(pads.bits)} ${f.name.padEnd(pads.name)} — ${f.desc}`;
}

/** Match printer signal_align: nettype / packed columns; names left-aligned. */
function formatSigLines(sigs: readonly SigDecl[]): string[] {
	if (sigs.length === 0) return [];
	const typePad = 5;
	const packPad = Math.max(...sigs.map((s) => s.packed.length), 0);
	return sigs.map((s) => {
		const packCol = packPad > 0 ? ` ${s.packed.padEnd(packPad)}` : "";
		const ud = s.unpacked ? ` ${s.unpacked}` : "";
		return `\t${"logic".padEnd(typePad)}${packCol} ${s.name}${ud};`;
	});
}

function wbPortComment(name: string): string {
	switch (name) {
		case "i_clk":
			return "Clock";
		case "i_rst_n":
			return "Active-low asynchronous reset";
		case "i_wb_cyc":
			return "Wishbone CYC";
		case "i_wb_stb":
			return "Wishbone STB";
		case "i_wb_we":
			return "Wishbone WE (1=write, 0=read)";
		case "i_wb_adr":
			return "Wishbone ADR (byte address; word decode uses [addr_width-1:2])";
		case "i_wb_dat":
			return "Wishbone write data";
		case "i_wb_sel":
			return "Wishbone byte select";
		case "i_wb_tga":
			return "Wishbone TGA (shadow / user tag)";
		case "o_wb_ack":
			return "Wishbone ACK";
		case "o_wb_dat":
			return "Wishbone read data";
		default:
			return name;
	}
}

function fieldSidebandComment(
	f: { name: string; access: Access; desc: string },
	role: string,
): string {
	return `${f.access} ${role}: ${f.name} — ${f.desc}`;
}

function collectPorts(laid: LaidRegfile): PortDecl[] {
	const { def, cells, shadows, tga_width } = laid;
	const t = def.name;
	const wb = (stem: string) => wbPortName(t, stem);
	const ports: PortDecl[] = [
		{
			dir: "input",
			packed: "",
			name: "i_clk",
			comment: wbPortComment("i_clk"),
		},
		{
			dir: "input",
			packed: "",
			name: "i_rst_n",
			comment: wbPortComment("i_rst_n"),
		},
		{
			dir: "input",
			packed: "",
			name: wb("i_wb_cyc"),
			comment: `Wishbone classic slave (${t})\n${wbPortComment("i_wb_cyc")}`,
		},
		{
			dir: "input",
			packed: "",
			name: wb("i_wb_stb"),
			comment: wbPortComment("i_wb_stb"),
		},
		{
			dir: "input",
			packed: "",
			name: wb("i_wb_we"),
			comment: wbPortComment("i_wb_we"),
		},
		{
			dir: "input",
			packed: packedRange(def.addr_width),
			name: wb("i_wb_adr"),
			comment: wbPortComment("i_wb_adr"),
		},
		{
			dir: "input",
			packed: "[31:0]",
			name: wb("i_wb_dat"),
			comment: wbPortComment("i_wb_dat"),
		},
		{
			dir: "input",
			packed: "[3:0]",
			name: wb("i_wb_sel"),
			comment: wbPortComment("i_wb_sel"),
		},
	];
	if (tga_width > 0) {
		ports.push({
			dir: "input",
			packed: packedRange(tga_width),
			name: wb("i_wb_tga"),
			comment: wbPortComment("i_wb_tga"),
		});
	}
	ports.push(
		{
			dir: "output",
			packed: "",
			name: wb("o_wb_ack"),
			comment: wbPortComment("o_wb_ack"),
		},
		{
			dir: "output",
			packed: "[31:0]",
			name: wb("o_wb_dat"),
			comment: wbPortComment("o_wb_dat"),
		},
	);

	const seenShadowSel = new Set<string>();
	let sidebandBanner = false;
	for (const c of cells) {
		for (const lf of c.fields) {
			const f = lf.field;
			if (f.access === Access.RC) continue;
			const stem = sidebandStem(f);
			const sh = c.shadow ? shadowByName(shadows, c.shadow) : undefined;
			const copies = sh?.inner_shadow_mux === false ? sh.copies : 1;
			const pk = packedRange(f.width);
			const banner = (role: string): string => {
				const body = fieldSidebandComment(f, role);
				if (!sidebandBanner) {
					sidebandBanner = true;
					return `Field / shadow sidebands\n${body}`;
				}
				return body;
			};
			const arr = (name: string, dir: "input" | "output", role: string) => {
				ports.push({
					dir,
					packed: pk,
					name,
					comment: banner(role),
					...(copies > 1 ? { unpacked: `[${copies}]` } : {}),
				});
			};
			switch (f.access) {
				case Access.RO:
					if (sh) {
						ports.push({
							dir: "input",
							packed: pk,
							name: stem,
							unpacked: `[${sh.copies}]`,
							comment: banner("status in (per-copy)"),
						});
					} else {
						arr(stem, "input", "status in");
					}
					break;
				case Access.RW:
					arr(stem, "output", "register out");
					break;
				case Access.W1P:
					arr(stem, "output", "write-1 pulse out");
					break;
				case Access.W1C:
					arr(stem, "output", "write-1 clear sticky out");
					ports.push({
						dir: "input",
						packed: pk,
						name: `${stem}_set`,
						comment: banner(
							"sticky set in (hardware set; set wins over clear)",
						),
						...(copies > 1 ? { unpacked: `[${copies}]` } : {}),
					});
					break;
				case Access.RWW:
					arr(stem, "output", "register out");
					ports.push({
						dir: "input",
						packed: "",
						name: `${stem}_strb`,
						comment: banner("hardware write strobe"),
						...(copies > 1 ? { unpacked: `[${copies}]` } : {}),
					});
					ports.push({
						dir: "input",
						packed: pk,
						name: `${stem}_hwdata`,
						comment: banner("hardware write data"),
						...(copies > 1 ? { unpacked: `[${copies}]` } : {}),
					});
					break;
				case Access.RWE:
					ports.push({
						dir: "input",
						packed: pk,
						name: stem,
						comment: banner("external window read data in"),
					});
					ports.push({
						dir: "output",
						packed: pk,
						name: `${stem}_wdata`,
						comment: banner("external window write data"),
					});
					ports.push({
						dir: "output",
						packed: "",
						name: `${stem}_wren`,
						comment: banner("external window write enable"),
					});
					ports.push({
						dir: "output",
						packed: packedRange(
							Math.floor((lf.bit_offset + f.width - 1) / 8) -
								Math.floor(lf.bit_offset / 8) +
								1,
						),
						name: `${stem}_wstrb`,
						comment: banner(
							"external window write byte strobes (wren-qualified)",
						),
					});
					ports.push({
						dir: "output",
						packed: "",
						name: `${stem}_rden`,
						comment: banner("external window read enable"),
					});
					ports.push({
						dir: "output",
						packed: "",
						name: `${stem}_rst`,
						comment: banner("external window reset"),
					});
					if (def.read_write_block) {
						ports.push({
							dir: "input",
							packed: "",
							name: `${stem}_ready`,
							comment: banner("external window ready (may stall ACK)"),
						});
					}
					break;
				default:
					break;
			}
			if (c.shadow && !seenShadowSel.has(c.shadow)) {
				seenShadowSel.add(c.shadow);
				const s = shadowByName(shadows, c.shadow);
				const w = Math.max(1, Math.ceil(Math.log2(s.copies)));
				const selComment = `Shadow bank select: ${c.shadow} (${s.copies} copies, TGA ${s.tag_bits})`;
				let comment = selComment;
				if (!sidebandBanner) {
					sidebandBanner = true;
					comment = `Field / shadow sidebands\n${selComment}`;
				}
				ports.push({
					dir: "output",
					packed: packedRange(w),
					name: `o_${c.shadow}_sel`,
					comment,
				});
			}
		}
	}
	return ports;
}

function remapLogic(s: RegShadow, fromExpr: string): string {
	const w = Math.max(1, Math.ceil(Math.log2(s.copies)));
	if (!s.remaps || Object.keys(s.remaps).length === 0) {
		return `${w}'d0 | (${fromExpr})`;
	}
	const lines = [`\t\tunique case (${fromExpr})`];
	for (const [k, mask] of Object.entries(s.remaps)) {
		lines.push(`\t\t\t${w}'d${k}: mask_${s.name} = ${s.copies}'h${hex(mask)};`);
	}
	lines.push(`\t\tdefault: mask_${s.name} = ${s.copies}'h0; // miss → nop`);
	lines.push("\t\tendcase");
	return lines.join("\n");
}

/** Generate SV module text (ports + signal decls always column-aligned). */
export function emitRegfileSv(laid: LaidRegfile): string {
	const { def, cells, shadows } = laid;
	const mod = `${def.name.toLowerCase()}_regfile`;
	const ports = collectPorts(laid);
	const aw = def.addr_width;
	const wb = (stem: string) => wbPortName(def.name, stem);
	const i_wb_cyc = wb("i_wb_cyc");
	const i_wb_stb = wb("i_wb_stb");
	const i_wb_we = wb("i_wb_we");
	const i_wb_adr = wb("i_wb_adr");
	const i_wb_dat = wb("i_wb_dat");
	const i_wb_sel = wb("i_wb_sel");
	const i_wb_tga = wb("i_wb_tga");
	const o_wb_ack = wb("o_wb_ack");
	const o_wb_dat = wb("o_wb_dat");

	const sigs: SigDecl[] = [
		{ packed: "", name: "hit" },
		{ packed: "", name: "wr_fire" },
		{ packed: "", name: "rd_fire" },
	];

	for (const c of cells) {
		sigs.push({ packed: "", name: `addr_hit_${hex(c.byte_offset)}` });
		sigs.push({ packed: "", name: `wr_sel_${hex(c.byte_offset)}` });
		sigs.push({ packed: "", name: `rd_sel_${hex(c.byte_offset)}` });
	}

	for (const s of shadows) {
		const { hi, lo } = parseTag(s.tag_bits);
		const iw = hi - lo + 1;
		sigs.push({ packed: packedRange(iw), name: `raw_${s.name}` });
		sigs.push({ packed: packedRange(s.copies), name: `mask_${s.name}` });
	}

	for (const c of cells) {
		const sh = c.shadow ? shadowByName(shadows, c.shadow) : undefined;
		for (const lf of c.fields) {
			collectFieldStorageSigs(sigs, lf, sh);
		}
	}

	sigs.push({ packed: "[31:0]", name: "rd_data" });

	type RweStall = { stem: string; byte_offset: number };
	const rweStalls: RweStall[] = [];
	if (def.read_write_block) {
		for (const c of cells) {
			for (const lf of c.fields) {
				if (lf.field.access === Access.RWE) {
					rweStalls.push({
						stem: sidebandStem(lf.field),
						byte_offset: c.byte_offset,
					});
				}
			}
		}
	}
	for (const s of rweStalls) {
		sigs.push({ packed: "", name: `rwe_stall_${s.stem}` });
	}
	if (rweStalls.length > 1) {
		sigs.push({ packed: "", name: "rwe_stall" });
	}

	const commentPads = fieldCommentPads(cells, aw);

	const out: string[] = [];
	out.push(
		`// Generated by autowire plugin wishbone-regfile (table ${def.name}). Do not edit.`,
		"//",
		"//------------------------------------------------------------------------------",
		`//  Module: ${mod}`,
		`//  Desc:   ${def.desc}`,
		`//  Addr width: ${aw}`,
		`//  Cells: ${cells.length}`,
		`//  read_write_block: ${def.read_write_block}`,
		"//------------------------------------------------------------------------------",
		"//  Address map:",
	);
	for (const c of cells) {
		const sh = c.shadow ? `  shadow=${c.shadow}` : "";
		out.push(
			`//    0x${hex(c.byte_offset, aw)}  ${c.name.padEnd(commentPads.cellName)} — ${c.desc}${sh}`,
		);
	}
	out.push(
		"//------------------------------------------------------------------------------",
		"",
		`module ${mod} (`,
	);
	const portLines = formatPortLines(ports);
	for (const [i, line] of portLines.entries()) {
		const isComment = line.trimStart().startsWith("//");
		if (isComment) {
			out.push(line);
			continue;
		}
		const lastPort = portLines
			.slice(i + 1)
			.every((l) => l.trimStart().startsWith("//"));
		out.push(`${line}${lastPort ? "" : ","}`);
	}
	out.push(");");
	out.push(...section("1. Internal declarations"));
	out.push(...formatSigLines(sigs));

	out.push(...section("2. Address decode / hit / wr_sel / rd_sel"));
	for (const c of cells) {
		const word = c.byte_offset >>> 2;
		out.push(...fieldMapComment(c, commentPads));
		out.push(
			`\tassign addr_hit_${hex(c.byte_offset)} = (${i_wb_adr}[${aw - 1}:2] == ${aw - 2}'d${word});`,
		);
	}

	out.push(
		"",
		"\tassign hit = |{",
		cells.map((c) => `\t\taddr_hit_${hex(c.byte_offset)}`).join(",\n"),
		"\t};",
		`\tassign wr_fire = ${i_wb_cyc} && ${i_wb_stb} &&  ${i_wb_we};`,
		`\tassign rd_fire = ${i_wb_cyc} && ${i_wb_stb} && ~${i_wb_we};`,
		"",
	);

	for (const c of cells) {
		out.push(
			`\tassign wr_sel_${hex(c.byte_offset)} = wr_fire && addr_hit_${hex(c.byte_offset)};`,
			`\tassign rd_sel_${hex(c.byte_offset)} = rd_fire && addr_hit_${hex(c.byte_offset)};`,
		);
	}

	if (shadows.length > 0) {
		out.push(...section("3. Shadow tag decode (TGA → one-hot mask / bin sel)"));
	}

	for (const s of shadows) {
		const { hi, lo } = parseTag(s.tag_bits);
		const mw = s.copies;
		const hasRemaps =
			Boolean(s.remaps) && Object.keys(s.remaps ?? {}).length > 0;
		// Power-of-two copies + no remaps: every raw tag hits exactly one copy.
		const missReachable = hasRemaps || (mw & (mw - 1)) !== 0;
		out.push(`\tassign raw_${s.name} = ${i_wb_tga}${bitRange(hi, lo)};`);
		out.push("\talways_comb begin");
		out.push(`\t\tmask_${s.name} = ${mw}'h0;`);
		if (!hasRemaps) {
			const shift = `mask_${s.name} = ${mw}'d1 << raw_${s.name};`;
			out.push(
				missReachable
					? `\t\tif (raw_${s.name} < ${mw}) ${shift}`
					: `\t\t${shift}`,
			);
		} else {
			out.push(remapLogic(s, `raw_${s.name}`));
		}
		out.push("\tend");
		const sw = Math.max(1, Math.ceil(Math.log2(s.copies)));
		out.push(
			missReachable
				? "\t// one-hot mask → bin index (lowest set bit wins); miss keeps 0"
				: "\t// one-hot mask → bin index (lowest set bit wins)",
			"\talways_comb begin",
			`\t\to_${s.name}_sel = ${sw}'d0;`,
			`\t\tfor (int __i = ${mw - 1}; __i >= 0; __i--) begin`,
			`\t\t\tif (mask_${s.name}[__i]) o_${s.name}_sel = ${sw}'(__i);`,
			"\t\tend",
			"\tend",
			"",
		);
	}

	out.push(...section("4. Field storage / sideband glue"));
	for (const c of cells) {
		out.push(...fieldMapComment(c, commentPads));
		const sh = c.shadow ? shadowByName(shadows, c.shadow) : undefined;
		emitCellStorage(
			out,
			c,
			sh,
			def.read_write_block,
			commentPads,
			i_wb_dat,
			i_wb_sel,
		);
		out.push("");
	}

	out.push(...section(`5. Read mux → ${o_wb_dat} / ACK`));
	out.push("\talways_comb begin");
	out.push("\t\trd_data = 32'h0;");
	out.push("\t\tunique case (1'b1)");
	for (const c of cells) {
		out.push(`\t\t\t// ${c.name} @ 0x${hex(c.byte_offset, aw)}`);
		out.push(`\t\t\trd_sel_${hex(c.byte_offset)}: begin`);
		const sh = c.shadow ? shadowByName(shadows, c.shadow) : undefined;
		for (const lf of c.fields) {
			out.push(`\t\t\t\t// ${fieldInlineComment(lf, commentPads)}`);
			emitFieldRead(out, lf, sh);
		}
		out.push("\t\t\tend");
	}
	out.push("\t\t\tdefault: rd_data = 32'h0;");
	out.push("\t\tendcase");
	out.push("\tend");
	out.push("");

	if (rweStalls.length === 0) {
		out.push(`\tassign ${o_wb_ack} = ${i_wb_cyc} && ${i_wb_stb} && hit;`);
	} else if (rweStalls.length === 1) {
		const only = rweStalls[0];
		if (only) {
			out.push(
				`\tassign ${o_wb_ack} = ${i_wb_cyc} && ${i_wb_stb} && hit && !rwe_stall_${only.stem};`,
			);
		}
	} else {
		out.push(
			"\t// Merge per-RWE stalls (each folded next to its field sideband)",
			`\tassign rwe_stall = ${rweStalls.map((s) => `rwe_stall_${s.stem}`).join(" | ")};`,
			`\tassign ${o_wb_ack} = ${i_wb_cyc} && ${i_wb_stb} && hit && !rwe_stall;`,
		);
	}
	out.push(`\tassign ${o_wb_dat} = rd_data;`);
	out.push("");
	out.push("endmodule");
	out.push("");
	return out.join("\n");
}

function collectFieldStorageSigs(
	sigs: SigDecl[],
	lf: LaidField,
	sh: RegShadow | undefined,
): void {
	const f = lf.field;
	if (
		f.access === Access.RC ||
		f.access === Access.RO ||
		f.access === Access.RWE ||
		f.access === Access.W1P
	) {
		return;
	}
	const stem = sidebandStem(f);
	if (
		sh &&
		(f.access === Access.RW ||
			f.access === Access.RWW ||
			f.access === Access.W1C)
	) {
		sigs.push({
			packed: packedRange(f.width),
			name: `${stem}_q`,
			unpacked: `[${sh.copies}]`,
		});
		return;
	}
	if (
		f.access === Access.RW ||
		f.access === Access.RWW ||
		f.access === Access.W1C
	) {
		sigs.push({ packed: packedRange(f.width), name: `${stem}_q` });
	}
}

type LaneChunk = {
	lane: number;
	fHi: number;
	fLo: number;
	gHi: number;
	gLo: number;
};

/** Field chunks per byte lane: field-relative [fHi:fLo] ↔ cell bits [gHi:gLo]. */
function fieldLaneChunks(hi: number, lo: number): LaneChunk[] {
	const chunks: LaneChunk[] = [];
	let pos = lo;
	while (pos <= hi) {
		const lane = Math.floor(pos / 8);
		const top = Math.min(hi, lane * 8 + 7);
		chunks.push({ lane, fHi: top - lo, fLo: pos - lo, gHi: top, gLo: pos });
		pos = top + 1;
	}
	return chunks;
}

/** Field-relative bit select for a chunk; empty when it spans the field. */
function chunkSel(ch: LaneChunk, width: number): string {
	if (ch.fLo === 0 && ch.fHi === width - 1) return "";
	return ch.fHi === ch.fLo ? `[${ch.fLo}]` : `[${ch.fHi}:${ch.fLo}]`;
}

/**
 * One storage DFF block per cell (master regbit_block style):
 * reset → ~wr (HW writes: RWW strb / W1C set) → wr (per-byte-lane SEL blocks).
 * A W1C HW set remains eligible when a SW write omits its byte lane.
 * Assign columns are aligned per branch.
 */
function emitCellStorage(
	out: string[],
	c: LaidCell,
	sh: RegShadow | undefined,
	read_write_block: boolean,
	pads: FieldCommentPads,
	i_wb_dat: string,
	i_wb_sel: string,
): void {
	const wr = `wr_sel_${hex(c.byte_offset)}`;
	const rd = `rd_sel_${hex(c.byte_offset)}`;
	const muxed = Boolean(sh?.inner_shadow_mux);
	const ncopy = sh ? sh.copies : 1;
	const sw = Math.max(1, Math.ceil(Math.log2(ncopy)));

	// Non-DFF sideband glue first (RWE window assigns, W1P pulse registers).
	for (const lf of c.fields) {
		const f = lf.field;
		const hi = lf.bit_offset + f.width - 1;
		const lo = lf.bit_offset;
		if (f.access !== Access.RWE && f.access !== Access.W1P) continue;
		const stem = sidebandStem(f);
		out.push(`\t// ${fieldInlineComment(lf, pads)}`);
		if (f.access === Access.RWE) {
			const sLo = Math.floor(lo / 8);
			const sHi = Math.floor(hi / 8);
			const nl = sHi - sLo + 1;
			const selBits =
				sHi === sLo ? `${i_wb_sel}[${sLo}]` : `${i_wb_sel}[${sHi}:${sLo}]`;
			out.push(`\tassign ${stem}_wdata = ${i_wb_dat}${bitRange(hi, lo)};`);
			out.push(`\tassign ${stem}_wstrb = {${nl}{${wr}}} & ${selBits};`);
			out.push(`\tassign ${stem}_wren  = ${wr};`);
			out.push(`\tassign ${stem}_rden  = ${rd};`);
			out.push(`\tassign ${stem}_rst   = ~i_rst_n;`);
			if (read_write_block) {
				out.push(
					`\t// Stall ACK when this RWE window is selected and not ready`,
					`\tassign rwe_stall_${stem} = (${wr} || ${rd}) && !${stem}_ready;`,
				);
			}
			continue;
		}
		const fire = sh ? `(${wr} && |mask_${sh.name})` : wr;
		const smask = selMask(hi, lo, i_wb_sel);
		out.push("\talways_ff @(posedge i_clk or negedge i_rst_n) begin");
		out.push(`\t\tif (!i_rst_n) ${stem} <= ${f.width}'h0;`);
		out.push(
			`\t\telse ${stem} <= ${fire} ? (${i_wb_dat}${bitRange(hi, lo)} & (${smask})) : ${f.width}'h0;`,
		);
		out.push("\tend");
	}

	const dff = c.fields.filter((lf) =>
		[Access.RW, Access.RWW, Access.W1C].includes(lf.field.access),
	);
	if (dff.length === 0) return;

	const lhsBase = (lf: LaidField): string => `${sidebandStem(lf.field)}_q`;
	const lhsAt = (lf: LaidField, copy: number | null): string =>
		copy === null ? lhsBase(lf) : `${lhsBase(lf)}[${copy}]`;
	const oSel = sh ? `o_${sh.name}_sel` : "";

	// Guarded assign rows: [guard | null, lhs, rhs]; guards get their own line.
	type Row = { guard: string | null; lhs: string; rhs: string };
	const pushRows = (indent: string, rows: Row[]): void => {
		const pad = Math.max(...rows.map((r) => r.lhs.length));
		for (const r of rows) {
			if (r.guard !== null) out.push(`${indent}if (${r.guard}) begin`);
			out.push(
				`${indent}${r.guard !== null ? "\t" : ""}${r.lhs.padEnd(pad)} <= ${r.rhs};`,
			);
			if (r.guard !== null) out.push(`${indent}end`);
		}
	};

	// --- reset rows ---
	const resets: Row[] = [];
	for (const lf of dff) {
		const f = lf.field;
		for (let i = 0; i < (sh ? ncopy : 1); i++) {
			resets.push({
				guard: null,
				lhs: lhsAt(lf, sh ? i : null),
				rhs: `${f.width}'h${hex(resetVal(f.reset, i))}`,
			});
		}
	}

	// --- HW branch rows (~wr): RWW strb / W1C set ---
	const hw: Row[] = [];
	for (const lf of dff) {
		const f = lf.field;
		const stem = sidebandStem(f);
		if (f.access === Access.RWW) {
			if (sh && !muxed) {
				for (let i = 0; i < ncopy; i++) {
					hw.push({
						guard: `${stem}_strb[${i}]`,
						lhs: lhsAt(lf, i),
						rhs: `${stem}_hwdata[${i}]`,
					});
				}
			} else {
				hw.push({
					guard: `${stem}_strb`,
					lhs: sh ? `${lhsBase(lf)}[${oSel}]` : lhsAt(lf, null),
					rhs: `${stem}_hwdata`,
				});
			}
		}
		if (f.access === Access.W1C) {
			if (sh && !muxed) {
				for (let i = 0; i < ncopy; i++) {
					hw.push({
						guard: `|${stem}_set[${i}]`,
						lhs: lhsAt(lf, i),
						rhs: `${lhsAt(lf, i)} | ${stem}_set[${i}]`,
					});
				}
			} else {
				const lhs = sh ? `${lhsBase(lf)}[${oSel}]` : lhsAt(lf, null);
				hw.push({
					guard: `|${stem}_set`,
					lhs,
					rhs: `${lhs} | ${stem}_set`,
				});
			}
		}
	}

	// --- SW branch: per-byte-lane blocks ---
	const lanes: { lane: number; rows: Row[]; w1cFallbackRows: Row[] }[] = [];
	for (let k = 0; k < 4; k++) {
		const rows: Row[] = [];
		const w1cFallbackRows: Row[] = [];
		for (const lf of dff) {
			const f = lf.field;
			const stem = sidebandStem(f);
			const hi = lf.bit_offset + f.width - 1;
			for (const ch of fieldLaneChunks(hi, lf.bit_offset)) {
				if (ch.lane !== k) continue;
				const sel = chunkSel(ch, f.width);
				const dat = `${i_wb_dat}${bitRange(ch.gHi, ch.gLo)}`;
				const w = ch.fHi - ch.fLo + 1;
				if (f.access === Access.W1C) {
					const w1cSetExpr = (copy: number | null): string =>
						copy === null
							? `${stem}_set${sel}`
							: muxed
								? `((o_${sh?.name ?? ""}_sel == ${sw}'d${copy}) ? ${stem}_set${sel} : ${w}'h0)`
								: `${stem}_set[${copy}]${sel}`;
					const w1c = (copy: number | null): Row => {
						const lhs = `${lhsAt(lf, copy)}${sel}`;
						const setExpr = w1cSetExpr(copy);
						return {
							guard: sh ? `mask_${sh?.name ?? ""}[${copy ?? 0}]` : null,
							lhs,
							rhs: `(${lhs} & ~${dat}) | ${setExpr}`,
						};
					};
					const w1cFallback = (copy: number | null): Row => {
						const lhs = `${lhsAt(lf, copy)}${sel}`;
						const setExpr = w1cSetExpr(copy);
						const hasSet = `|(${setExpr})`;
						return {
							guard: sh
								? `mask_${sh?.name ?? ""}[${copy ?? 0}] && ${hasSet}`
								: hasSet,
							lhs,
							rhs: `${lhs} | ${setExpr}`,
						};
					};
					for (let i = 0; i < (sh ? ncopy : 1); i++) {
						rows.push(w1c(sh ? i : null));
						w1cFallbackRows.push(w1cFallback(sh ? i : null));
					}
				} else {
					const rw = (copy: number | null): Row => ({
						guard: sh ? `mask_${sh?.name ?? ""}[${copy ?? 0}]` : null,
						lhs: `${lhsAt(lf, copy)}${sel}`,
						rhs: dat,
					});
					for (let i = 0; i < (sh ? ncopy : 1); i++) {
						rows.push(rw(sh ? i : null));
					}
				}
			}
		}
		if (rows.length > 0) lanes.push({ lane: k, rows, w1cFallbackRows });
	}

	out.push("\talways_ff @(posedge i_clk or negedge i_rst_n) begin");
	out.push("\t\tif (!i_rst_n) begin");
	pushRows("\t\t\t", resets);
	if (hw.length > 0) {
		out.push(`\t\tend else if (~${wr}) begin`);
		pushRows("\t\t\t", hw);
	}
	out.push(`\t\tend else if (${wr}) begin`);
	for (const { lane, rows, w1cFallbackRows } of lanes) {
		out.push(`\t\t\tif (${i_wb_sel}[${lane}]) begin`);
		pushRows("\t\t\t\t", rows);
		if (w1cFallbackRows.length > 0) {
			out.push("\t\t\tend else begin");
			pushRows("\t\t\t\t", w1cFallbackRows);
		}
		out.push("\t\t\tend");
	}
	out.push("\t\tend");
	out.push("\tend");

	// Sideband read-back assigns.
	for (const lf of dff) {
		const stem = sidebandStem(lf.field);
		out.push(
			muxed
				? `\tassign ${stem} = ${stem}_q[${oSel}];`
				: `\tassign ${stem} = ${stem}_q;`,
		);
	}
}

function emitFieldRead(
	out: string[],
	lf: LaidField,
	sh: RegShadow | undefined,
): void {
	const f = lf.field;
	const hi = lf.bit_offset + f.width - 1;
	const lo = lf.bit_offset;
	if (f.access === Access.RC) {
		out.push(
			`\t\t\t\trd_data${bitRange(hi, lo)} = ${f.width}'h${hex(resetVal(f.reset, 0))};`,
		);
		return;
	}
	const stem = sidebandStem(f);
	if (f.access === Access.RO) {
		if (sh) {
			out.push(
				`\t\t\t\trd_data${bitRange(hi, lo)} = ${shadowOr(f.width, sh, (i) => `${stem}[${i}]`)};`,
			);
		} else {
			out.push(`\t\t\t\trd_data${bitRange(hi, lo)} = ${stem};`);
		}
		return;
	}
	if (f.access === Access.RWE) {
		out.push(`\t\t\t\trd_data${bitRange(hi, lo)} = ${stem};`);
		return;
	}
	if (f.access === Access.W1P) {
		out.push(`\t\t\t\trd_data${bitRange(hi, lo)} = ${f.width}'h0;`);
		return;
	}
	if (sh) {
		out.push(
			`\t\t\t\trd_data${bitRange(hi, lo)} = ${shadowOr(f.width, sh, (i) => `${stem}_q[${i}]`)};`,
		);
	} else {
		out.push(`\t\t\t\trd_data${bitRange(hi, lo)} = ${stem}_q;`);
	}
}

/** Masked per-copy OR read (master onehot-shadow style): `(mask[k] ? src[k] : '0) | …`. */
function shadowOr(
	width: number,
	sh: RegShadow,
	src: (copy: number) => string,
): string {
	return Array.from(
		{ length: sh.copies },
		(_, i) => `(mask_${sh.name}[${i}] ? ${src(i)} : ${width}'h0)`,
	).join(" | ");
}
