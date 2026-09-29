// Connect-unit abstract module info XML (`.autowire/connect/<id>.xml`).
// Format mirrors the RtlIndex conventions (docs/hdxml/rtlindex-xml.md §3):
// attributes carry all data (port direction via @dir), modules sorted by
// name, ports in declaration order — but NO timestamps or content hashes
// (deterministic diff-friendly; the HTML snapshot remains the full render).

import type { RenderModule } from "./printer.ts";
import { flattenModules } from "./printer.ts";

/** Port directions written verbatim; kept as an attr so <ports> stays in
 *  declaration order (tag-per-direction would lose it under Bun.XML's
 *  group-by-tag object shape). */

function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Serialize one unit's modules as abstract module-info XML. */
export function connectXml(unitId: string, mods: RenderModule[]): string {
	const out: string[] = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		`<connectUnit tool="autowire" id="${esc(unitId)}">`,
	];
	const flat = flattenModules(mods).sort((a, b) =>
		a.name.localeCompare(b.name),
	);
	for (const m of flat) {
		out.push(`  <module name="${esc(m.name)}">`);
		if (m.imports.length > 0) {
			out.push("    <imports>");
			for (const i of m.imports) {
				out.push(
					`      <import package="${esc(i.package)}" symbol="${esc(i.symbol)}"/>`,
				);
			}
			out.push("    </imports>");
		}
		if (m.params.length > 0) {
			out.push("    <params>");
			for (const p of m.params) {
				out.push(
					`      <param name="${esc(p.name)}" value="${esc(p.value)}"/>`,
				);
			}
			out.push("    </params>");
		}
		if (m.ports.length > 0) {
			out.push("    <ports>");
			for (const p of m.ports) {
				const attrs: [string, string][] = [
					["name", p.name],
					["dir", p.dir],
				];
				if (p.dir === "interface") {
					attrs.push(["interface", p.interface]);
					if (p.modport) attrs.push(["modport", p.modport]);
				} else {
					if (p.packed) attrs.push(["packed", p.packed]);
					if (p.unpacked) attrs.push(["unpacked", p.unpacked]);
					if (p.nettype) attrs.push(["nettype", p.nettype]);
				}
				out.push(
					`      <port ${attrs.map(([k, v]) => `${k}="${esc(v)}"`).join(" ")}/>`,
				);
			}
			out.push("    </ports>");
		}
		out.push("  </module>");
	}
	out.push("</connectUnit>", "");
	return out.join("\n");
}

export interface ConnectXmlModule {
	name: string;
	params: { name: string; value: string }[];
	ports: {
		name: string;
		dir: string;
		packed: string | null;
		unpacked: string | null;
		nettype: string | null;
		interface: string | null;
		modport: string | null;
	}[];
	imports: { package: string; symbol: string }[];
}

/** Parse a <connectUnit> XML sidecar back into abstract module facts. */
export function parseConnectXml(text: string): ConnectXmlModule[] {
	const doc: unknown = Bun.XML.parse(text);
	const root =
		typeof doc === "object" && doc !== null
			? (doc as Record<string, unknown>).connectUnit
			: undefined;
	if (typeof root !== "object" || root === null) {
		throw new Error("connect XML: missing <connectUnit> root");
	}
	const asArr = (v: unknown): unknown[] =>
		Array.isArray(v) ? v : v == null ? [] : [v];
	const at = (o: unknown, k: string): string =>
		typeof o === "object" &&
		o !== null &&
		typeof (o as Record<string, unknown>)[`@${k}`] === "string"
			? ((o as Record<string, unknown>)[`@${k}`] as string)
			: "";
	const out: ConnectXmlModule[] = [];
	for (const m of asArr((root as Record<string, unknown>).module)) {
		const mo = m as Record<string, unknown>;
		const ports: ConnectXmlModule["ports"] = [];
		const portsEl = mo.ports as Record<string, unknown> | undefined;
		if (portsEl?.input !== undefined || portsEl?.output !== undefined)
			throw new Error(
				"connect XML: stale direction-tagged ports; rerun `connect run` to regenerate the sidecar",
			);
		for (const p of asArr(portsEl?.port)) {
			ports.push({
				name: at(p, "name"),
				dir: at(p, "dir") || "input",
				packed: at(p, "packed") || null,
				unpacked: at(p, "unpacked") || null,
				nettype: at(p, "nettype") || null,
				interface: at(p, "interface") || null,
				modport: at(p, "modport") || null,
			});
		}
		const paramsEl = mo.params as Record<string, unknown> | undefined;
		const impEl = mo.imports as Record<string, unknown> | undefined;
		out.push({
			name: at(m, "name"),
			params: asArr(paramsEl?.param).map((p) => ({
				name: at(p, "name"),
				value: at(p, "value"),
			})),
			ports,
			imports: asArr(impEl?.import).map((i) => ({
				package: at(i, "package"),
				symbol: at(i, "symbol") || "*",
			})),
		});
	}
	return out;
}

/** JSON mirror of the connect sidecar (same data as connectXml; written when
 *  [analysis.index] format = "json"). Ports omit empty attrs; missing means
 *  null on read, matching parseConnectXml. */
export function connectJson(unitId: string, mods: RenderModule[]): string {
	const flat = flattenModules(mods).sort((a, b) =>
		a.name.localeCompare(b.name),
	);
	const modules = flat.map((m) => ({
		name: m.name,
		imports: m.imports.map((i) => ({ package: i.package, symbol: i.symbol })),
		params: m.params.map((p) => ({ name: p.name, value: p.value })),
		ports: m.ports.map((p) => {
			const o: Record<string, string> = { name: p.name, dir: p.dir };
			if (p.dir === "interface") {
				o.interface = p.interface;
				if (p.modport) o.modport = p.modport;
			} else {
				if (p.packed) o.packed = p.packed;
				if (p.unpacked) o.unpacked = p.unpacked;
				if (p.nettype) o.nettype = p.nettype;
			}
			return o;
		}),
	}));
	return JSON.stringify({ tool: "autowire", id: unitId, modules }, null, 2);
}

/** Parse a JSON connect sidecar back into abstract module facts. */
export function parseConnectJson(text: string): ConnectXmlModule[] {
	const doc: unknown = JSON.parse(text);
	const isObj = (v: unknown): v is Record<string, unknown> =>
		typeof v === "object" && v !== null;
	if (!isObj(doc) || !Array.isArray(doc.modules)) {
		throw new Error("connect JSON: missing modules array");
	}
	const str = (v: unknown): string => (typeof v === "string" ? v : "");
	const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
	const out: ConnectXmlModule[] = [];
	for (const m of arr(doc.modules)) {
		if (!isObj(m)) continue;
		out.push({
			name: str(m.name),
			params: arr(m.params).map((p) => ({
				name: str(isObj(p) ? p.name : ""),
				value: str(isObj(p) ? p.value : ""),
			})),
			ports: arr(m.ports).map((p) => ({
				name: str(isObj(p) ? p.name : ""),
				dir: str(isObj(p) ? p.dir : "") || "input",
				packed: str(isObj(p) ? p.packed : "") || null,
				unpacked: str(isObj(p) ? p.unpacked : "") || null,
				nettype: str(isObj(p) ? p.nettype : "") || null,
				interface: str(isObj(p) ? p.interface : "") || null,
				modport: str(isObj(p) ? p.modport : "") || null,
			})),
			imports: arr(m.imports).map((i) => ({
				package: str(isObj(i) ? i.package : ""),
				symbol: str(isObj(i) ? i.symbol : "") || "*",
			})),
		});
	}
	return out;
}
