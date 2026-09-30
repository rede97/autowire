// aw-render snapshot → SystemVerilog printer (dump output path).
// Contract: docs/connect/html.md §4 (aw-render is the only dump SoT).
// Input is the deterministic snapshot produced by out/web/aw.js serializeSnapshot():
// <autowire> → aw-mod (name) → aw-render (params/imports/localparams/ports/signals/insts),
// with nested aw-mod after the render. All data lives on attributes.
// Pure snapshot → SV text. No node imports: the page bundle uses this too.

export interface RenderParam {
	name: string;
	value: string;
}

export interface RenderImport {
	package: string;
	symbol: string;
}

export interface RenderLocalparam {
	name: string;
	value: string;
	folded: boolean;
	forInst: string;
	forParam: string;
}

export interface RenderPort {
	name: string;
	dir: string;
	packed: string;
	unpacked: string;
	nettype: string;
	interface: string;
	modport: string;
	/** Optional comment lines printed above the port (plugin banners). */
	comment?: string;
}

export interface RenderSignal {
	name: string;
	packed: string;
	unpacked: string;
	nettype: string;
	/** Optional comment lines printed above the declaration. */
	comment?: string;
}

export interface RenderConnect {
	port: string;
	to: string;
	part: string;
	/** "open" = explicit dangling pin (prints as `.port()`); else net/const. */
	type: string;
	/** Target port direction (input / output / inout …; "" when unknown). */
	dir: string;
	/** Target port packed dims for this instance ("" when scalar / unknown). */
	portPacked: string;
	/** Target port unpacked dims for this instance ("" when none). */
	portUnpacked: string;
}

export interface RenderInst {
	id: string;
	mod: string;
	params: RenderParam[];
	connects: RenderConnect[];
}

export interface RenderModule {
	name: string;
	params: RenderParam[];
	imports: RenderImport[];
	localparams: RenderLocalparam[];
	ports: RenderPort[];
	signals: RenderSignal[];
	insts: RenderInst[];
	/** Nested submods (each becomes its own .sv module). */
	children: RenderModule[];
	/** Full custom header lines replacing the default generated-by comment. */
	header?: string[];
	/** Continuous assigns printed after the instances (plugin tie-offs). */
	assigns?: { lhs: string; rhs: string }[];
	/** aw-tb-mod: portless module + body includes + logic defaults. */
	isTb?: boolean;
	bodyPreInclude?: string[];
	bodyPostInclude?: string[];
}

// --- External input guards (same discipline as src/rtlindex.ts) ---

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

function arr(v: unknown): unknown[] {
	if (Array.isArray(v)) return v;
	return v === undefined || v === null ? [] : [v];
}

function parseParams(v: unknown): RenderParam[] {
	const out: RenderParam[] = [];
	for (const p of arr(isObj(v) ? v["aw-param"] : undefined)) {
		if (!isObj(p)) continue;
		out.push({ name: str(p["@name"]), value: str(p["@value"]) });
	}
	return out;
}

