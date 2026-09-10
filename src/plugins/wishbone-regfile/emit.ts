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

type PortDecl = {
	dir: "input" | "output";
	packed: string;
	name: string;
	/** Unpacked dimension after the name, e.g. "[4]". */
	unpacked?: string;
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
	return ports.map((p) => {
		const packCol = packPad > 0 ? ` ${p.packed.padEnd(packPad)}` : "";
		const ud = p.unpacked ? ` ${p.unpacked}` : "";
		return `\t${p.dir.padEnd(dirPad)} ${"logic".padEnd(typePad)}${packCol} ${p.name}${ud}`;
	});
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

function collectPorts(laid: LaidRegfile): PortDecl[] {
	const { def, cells, shadows, tga_width } = laid;
	const ports: PortDecl[] = [
		{ dir: "input", packed: "", name: "i_clk" },
		{ dir: "input", packed: "", name: "i_rst_n" },
		{ dir: "input", packed: "", name: "i_wb_cyc" },
		{ dir: "input", packed: "", name: "i_wb_stb" },
		{ dir: "input", packed: "", name: "i_wb_we" },
		{ dir: "input", packed: packedRange(def.addr_width), name: "i_wb_adr" },
		{ dir: "input", packed: "[31:0]", name: "i_wb_dat" },
		{ dir: "input", packed: "[3:0]", name: "i_wb_sel" },
	];
	if (tga_width > 0) {
		ports.push({
			dir: "input",
			packed: packedRange(tga_width),
			name: "i_wb_tga",
		});
	}
	ports.push(
		{ dir: "output", packed: "", name: "o_wb_ack" },
		{ dir: "output", packed: "[31:0]", name: "o_wb_dat" },
	);

	const seenShadowSel = new Set<string>();
	for (const c of cells) {
		for (const lf of c.fields) {
			const f = lf.field;
			if (f.access === Access.RC) continue;
			const stem = sidebandStem(f);
			const sh = c.shadow ? shadowByName(shadows, c.shadow) : undefined;
			const copies = sh?.inner_shadow_mux === false ? sh.copies : 1;
			const pk = packedRange(f.width);
			const arr = (name: string, dir: "input" | "output") => {
				ports.push({
					dir,
					packed: pk,
					name,
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
						});
					} else {
						arr(stem, "input");
					}
					break;
				case Access.RW:
				case Access.W1P:
				case Access.W1C:
					arr(stem, "output");
					break;
				case Access.RWW:
					arr(stem, "output");
					ports.push({
						dir: "input",
						packed: "",
						name: `${stem}_strb`,
						...(copies > 1 ? { unpacked: `[${copies}]` } : {}),
					});
					ports.push({
						dir: "input",
						packed: pk,
						name: `${stem}_hwdata`,
						...(copies > 1 ? { unpacked: `[${copies}]` } : {}),
					});
					break;
				case Access.RWE:
					ports.push({ dir: "input", packed: pk, name: stem });
					ports.push({
						dir: "output",
						packed: pk,
						name: `${stem}_wdata`,
					});
					ports.push({ dir: "output", packed: "", name: `${stem}_wren` });
					ports.push({ dir: "output", packed: "", name: `${stem}_rden` });
					ports.push({ dir: "output", packed: "", name: `${stem}_rst` });
					if (def.read_write_block) {
						ports.push({
							dir: "input",
							packed: "",
							name: `${stem}_ready`,
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
				ports.push({
					dir: "output",
					packed: packedRange(w),
					name: `o_${c.shadow}_sel`,
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

	const out: string[] = [];
	out.push(
		`// Generated by autowire plugin wishbone-regfile (table ${def.name}). Do not edit.`,
		`// ${def.desc}`,
		`module ${mod} (`,
	);
	const portLines = formatPortLines(ports);
	for (const [i, line] of portLines.entries()) {
		out.push(`${line}${i < portLines.length - 1 ? "," : ""}`);
	}
	out.push(");");
	out.push("");
	out.push(...formatSigLines(sigs));
	out.push("");

	// Per-cell address hit
	for (const c of cells) {
		const word = c.byte_offset >>> 2;
		out.push(
			`\t// Addr: 0x${hex(c.byte_offset)} RegCell: ${c.name} — ${c.desc}`,
		);
		out.push(
			`\tassign addr_hit_${hex(c.byte_offset)} = (i_wb_adr[${aw - 1}:2] == ${aw - 2}'d${word});`,
		);
	}

	out.push(
		"",
		"\tassign hit = |{",
		cells.map((c) => `\t\taddr_hit_${hex(c.byte_offset)}`).join(",\n"),
		"\t};",
		"\tassign wr_fire = i_wb_cyc && i_wb_stb &&  i_wb_we;",
		"\tassign rd_fire = i_wb_cyc && i_wb_stb && ~i_wb_we;",
		"",
	);

	for (const c of cells) {
		out.push(
			`\tassign wr_sel_${hex(c.byte_offset)} = wr_fire && hit && addr_hit_${hex(c.byte_offset)};`,
			`\tassign rd_sel_${hex(c.byte_offset)} = rd_fire && hit && addr_hit_${hex(c.byte_offset)};`,
		);
	}
	out.push("");

	// Shadow decode
	for (const s of shadows) {
		const { hi, lo } = parseTag(s.tag_bits);
		const mw = s.copies;
		out.push(`\tassign raw_${s.name} = i_wb_tga[${hi}:${lo}];`);
		out.push("\talways_comb begin");
		out.push(`\t\tmask_${s.name} = ${mw}'h0;`);
		if (!s.remaps || Object.keys(s.remaps).length === 0) {
			out.push(
				`\t\tif (raw_${s.name} < ${mw}) mask_${s.name} = ${mw}'d1 << raw_${s.name};`,
			);
		} else {
			out.push(remapLogic(s, `raw_${s.name}`));
		}
		out.push("\tend");
		const sw = Math.max(1, Math.ceil(Math.log2(s.copies)));
		out.push(
			"\t// one-hot mask → bin index (first set bit); miss keeps 0",
			"\talways_comb begin",
			`\t\to_${s.name}_sel = ${sw}'d0;`,
			`\t\tfor (int __i = 0; __i < ${mw}; __i++) begin`,
			`\t\t\tif (mask_${s.name}[__i]) o_${s.name}_sel = ${sw}'(__i);`,
			"\t\tend",
			"\tend",
			"",
		);
	}

	// Storage + sidebands
	for (const c of cells) {
		const sh = c.shadow ? shadowByName(shadows, c.shadow) : undefined;
		for (const lf of c.fields) {
			emitFieldStorage(out, c, lf, sh, def.read_write_block);
		}
	}

	// Read mux
	out.push("\talways_comb begin");
	out.push("\t\trd_data = 32'h0;");
	out.push("\t\tunique case (1'b1)");
	for (const c of cells) {
		out.push(`\t\t\trd_sel_${hex(c.byte_offset)}: begin`);
		out.push("\t\t\t\trd_data = 32'h0;");
		const sh = c.shadow ? shadowByName(shadows, c.shadow) : undefined;
		for (const lf of c.fields) {
			emitFieldRead(out, lf, sh);
		}
		out.push("\t\t\tend");
	}
	out.push("\t\t\tdefault: rd_data = 32'h0;");
	out.push("\t\tendcase");
	out.push("\tend");
	out.push("");

	const rweReady: string[] = [];
	if (def.read_write_block) {
		for (const c of cells) {
			for (const lf of c.fields) {
				if (lf.field.access === Access.RWE) {
					const stem = sidebandStem(lf.field);
					rweReady.push(
						`((wr_sel_${hex(c.byte_offset)} || rd_sel_${hex(c.byte_offset)}) && !${stem}_ready)`,
					);
				}
			}
		}
	}
	if (rweReady.length === 0) {
		out.push("\tassign o_wb_ack = i_wb_cyc && i_wb_stb && hit;");
	} else {
		out.push(
			`\tassign o_wb_ack = i_wb_cyc && i_wb_stb && hit && !(${rweReady.join(" || ")});`,
		);
	}
	out.push("\tassign o_wb_dat = rd_data;");
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

function emitFieldStorage(
	out: string[],
	c: LaidCell,
	lf: LaidField,
	sh: RegShadow | undefined,
	read_write_block: boolean,
): void {
	const f = lf.field;
	const hi = lf.bit_offset + f.width - 1;
	const lo = lf.bit_offset;
	const wr = `wr_sel_${hex(c.byte_offset)}`;
	const rd = `rd_sel_${hex(c.byte_offset)}`;

	if (f.access === Access.RC || f.access === Access.RO) {
		return;
	}
	const stem = sidebandStem(f);
	if (f.access === Access.RWE) {
		out.push(`\tassign ${stem}_wdata = i_wb_dat[${hi}:${lo}];`);
		out.push(`\tassign ${stem}_wren  = ${wr};`);
		out.push(`\tassign ${stem}_rden  = ${rd};`);
		out.push(`\tassign ${stem}_rst   = ~i_rst_n;`);
		void read_write_block;
		return;
	}
	if (f.access === Access.W1P) {
		out.push("\talways_ff @(posedge i_clk or negedge i_rst_n) begin");
		out.push(`\t\tif (!i_rst_n) ${stem} <= ${f.width}'h0;`);
		out.push(
			`\t\telse ${stem} <= ${wr} ? i_wb_dat[${hi}:${lo}] : ${f.width}'h0;`,
		);
		out.push("\tend");
		return;
	}

	const muxed = Boolean(sh?.inner_shadow_mux);
	const ncopy = sh ? sh.copies : 1;

	if (
		sh &&
		(f.access === Access.RW ||
			f.access === Access.RWW ||
			f.access === Access.W1C)
	) {
		out.push("\talways_ff @(posedge i_clk or negedge i_rst_n) begin");
		out.push("\t\tif (!i_rst_n) begin");
		for (let i = 0; i < ncopy; i++) {
			out.push(
				`\t\t\t${stem}_q[${i}] <= ${f.width}'h${hex(resetVal(f.reset, i))};`,
			);
		}
		out.push("\t\tend else begin");
		if (f.access === Access.W1C) {
			out.push(`\t\t\tif (${wr}) begin`);
			out.push(`\t\t\t\tfor (int __c = 0; __c < ${ncopy}; __c++) begin`);
			out.push(
				`\t\t\t\t\tif (mask_${sh.name}[__c]) ${stem}_q[__c] <= ${stem}_q[__c] & ~i_wb_dat[${hi}:${lo}];`,
			);
			out.push("\t\t\t\tend");
			out.push("\t\t\tend");
		} else {
			out.push(`\t\t\tif (${wr}) begin`);
			out.push(`\t\t\t\tfor (int __c = 0; __c < ${ncopy}; __c++) begin`);
			out.push(
				`\t\t\t\t\tif (mask_${sh.name}[__c]) ${stem}_q[__c] <= i_wb_dat[${hi}:${lo}];`,
			);
			out.push("\t\t\t\tend");
			out.push("\t\t\tend");
			if (f.access === Access.RWW) {
				if (muxed) {
					out.push(
						`\t\t\tif (${stem}_strb) ${stem}_q[o_${sh.name}_sel] <= ${stem}_hwdata;`,
					);
				} else {
					out.push(`\t\t\tfor (int __c = 0; __c < ${ncopy}; __c++) begin`);
					out.push(
						`\t\t\t\tif (${stem}_strb[__c]) ${stem}_q[__c] <= ${stem}_hwdata[__c];`,
					);
					out.push("\t\t\tend");
				}
			}
		}
		out.push("\t\tend");
		out.push("\tend");
		if (muxed) {
			out.push(`\tassign ${stem} = ${stem}_q[o_${sh.name}_sel];`);
		} else {
			out.push(`\tassign ${stem} = ${stem}_q;`);
		}
		return;
	}

	// Non-shadow RW / RWW / W1C
	out.push("\talways_ff @(posedge i_clk or negedge i_rst_n) begin");
	out.push(
		`\t\tif (!i_rst_n) ${stem}_q <= ${f.width}'h${hex(resetVal(f.reset, 0))};`,
	);
	if (f.access === Access.W1C) {
		out.push(
			`\t\telse if (${wr}) ${stem}_q <= ${stem}_q & ~i_wb_dat[${hi}:${lo}];`,
		);
	} else {
		out.push(`\t\telse if (${wr}) ${stem}_q <= i_wb_dat[${hi}:${lo}];`);
		if (f.access === Access.RWW) {
			out.push(`\t\telse if (${stem}_strb) ${stem}_q <= ${stem}_hwdata;`);
		}
	}
	out.push("\tend");
	out.push(`\tassign ${stem} = ${stem}_q;`);
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
			`\t\t\t\trd_data[${hi}:${lo}] = ${f.width}'h${hex(resetVal(f.reset, 0))};`,
		);
		return;
	}
	const stem = sidebandStem(f);
	if (f.access === Access.RO) {
		if (sh) {
			out.push("\t\t\t\tbegin");
			out.push(`\t\t\t\t\tlogic [${f.width - 1}:0] __ro;`);
			out.push(`\t\t\t\t\t__ro = ${f.width}'h0;`);
			out.push(`\t\t\t\t\tfor (int __c = 0; __c < ${sh.copies}; __c++) begin`);
			out.push(`\t\t\t\t\t\tif (mask_${sh.name}[__c]) __ro |= ${stem}[__c];`);
			out.push("\t\t\t\t\tend");
			out.push(`\t\t\t\t\trd_data[${hi}:${lo}] = __ro;`);
			out.push("\t\t\t\tend");
		} else {
			out.push(`\t\t\t\trd_data[${hi}:${lo}] = ${stem};`);
		}
		return;
	}
	if (f.access === Access.RWE) {
		out.push(`\t\t\t\trd_data[${hi}:${lo}] = ${stem};`);
		return;
	}
	if (f.access === Access.W1P) {
		out.push(`\t\t\t\trd_data[${hi}:${lo}] = ${f.width}'h0;`);
		return;
	}
	if (sh) {
		out.push("\t\t\t\tbegin");
		out.push(`\t\t\t\t\tlogic [${f.width - 1}:0] __v;`);
		out.push(`\t\t\t\t\t__v = ${f.width}'h0;`);
		out.push(`\t\t\t\t\tfor (int __c = 0; __c < ${sh.copies}; __c++) begin`);
		out.push(`\t\t\t\t\t\tif (mask_${sh.name}[__c]) __v |= ${stem}_q[__c];`);
		out.push("\t\t\t\t\tend");
		out.push(`\t\t\t\t\trd_data[${hi}:${lo}] = __v;`);
		out.push("\t\t\t\tend");
	} else {
		out.push(`\t\t\t\trd_data[${hi}:${lo}] = ${stem}_q;`);
	}
}
