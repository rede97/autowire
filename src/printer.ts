// aw-render snapshot → SystemVerilog printer (dump output path).
// Contract: docs/connect-html.md §4 (aw-render is the only dump SoT).
// Input is the deterministic snapshot produced by web/aw.js serializeSnapshot():
// <autowire> → aw-mod (name) → aw-render (params/imports/localparams/ports/signals/insts),
// with nested aw-mod after the render. All data lives on attributes.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
}

export interface RenderSignal {
	name: string;
	packed: string;
	unpacked: string;
	nettype: string;
}

export interface RenderConnect {
	port: string;
	to: string;
	part: string;
	/** "open" = explicit dangling pin (prints as `.port()`); else net/const. */
	type: string;
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

function parseMod(v: unknown): RenderModule | null {
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
		const parsed = parseMod(sm);
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
	};
}

/** Parse a snapshot string (or snapshot file) into render modules. */
export function parseSnapshot(text: string): RenderModule[] {
	const doc: unknown = Bun.XML.parse(text);
	const root = isObj(doc) ? doc.autowire : undefined;
	if (!isObj(root)) throw new Error("snapshot: missing <autowire> root");
	const mods: RenderModule[] = [];
	for (const m of arr(root["aw-mod"])) {
		const parsed = parseMod(m);
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

/** Print one render module as a SystemVerilog source text. */
export function printSv(m: RenderModule, unitId: string): string {
	const lines: string[] = [];
	lines.push(
		`// Generated by autowire dump (unit "${unitId}"). Do not edit: SoT is the connect HTML.`,
	);
	const params = m.params.map((p) => `parameter ${p.name} = ${p.value}`);
	const portText = m.ports.map((p) => {
		if (p.dir === "interface") {
			const mp = p.modport ? `.${p.modport}` : "";
			return `${p.interface}${mp} ${p.name}`;
		}
		const t = p.nettype === "logic" ? " logic" : "";
		const pd = packedSv(p.packed);
		const ud = p.unpacked
			? ` ${p.unpacked.startsWith("[") ? p.unpacked : `[${p.unpacked}]`}`
			: "";
		return `${p.dir}${t}${pd ? ` ${pd}` : ""} ${p.name}${ud}`;
	});
	const header =
		params.length > 0 ? `module ${m.name} #(` : `module ${m.name} (`;
	lines.push(header);
	const paramLines = params.map(
		(p, i) => `\t${p}${i < params.length - 1 ? "," : ""}`,
	);
	lines.push(...paramLines);
	if (params.length > 0) lines.push(") (");
	for (const [i, p] of portText.entries()) {
		lines.push(`\t${p}${i < portText.length - 1 ? "," : ""}`);
	}
	lines.push(");");
	for (const imp of m.imports)
		lines.push(`\timport ${imp.package}::${imp.symbol};`);
	if (m.imports.length > 0) lines.push("");
	for (const lp of m.localparams)
		lines.push(`\tlocalparam ${lp.name} = ${lp.value};`);
	if (m.localparams.length > 0) lines.push("");
	const portNames = new Set(m.ports.map((p) => p.name));
	let printedSignals = 0;
	for (const s of m.signals) {
		// A net exported as a port is declared by the port itself.
		if (portNames.has(s.name)) continue;
		printedSignals++;
		lines.push(`\t${signalDecl(s.nettype, s.packed, s.unpacked, s.name)}`);
	}
	if (printedSignals > 0) lines.push("");
	// Constant tie-offs (docs/connect-to-rules.md): a connect whose `to`
	// is a plain identifier names a net, UNLESS it matches a module
	// param/localparam (constant reference); anything else is inlined as a
	// constant expression. Part-selects exist only on nets (engine-enforced).
	const constNames = new Set([
		...m.params.map((p) => p.name),
		...m.localparams.map((l) => l.name),
	]);
	for (const inst of m.insts) {
		const ptext = inst.params.map((p) => `.${p.name}(${p.value})`);
		const head =
			ptext.length > 0
				? `\t${inst.mod} #(${ptext.join(", ")}) ${inst.id} (`
				: `\t${inst.mod} ${inst.id} (`;
		lines.push(head);
		for (const [i, c] of inst.connects.entries()) {
			const netForm =
				/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.to) && !constNames.has(c.to);
			const rhs =
				c.type === "open"
					? ""
					: netForm
						? `${c.to}${c.part ? `[${c.part.replace(/^\[|\]$/g, "")}]` : ""}`
						: c.to;
			lines.push(
				`\t\t.${c.port}(${rhs})${i < inst.connects.length - 1 ? "," : ""}`,
			);
		}
		lines.push("\t);");
	}
	if (m.insts.length > 0) lines.push("");
	lines.push("endmodule");
	lines.push("");
	return lines.join("\n");
}

/** Write a snapshot's modules as .sv files into outDir; returns written paths. */
export async function writeSvFiles(
	mods: RenderModule[],
	outDir: string,
	unitId: string,
): Promise<string[]> {
	await mkdir(outDir, { recursive: true });
	const written: string[] = [];
	for (const m of flattenModules(mods)) {
		const path = join(outDir, `${m.name}.sv`);
		await writeFile(path, printSv(m, unitId), "utf8");
		written.push(path);
	}
	return written;
}

/** Load a .autowire/connect snapshot file if it exists. */
export async function loadSnapshotFile(
	dir: string,
	unitId: string,
): Promise<string | null> {
	const path = join(dir, `${unitId}.html`);
	if (!existsSync(path)) return null;
	return readFile(path, "utf8");
}