function parseMod(v: unknown, tag = "aw-mod"): RenderModule | null {
	if (!isObj(v)) return null;
	const render = isObj(v["aw-render"]) ? v["aw-render"] : {};
	const ports: RenderPort[] = [];
	const portsEl = isObj(render["aw-ports"]) ? render["aw-ports"] : undefined;
	for (const p of arr(portsEl?.["aw-port"])) {
		if (!isObj(p)) continue;
		ports.push({
			name: str(p["@name"]),
			dir: str(p["@dir"]) || "input",
			packed: str(p["@packed"]),
			unpacked: str(p["@unpacked"]),
			nettype: str(p["@nettype"]),
			interface: str(p["@interface"]),
			modport: str(p["@modport"]),
		});
	}
	const signals: RenderSignal[] = [];
	const sigEl = isObj(render["aw-signals"]) ? render["aw-signals"] : undefined;
	for (const s of arr(sigEl?.["aw-signal"])) {
		if (!isObj(s)) continue;
		signals.push({
			name: str(s["@name"]),
			packed: str(s["@packed"]),
			unpacked: str(s["@unpacked"]),
			nettype: str(s["@nettype"]),
		});
	}
	const imports: RenderImport[] = [];
	const impEl = isObj(render["aw-imports"]) ? render["aw-imports"] : undefined;
	for (const i of arr(impEl?.["aw-import"])) {
		if (!isObj(i)) continue;
		imports.push({
			package: str(i["@package"]),
			symbol: str(i["@symbol"]) || "*",
		});
	}
	const localparams: RenderLocalparam[] = [];
	const lpEl = isObj(render["aw-localparams"])
		? render["aw-localparams"]
		: undefined;
	for (const lp of arr(lpEl?.["aw-localparam"])) {
		if (!isObj(lp)) continue;
		localparams.push({
			name: str(lp["@name"]),
			value: str(lp["@value"]),
			folded: str(lp["@folded"]) === "true",
			forInst: str(lp["@for-inst"]),
			forParam: str(lp["@for-param"]),
		});
	}
	const insts: RenderInst[] = [];
	const instEl = isObj(render["aw-insts"]) ? render["aw-insts"] : undefined;
	for (const inst of arr(instEl?.["aw-inst"])) {
		if (!isObj(inst)) continue;
		const connects: RenderConnect[] = [];
		for (const c of arr(inst["aw-connect"])) {
			if (!isObj(c)) continue;
			connects.push({
				port: str(c["@port"]),
				to: str(c["@to"]),
				part: str(c["@part"]),
				type: str(c["@type"]),
				dir: str(c["@dir"]),
				portPacked: str(c["@port-packed"]),
				portUnpacked: str(c["@port-unpacked"]),
			});
		}
		insts.push({
			id: str(inst["@id"]),
			mod: str(inst["@mod"]),
			params: parseParams(inst),
			connects,
		});
	}
	const children: RenderModule[] = [];
	for (const sm of arr(v["aw-mod"])) {
		const parsed = parseMod(sm, "aw-mod");
		if (parsed) children.push(parsed);
	}
	return {
		name: str(v["@name"]),
		params: parseParams(render["aw-params"]),
		imports,
		localparams,
		ports,
		signals,
		insts,
		children,
		isTb: tag === "aw-tb-mod" || str(render["@tb"]) === "1",
		bodyPreInclude: splitInc(
			str(v["@body-pre-include"]) || str(render["@body-pre-include"]),
		),
		bodyPostInclude: splitInc(
			str(v["@body-post-include"]) || str(render["@body-post-include"]),
		),
	};
}

function splitInc(s: string): string[] {
	return s.split(/\s+/).filter(Boolean);
}

/** DOM element → Bun.XML object shape (children grouped by tag, `@attr`).
 *  localName stays lowercase even in HTML-mode parsers (some light browsers
 *  wrap text/xml into an HTML skeleton and uppercase tagName). */
function domToObj(el: Element): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const attr of el.attributes) out[`@${attr.name}`] = attr.value;
	for (const child of el.children) {
		const v = domToObj(child);
		const prev = out[child.localName];
		if (prev === undefined) out[child.localName] = v;
		else if (Array.isArray(prev)) prev.push(v);
		else out[child.localName] = [prev, v];
	}
	return out;
}

/** Parse a snapshot string (or snapshot file) into render modules.
 *  Bun.XML on the CLI; DOMParser in the page bundle (no Bun global there). */
export function parseSnapshot(text: string): RenderModule[] {
	let doc: Record<string, unknown>;
	if (typeof Bun !== "undefined") {
		doc = Bun.XML.parse(text) as Record<string, unknown>;
	} else {
		// querySelector, not documentElement: the root may be wrapped.
		const rootEl = new DOMParser()
			.parseFromString(text, "text/xml")
			.querySelector("autowire");
		doc = rootEl ? { autowire: domToObj(rootEl) } : {};
	}
	const root = isObj(doc) ? doc.autowire : undefined;
	if (!isObj(root)) throw new Error("snapshot: missing <autowire> root");
	const mods: RenderModule[] = [];
	for (const m of arr(root["aw-mod"])) {
		const parsed = parseMod(m, "aw-mod");
		if (parsed) mods.push(parsed);
	}
	for (const m of arr(root["aw-tb-mod"])) {
		const parsed = parseMod(m, "aw-tb-mod");
		if (parsed) mods.push(parsed);
	}
	return mods;
}

/** Dump gate: a render is printable only when frozen-clean (no leftover
 *  template/rewrite — those belong to the author face). */
export function assertPrintable(text: string): void {
	if (/<aw-template[\s>]/.test(text) || /<aw-rewrite[\s>]/.test(text)) {
		throw new Error(
			"dump gate: snapshot still contains aw-template / aw-rewrite (unclean render)",
		);
	}
	if (!/<aw-render[\s>]/.test(text)) {
		throw new Error("dump gate: snapshot has no aw-render (render first)");
	}
}

/** Recursively collect every module in the snapshot (top + nested submods). */
export function flattenModules(mods: RenderModule[]): RenderModule[] {
	const out: RenderModule[] = [];
	for (const m of mods) {
		out.push(m);
		out.push(...flattenModules(m.children));
	}
	return out;
}

/** Normalize a packed attribute to SV text: "15:0" → "[15:0]"; "[7:0][3:0]" stays. */
function packedSv(packed: string): string {
	if (!packed) return "";
	return packed.startsWith("[") ? packed : `[${packed}]`;
}

function signalDecl(
	nettype: string,
	packed: string,
	unpacked: string,
	name: string,
): string {
	const t = nettype === "logic" ? "logic" : "wire";
	const pd = packedSv(packed);
	const ud = unpacked
		? ` ${unpacked.startsWith("[") ? unpacked : `[${unpacked}]`}`
		: "";
	return `${t}${pd ? ` ${pd}` : ""} ${name}${ud};`;
}

/** Dump print options (workspace [style] table). */
export interface PrintStyle {
	/** Align module declaration port columns (dir / type / packed). */
	portAlign?: boolean;
	/** Align module declaration parameter names (= column). */
	paramAlign?: boolean;
	/** Pad instantiation port names and connections so every ( and ) of the
	 *  file's port maps share one column (file-wide, not per instance). */
	instPortAlign?: boolean;
	/** Pad instantiation parameter names and values so every ( and ) of the
	 *  file's parameter overrides share one column; with instPortAlign too,
	 *  ports and params share the same columns. */
	instParamAlign?: boolean;
	/** Append a `// <dir>` comment to each instance port-map row. */
	instPortDir?: boolean;
	/** Direction comment text: full (input/output/inout) or short (i/o/io). */
	instPortDirFormat?: "full" | "short";
	/** Append the target port's dims to the port-map comment, after the
	 *  direction: packed ([31:0], [3:0][7:0]) then `;` + unpacked
	 *  ([7:0];[0:15]); scalar / 1-bit ports show none. */
	instPortWidth?: boolean;
	/** Align internal signal declaration columns (nettype / packed). */
	signalAlign?: boolean;
}

/** Print one render module as a SystemVerilog source text. */
export function printSv(
	m: RenderModule,
	unitId: string,
	style: PrintStyle = {},
): string {
	const lines: string[] = [];
	const sot = m.isTb ? "sim HTML" : "connect HTML";
	if (m.header) lines.push(...m.header);
	else
		lines.push(
			`// Generated by autowire dump (unit "${unitId}"). Do not edit: SoT is the ${sot}.`,
		);
	if (m.isTb) {
		// TB top: module name; — no ports / param ports.
		if (m.params.length > 0) {
			const paramNamePad = style.paramAlign
				? Math.max(...m.params.map((p) => p.name.length), 0)
				: 0;
			lines.push(`module ${m.name} #(`);
			for (const [i, p] of m.params.entries()) {
				const nm = paramNamePad ? p.name.padEnd(paramNamePad) : p.name;
				lines.push(
					`\tparameter ${nm} = ${p.value}${i < m.params.length - 1 ? "," : ""}`,
				);
			}
			lines.push(");");
		} else {
			lines.push(`module ${m.name};`);
		}
		for (const inc of m.bodyPreInclude ?? []) lines.push(`\`include "${inc}"`);
		for (const imp of m.imports)
			lines.push(`\timport ${imp.package}::${imp.symbol};`);
		if (m.imports.length > 0) lines.push("");
		for (const lp of m.localparams)
			lines.push(`\tlocalparam ${lp.name} = ${lp.value};`);
		if (m.localparams.length > 0) lines.push("");
		const sigDecls = m.signals;
		const sigTypePad = style.signalAlign && sigDecls.length > 0 ? 5 : 0;
		const sigPackPad = style.signalAlign
			? Math.max(...sigDecls.map((s) => packedSv(s.packed).length), 0)
			: 0;
		for (const s of sigDecls) {
			const nt = s.nettype === "wire" ? "wire" : "logic";
			if (!style.signalAlign) {
				lines.push(`\t${signalDecl(nt, s.packed, s.unpacked, s.name)}`);
				continue;
			}
			const pd = packedSv(s.packed);
			const ud = s.unpacked
				? ` ${s.unpacked.startsWith("[") ? s.unpacked : `[${s.unpacked}]`}`
				: "";
			const packCol = sigPackPad > 0 ? ` ${pd.padEnd(sigPackPad)}` : "";
			lines.push(`\t${nt.padEnd(sigTypePad)}${packCol} ${s.name}${ud};`);
		}
		if (sigDecls.length > 0) lines.push("");
		lines.push(...printInsts(m, style));
		for (const inc of m.bodyPostInclude ?? []) lines.push(`\`include "${inc}"`);
		lines.push("endmodule");
		lines.push("");
		return lines.join("\n");
	}
	// Declaration parameter list: optionally align the `=` column.
	const paramNamePad = style.paramAlign
		? Math.max(...m.params.map((p) => p.name.length), 0)
		: 0;
	const params = m.params.map(
		(p) =>
			`parameter ${paramNamePad ? p.name.padEnd(paramNamePad) : p.name} = ${p.value}`,
	);
	// Declaration port list: optionally align dir / type / packed columns so
	// signal names are left-aligned. Interface ports keep their own form.
	const plainPorts = m.ports.filter((p) => p.dir !== "interface");
	const dirPad = style.portAlign
		? Math.max(...plainPorts.map((p) => p.dir.length), 0)
		: 0;
	const typePad = style.portAlign && plainPorts.length > 0 ? 5 : 0; // "logic"
	const packPad = style.portAlign
		? Math.max(...plainPorts.map((p) => packedSv(p.packed).length), 0)
		: 0;
	const portText = m.ports.map((p) => {
		if (p.dir === "interface") {
			const mp = p.modport ? `.${p.modport}` : "";
			return `${p.interface}${mp} ${p.name}`;
		}
		// Ports always carry a type keyword (logic / wire; interface above).
		const t = p.nettype === "logic" ? "logic" : "wire";
		const pd = packedSv(p.packed);
		const ud = p.unpacked
			? ` ${p.unpacked.startsWith("[") ? p.unpacked : `[${p.unpacked}]`}`
			: "";
		if (!style.portAlign)
			return `${p.dir} ${t}${pd ? ` ${pd}` : ""} ${p.name}${ud}`;
		const packCol = packPad > 0 ? ` ${pd.padEnd(packPad)}` : "";
		return `${p.dir.padEnd(dirPad)} ${t.padEnd(typePad)}${packCol} ${p.name}${ud}`;
	});
	const header =
		params.length > 0 ? `module ${m.name} #(` : `module ${m.name} (`;
	lines.push(header);
	const paramLines = params.map(
		(p, i) => `\t${p}${i < params.length - 1 ? "," : ""}`,
	);
	lines.push(...paramLines);
	if (params.length > 0) lines.push(") (");
	for (const [i, text] of portText.entries()) {
		const comment = m.ports[i]?.comment;
		if (comment) for (const c of comment.split("\n")) lines.push(`\t// ${c}`);
		lines.push(`\t${text}${i < portText.length - 1 ? "," : ""}`);
	}
	lines.push(");");
	for (const imp of m.imports)
		lines.push(`\timport ${imp.package}::${imp.symbol};`);
	if (m.imports.length > 0) lines.push("");
	for (const lp of m.localparams)
		lines.push(`\tlocalparam ${lp.name} = ${lp.value};`);
	if (m.localparams.length > 0) lines.push("");
	const portNames = new Set(m.ports.map((p) => p.name));
	// Internal signal declarations: optionally align nettype / packed columns.
	const sigDecls = m.signals.filter((s) => !portNames.has(s.name));
	const sigTypePad = style.signalAlign && sigDecls.length > 0 ? 5 : 0;
	const sigPackPad = style.signalAlign
		? Math.max(...sigDecls.map((s) => packedSv(s.packed).length), 0)
		: 0;
	let printedSignals = 0;
	for (const s of sigDecls) {
		// A net exported as a port is declared by the port itself.
		printedSignals++;
		if (s.comment)
			for (const c of s.comment.split("\n")) lines.push(`\t// ${c}`);
		if (!style.signalAlign) {
			lines.push(`\t${signalDecl(s.nettype, s.packed, s.unpacked, s.name)}`);
			continue;
		}
		const t = s.nettype === "logic" ? "logic" : "wire";
		const pd = packedSv(s.packed);
		const ud = s.unpacked
			? ` ${s.unpacked.startsWith("[") ? s.unpacked : `[${s.unpacked}]`}`
			: "";
		const packCol = sigPackPad > 0 ? ` ${pd.padEnd(sigPackPad)}` : "";
		lines.push(`\t${t.padEnd(sigTypePad)}${packCol} ${s.name}${ud};`);
	}
	if (printedSignals > 0) lines.push("");
	lines.push(...printInsts(m, style));
	for (const a of m.assigns ?? []) lines.push(`\tassign ${a.lhs} = ${a.rhs};`);
	lines.push("endmodule");
	lines.push("");
	return lines.join("\n");
}

/** Instantiation blocks of one module (= one .sv file).
 *  inst_port_align / inst_param_align pad port-map / parameter-override rows
 *  to file-wide columns, so every `(` and `)` lines up across instances, not
 *  just within one. With both on, ports and params share the same columns
 *  (the longest name and the longest value over all aligned rows).
 *  Constant tie-offs (docs/connect/to-rules.md): a connect whose `to` is a
 *  plain identifier names a net, UNLESS it matches a module param/localparam
 *  (constant reference); anything else is inlined as a constant expression.
 *  Part-selects exist only on nets (engine-enforced). */
function printInsts(m: RenderModule, style: PrintStyle): string[] {
	const constNames = new Set([
		...m.params.map((p) => p.name),
		...m.localparams.map((l) => l.name),
	]);
	const rows = m.insts.map((inst) =>
		inst.connects.map((c) => ({
			port: c.port,
			rhs: connectRhs(c, constNames),
			dir: style.instPortDir ? dirMark(c.dir, style.instPortDirFormat) : "",
			width: style.instPortWidth ? widthMark(c.portPacked, c.portUnpacked) : "",
		})),
	);
	// With widths shown, pad directions file-wide so the width column aligns.
	// rows.flat() once; Math.max over a loop (spread on a huge array can hit
	// the argument-count limit).
	const flatRows = rows.flat();
	let dirPad = 0;
	for (const r of flatRows)
		if (r.width) dirPad = Math.max(dirPad, r.dir.length);
	const aligned = [
		...(style.instPortAlign
			? flatRows.map((r) => ({ name: r.port, value: r.rhs }))
			: []),
		...(style.instParamAlign
			? m.insts.flatMap((inst) =>
					inst.params.map((p) => ({ name: p.name, value: p.value })),
				)
			: []),
	];
	let namePad = 0;
	let valuePad = 0;
	for (const c of aligned) {
		namePad = Math.max(namePad, c.name.length);
		valuePad = Math.max(valuePad, c.value.length);
	}
	const portPad = style.instPortAlign ? namePad : 0;
	const rhsPad = style.instPortAlign ? valuePad : 0;
	const paramPad = style.instParamAlign ? namePad : 0;
	const paramValuePad = style.instParamAlign ? valuePad : 0;
	const lines: string[] = [];
	for (const [k, inst] of m.insts.entries()) {
		if (inst.params.length > 0) {
			// One parameter override per line, even a single constant.
			lines.push(`\t${inst.mod} #(`);
			for (const [i, p] of inst.params.entries()) {
				lines.push(
					`\t\t.${p.name.padEnd(paramPad)}(${p.value.padEnd(paramValuePad)})${i < inst.params.length - 1 ? "," : ""}`,
				);
			}
			lines.push(`\t) ${inst.id} (`);
		} else {
			lines.push(`\t${inst.mod} ${inst.id} (`);
		}
		const conns = rows[k] ?? [];
		for (const [i, r] of conns.entries()) {
			const last = i === conns.length - 1;
			const row = `\t\t.${r.port.padEnd(portPad)}(${r.rhs.padEnd(rhsPad)})${last ? "" : ","}`;
			const mark = r.width
				? `${r.dir ? `${r.dir.padEnd(dirPad)} ` : ""}${r.width}`
				: r.dir;
			// The last row has no comma: a space keeps its comment in column.
			lines.push(mark ? `${row}${last ? " " : ""} // ${mark}` : row);
		}
		lines.push("\t);");
	}
	if (m.insts.length > 0) lines.push("");
	return lines;
}

const DIR_MARKS: Record<"full" | "short", Record<string, string>> = {
	full: { input: "input", output: "output", inout: "inout" },
	short: { input: "i", output: "o", inout: "io" },
};

/** Width comment text: packed dims, then `;` + unpacked dims when present
 *  (the `;` marks the unpacked side, so `;[0:3]` is an array of 1-bit
 *  elements). No dims, or a lone single-bit packed range ([n:n]), is "". */
function widthMark(packed: string, unpacked: string): string {
	const p = packed ? packedSv(packed) : "";
	const bits = /^\[\s*(\d+)\s*:\s*\1\s*\]$/.test(p) ? "" : p;
	return unpacked ? `${bits};${packedSv(unpacked)}` : bits;
}

/** Direction comment text; "" for interface / unknown directions. */
function dirMark(dir: string, format: "full" | "short" = "full"): string {
	return DIR_MARKS[format][dir] ?? "";
}

function connectRhs(c: RenderConnect, constNames: Set<string>): string {
	if (c.type === "open") return "";
	if (c.type === "raw") return c.to;
	const netForm =
		/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.to) && !constNames.has(c.to);
	return netForm
		? `${c.to}${c.part ? `[${c.part.replace(/^\[|\]$/g, "")}]` : ""}`
		: c.to;
}

const SV_IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** Module names become file names: reject anything but a plain SV identifier. */
export function assertModuleNames(mods: RenderModule[]): void {
	for (const m of flattenModules(mods)) {
		if (!SV_IDENT.test(m.name)) {
			throw new Error(
				`dump gate: module name ${JSON.stringify(m.name)} is not a plain SystemVerilog identifier`,
			);
		}
	}
}
