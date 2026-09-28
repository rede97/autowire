import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import {
	type AuthorMod,
	type AuthorMods,
	check,
	elaborate,
	installGlobal,
	serializeSnapshot,
} from "../../src/core/aw.ts";

/** querySelector + non-null, failing the test with context instead of `!`. */
function mustQuery(root: ParentNode, sel: string): Element {
	const el = root.querySelector(sel);
	if (!el) throw new Error(`expected element ${sel}`);
	return el;
}

interface LeafPort {
	name: string;
	dir: string;
	dataType?: string;
	packed?: string | null;
	unpacked?: string | null;
}

function docOf(body: string): Document {
	return parseHTML(`<html><body><autowire>${body}</autowire></body></html>`)
		.document;
}

function leafOf(
	ports: LeafPort[],
	params: { name: string; defaultText?: string; kind?: string }[] = [],
) {
	return {
		params: params.map((p) => ({
			name: p.name,
			kind: p.kind ?? "parameter",
			defaultText: p.defaultText ?? null,
		})),
		ports: ports.map((p) => ({
			name: p.name,
			dir: p.dir,
			dataType: p.dataType ?? "logic",
			packed: p.packed ?? null,
			unpacked: p.unpacked ?? null,
		})),
		imports: [],
	};
}

const counterLeaf = leafOf(
	[
		{ name: "clk_i", dir: "input" },
		{ name: "d_i", dir: "input", packed: "[Width-1:0]" },
		{ name: "q_o", dir: "output", packed: "[Width-1:0]" },
	],
	[{ name: "Width", defaultText: "4" }],
);

function ctxWith(
	leaves: Record<string, unknown>,
	extra: Record<string, unknown> = {},
) {
	return {
		leaf: (m: string) => (leaves[m] ?? null) as never,
		...extra,
	};
}

describe("check (author face)", () => {
	test("rules directly under aw-inst are rejected (connect-rules §1)", () => {
		const doc = docOf(
			`<aw-mod name="m"><aw-content><aw-insts>
				<aw-inst id="u" mod="leaf"><aw-connect port="clk_i" to="c"></aw-connect></aw-inst>
			</aw-insts></aw-content></aw-mod>`,
		);
		const res = check(doc, ctxWith({ leaf: counterLeaf }));
		expect(
			res.errors.some((e) => e.includes("must be wrapped in <aw-template>")),
		).toBe(true);
	});

	test("sibling ref without deps is an error; with deps it passes", () => {
		const mk = (deps: string) =>
			docOf(
				`<aw-mod name="top"><aw-content></aw-content><aw-submods>
					<aw-mod name="a"><aw-content><aw-insts>
						<aw-inst id="u" mod="b"><aw-template></aw-template></aw-inst>
					</aw-insts></aw-content></aw-mod>
					<aw-mod name="b" ${deps}><aw-content></aw-content></aw-mod>
				</aw-submods></aw-mod>`,
			);
		// a references b but b did not declare a in deps — a's own deps must list b.
		const noDeps = check(mk(""), ctxWith({}));
		// The ref lives in "a"; b's deps do not matter. Build with a declaring deps instead.
		const withDeps = docOf(
			`<aw-mod name="top"><aw-content></aw-content><aw-submods>
				<aw-mod name="a" deps="b"><aw-content><aw-insts>
					<aw-inst id="u" mod="b"><aw-template></aw-template></aw-inst>
				</aw-insts></aw-content></aw-mod>
				<aw-mod name="b"><aw-content></aw-content></aw-mod>
			</aw-submods></aw-mod>`,
		);
		expect(noDeps.errors.some((e) => e.includes("visible set"))).toBe(true);
		expect(check(withDeps, ctxWith({})).errors).toEqual([]);
	});

	test("sibling does not inherit another sibling's deps (path-accum only ancestors)", () => {
		// a deps=c makes c visible to a (and a's descendants), not to b.
		const doc = docOf(
			`<aw-mod name="top"><aw-content></aw-content><aw-submods>
				<aw-mod name="a" deps="c"><aw-content></aw-content></aw-mod>
				<aw-mod name="b"><aw-content><aw-insts>
					<aw-inst id="u" mod="c"><aw-template></aw-template></aw-inst>
				</aw-insts></aw-content></aw-mod>
				<aw-mod name="c"><aw-content></aw-content></aw-mod>
			</aw-submods></aw-mod>`,
		);
		const res = check(doc, ctxWith({}));
		expect(
			res.errors.some(
				(e) => e.includes('mod "c"') && e.includes("visible set"),
			),
		).toBe(true);
	});

	test("child sees parent deps via path accumulation", () => {
		const doc = docOf(
			`<aw-mod name="top" deps="shared"><aw-content></aw-content><aw-submods>
				<aw-mod name="child"><aw-content><aw-insts>
					<aw-inst id="u" mod="shared"><aw-template></aw-template></aw-inst>
				</aw-insts></aw-content></aw-mod>
				<aw-mod name="shared"><aw-content></aw-content></aw-mod>
			</aw-submods></aw-mod>`,
		);
		expect(check(doc, ctxWith({})).errors).toEqual([]);
	});

	test("deps cycle and self-dep are errors", () => {
		const doc = docOf(
			`<aw-mod name="top"><aw-content></aw-content><aw-submods>
				<aw-mod name="a" deps="b"><aw-content></aw-content></aw-mod>
				<aw-mod name="b" deps="a"><aw-content></aw-content></aw-mod>
			</aw-submods></aw-mod>`,
		);
		expect(
			check(doc, ctxWith({})).errors.some((e) => e.includes("cycle")),
		).toBe(true);
		const self = docOf(
			`<aw-mod name="top"><aw-content></aw-content><aw-submods>
				<aw-mod name="a" deps="a"><aw-content></aw-content></aw-mod>
			</aw-submods></aw-mod>`,
		);
		expect(
			check(self, ctxWith({})).errors.some((e) =>
				e.includes("depends on itself"),
			),
		).toBe(true);
	});

	test("unused deps warn; unknown dep errors", () => {
		const doc = docOf(
			`<aw-mod name="top"><aw-content></aw-content><aw-submods>
				<aw-mod name="a" deps="b"><aw-content></aw-content></aw-mod>
				<aw-mod name="b"><aw-content></aw-content></aw-mod>
				<aw-mod name="c" deps="ghost"><aw-content></aw-content></aw-mod>
			</aw-submods></aw-mod>`,
		);
		const res = check(doc, ctxWith({}));
		expect(
			res.warnings.some((w) => w.includes('"b" declared but never referenced')),
		).toBe(true);
		expect(res.errors.some((e) => e.includes('unknown sibling "ghost"'))).toBe(
			true,
		);
	});

	test("regex captures outside aw-rewrite@to are rejected; [] in to rejected", () => {
		const doc = docOf(
			`<aw-mod name="m"><aw-content><aw-insts>
				<aw-inst id="u" mod="leaf"><aw-template>
					<aw-connect port="clk_i" to="net_$1"></aw-connect>
				</aw-template></aw-inst>
				<aw-inst id="v" mod="leaf"><aw-template>
					<aw-connect port="clk_i" to="net[3:0]"></aw-connect>
				</aw-template></aw-inst>
			</aw-insts></aw-content></aw-mod>`,
		);
		const res = check(doc, ctxWith({ leaf: counterLeaf }));
		expect(res.errors.some((e) => e.includes("regex captures"))).toBe(true);
		expect(
			res.errors.some((e) => e.includes("neither a net name nor a constant")),
		).toBe(true);
	});

	test("aw-param on localparam or unknown param rejected; unknown port rejected", () => {
		const doc = docOf(
			`<aw-mod name="m"><aw-content><aw-insts>
				<aw-inst id="u" mod="leaf"><aw-template>
					<aw-param name="Nope" expr="1"></aw-param>
					<aw-connect port="nope_i" to="x"></aw-connect>
				</aw-template></aw-inst>
			</aw-insts></aw-content></aw-mod>`,
		);
		const res = check(doc, ctxWith({ leaf: counterLeaf }));
		expect(
			res.errors.some((e) => e.includes('aw-param "Nope" does not exist')),
		).toBe(true);
		expect(
			res.errors.some((e) => e.includes('port "nope_i" does not exist')),
		).toBe(true);
	});

	test("packed/width conflict is an error", () => {
		const doc = docOf(
			`<aw-mod name="m"><aw-content><aw-insts>
				<aw-inst id="u" mod="leaf"><aw-template>
					<aw-connect port="d_i" to="x" packed="[7:0]" width="15:0"></aw-connect>
				</aw-template></aw-inst>
			</aw-insts></aw-content></aw-mod>`,
		);
		const res = check(doc, ctxWith({ leaf: counterLeaf }));
		expect(res.errors.some((e) => e.includes("conflicts with width"))).toBe(
			true,
		);
	});

	test("cross-unit ref without toml deps is an error; declared deps pass", () => {
		const doc = docOf(
			`<aw-mod name="tb"><aw-content><aw-insts>
				<aw-inst id="u" mod="wrap_a"><aw-template></aw-template></aw-inst>
			</aw-insts></aw-content></aw-mod>`,
		);
		const unitMods = new Map([["wrap_a", "unit_a"]]);
		const bad = check(
			doc,
			ctxWith({}, { unitId: "tb", unitMods, unitDeps: [] }),
		);
		expect(bad.errors.some((e) => e.includes("deps"))).toBe(true);
		const good = check(
			doc,
			ctxWith({}, { unitId: "tb", unitMods, unitDeps: ["unit_a"] }),
		);
		expect(good.errors).toEqual([]);
	});
});

describe("elaborate (render)", () => {
	test("template base + overwrite: later rule wins per port", () => {
		const doc = docOf(
			`<aw-mod name="m"><aw-content>
				<aw-templates>
					<aw-template name="t">
						<aw-connect port="clk_i" to="base_clk"></aw-connect>
						<aw-connect port="d_i" to="base_d" packed="auto"></aw-connect>
					</aw-template>
				</aw-templates>
				<aw-insts>
					<aw-inst id="u" mod="leaf">
						<aw-template base="t">
							<aw-connect port="clk_i" to="over_clk"></aw-connect>
						</aw-template>
					</aw-inst>
				</aw-insts>
			</aw-content></aw-mod>`,
		);
		const res = elaborate(doc, ctxWith({ leaf: counterLeaf }));
		expect(res.errors).toEqual([]);
		const connects = [
			...mustQuery(doc, "aw-render aw-inst").querySelectorAll("aw-connect"),
		].map((c) => [c.getAttribute("port"), c.getAttribute("to")]);
		expect(connects).toContainEqual(["clk_i", "over_clk"]);
		expect(connects).toContainEqual(["d_i", "base_d"]);
		expect(connects.filter(([p]) => p === "clk_i")).toHaveLength(1);
	});

	// biome-ignore lint/suspicious/noTemplateCurlyInString: dialect variable syntax, not JS
	test("rewrite captures + ${idx}; part-select folds constants", () => {
		const doc = docOf(
			`<aw-mod name="m"><aw-content><aw-insts>
				<aw-inst id="u" mod="leaf" idx="1"><aw-template>
					<aw-rewrite match="^q_o$" to="bus" width="15:0" part="8*\${idx}+7:8*\${idx}"></aw-rewrite>
				</aw-template></aw-inst>
			</aw-insts></aw-content></aw-mod>`,
		);
		const res = elaborate(doc, ctxWith({ leaf: counterLeaf }));
		expect(res.errors).toEqual([]);
		const c = mustQuery(doc, 'aw-render aw-connect[port="q_o"]');
		expect(c.getAttribute("to")).toBe("bus");
		expect(c.getAttribute("part")).toBe("15:8");
		expect(c.getAttribute("dir")).toBe("output");
		expect(c.getAttribute("port-packed")).toBe("[3:0]");
		const sig = mustQuery(doc, 'aw-signals aw-signal[name="bus"]');
		expect(sig.getAttribute("packed")).toBe("[15:0]");
	});

	test("render records per-instance port-packed / port-unpacked for multi-dim ports", () => {
		const memLeaf = leafOf(
			[
				{
					name: "mem_i",
					dir: "input",
					packed: "[Width-1:0]",
					unpacked: "[0:Depth-1]",
				},
				{ name: "lanes_o", dir: "output", packed: "[3:0][Width-1:0]" },
				{ name: "en_i", dir: "input" },
			],
			[
				{ name: "Width", defaultText: "8" },
				{ name: "Depth", defaultText: "16" },
			],
		);
		const doc = docOf(
			`<aw-mod name="m"><aw-content><aw-insts>
				<aw-inst id="u" mod="mem"><aw-template>
					<aw-param name="Depth" expr="4"></aw-param>
				</aw-template></aw-inst>
			</aw-insts></aw-content></aw-mod>`,
		);
		const res = elaborate(doc, ctxWith({ mem: memLeaf }));
		expect(res.errors).toEqual([]);
		const at = (port: string, name: string) =>
			mustQuery(doc, `aw-render aw-connect[port="${port}"]`).getAttribute(name);
		// default Width=8; overridden Depth=4 folds into the unpacked range
		expect(at("mem_i", "port-packed")).toBe("[7:0]");
		expect(at("mem_i", "port-unpacked")).toBe("[0:3]");
		expect(at("lanes_o", "port-packed")).toBe("[3:0][7:0]");
		expect(at("lanes_o", "port-unpacked")).toBeNull();
		expect(at("en_i", "port-packed")).toBeNull();
	});

	test("param folding (style param=localparam): constant folds; module param name stays symbolic; expression kept", () => {
		const doc = docOf(
			`<aw-mod name="m"><aw-content>
				<aw-params><aw-param name="W" expr="8"></aw-param></aw-params>
				<aw-localparams><aw-localparam name="L" expr="3"></aw-localparam></aw-localparams>
				<aw-insts>
				<aw-inst id="a" mod="leaf"><aw-template><aw-param name="Width" expr="5"></aw-param><aw-connect port="d_i" to="0" type="const"></aw-connect><aw-rewrite match="^q_o$" type="open"></aw-rewrite></aw-template></aw-inst>
				<aw-inst id="b" mod="leaf"><aw-template><aw-param name="Width" expr="W"></aw-param><aw-connect port="d_i" to="0" type="const"></aw-connect><aw-rewrite match="^q_o$" type="open"></aw-rewrite></aw-template></aw-inst>
				<aw-inst id="c" mod="leaf"><aw-template><aw-param name="Width" expr="L"></aw-param><aw-connect port="d_i" to="0" type="const"></aw-connect><aw-rewrite match="^q_o$" type="open"></aw-rewrite></aw-template></aw-inst>
				<aw-inst id="d" mod="leaf"><aw-template><aw-param name="Width" expr="W+1"></aw-param><aw-connect port="d_i" to="0" type="const"></aw-connect><aw-rewrite match="^q_o$" type="open"></aw-rewrite></aw-template></aw-inst>
				</aw-insts>
			</aw-content></aw-mod>`,
		);
		const res = elaborate(
			doc,
			ctxWith({ leaf: counterLeaf }, { style: { paramInline: false } }),
		);
		expect(res.errors).toEqual([]);
		const lps = [...doc.querySelectorAll("aw-render aw-localparam")].map(
			(l) => [
				l.getAttribute("name"),
				l.getAttribute("value"),
				l.getAttribute("folded"),
			],
		);
		expect(lps).toContainEqual(["m__a__Width", "5", "true"]);
		// Module params are overridable: never fold to the default.
		expect(lps).toContainEqual(["m__b__Width", "W", "false"]);
		// Internal localparam with a constant value folds.
		expect(lps).toContainEqual(["m__c__Width", "3", "true"]);
		expect(lps).toContainEqual(["m__d__Width", "W+1", "false"]);
	});

	test("style localparam_upper: generated folding names are uppercased (references included)", () => {
		const doc = docOf(
			`<aw-mod name="m"><aw-content><aw-params><aw-param name="W" expr="8"></aw-param></aw-params><aw-insts>
				<aw-inst id="u_a" mod="leaf"><aw-template><aw-param name="Width" expr="W+1"></aw-param></aw-template></aw-inst>
			</aw-insts></aw-content></aw-mod>`,
		);
		const res = elaborate(
			doc,
			ctxWith({ leaf: counterLeaf }, { style: { localparamUpper: true } }),
		);
		expect(res.errors).toEqual([]);
		const lp = doc.querySelector("aw-render aw-localparam");
		expect(lp?.getAttribute("name")).toBe("M__U_A__WIDTH");
		const instParam = doc.querySelector("aw-render aw-inst aw-param");
		expect(instParam?.getAttribute("value")).toBe("M__U_A__WIDTH");
	});

	test("overridden leaf param rewrites auto port dims to Mod__Inst__Param (§7.4, localparam mode)", () => {
		const doc = docOf(
			`<aw-mod name="m"><aw-content><aw-insts>
				<aw-inst id="u" mod="leaf"><aw-template>
					<aw-param name="Width" expr="8"></aw-param>
					<aw-connect port="d_i" to="d" packed="auto"></aw-connect>
				</aw-template></aw-inst>
			</aw-insts></aw-content></aw-mod>`,
		);
		const res = elaborate(
			doc,
			ctxWith({ leaf: counterLeaf }, { style: { paramInline: false } }),
		);
		expect(res.errors).toEqual([]);
		const sig = mustQuery(doc, 'aw-signals aw-signal[name="d"]');
		expect(sig.getAttribute("packed")).toBe("[m__u__Width-1:0]");
		expect(
			mustQuery(doc, 'aw-render aw-connect[port="d_i"]').getAttribute(
				"port-packed",
			),
		).toBe("[7:0]");
	});
	test("inline mode (default): override expression lands on the instance, dims substitute it", () => {
		const doc = docOf(
			`<aw-mod name="m"><aw-content><aw-insts>
				<aw-inst id="u" mod="leaf"><aw-template>
					<aw-param name="Width" expr="8"></aw-param>
					<aw-connect port="d_i" to="d" packed="auto"></aw-connect>
				</aw-template></aw-inst>
			</aw-insts></aw-content></aw-mod>`,
		);
		const res = elaborate(doc, ctxWith({ leaf: counterLeaf }));
		expect(res.errors).toEqual([]);
		// no Mod__Inst__Param localparams in inline mode
		expect(doc.querySelectorAll("aw-render aw-localparam")).toHaveLength(0);
		const p = mustQuery(doc, 'aw-render aw-inst aw-param[name="Width"]');
		expect(p.getAttribute("value")).toBe("8");
		const sig = mustQuery(doc, 'aw-signals aw-signal[name="d"]');
		expect(sig.getAttribute("packed")).toBe("[(8)-1:0]");
	});
	test("inline mode: ANY operator (concat / arithmetic) forces localparam folding", () => {
		const doc = docOf(
			`<aw-mod name="m"><aw-content><aw-insts>
				<aw-inst id="u" mod="leaf"><aw-template>
					<aw-param name="Width" expr="{4'h2, 4'h4}"></aw-param>
					<aw-param name="Sticky" expr="W+1"></aw-param>
				</aw-template></aw-inst>
			</aw-insts></aw-content></aw-mod>`,
		);
		const res = elaborate(
			doc,
			ctxWith({ leaf: leafOf([], [{ name: "Width" }, { name: "Sticky" }]) }),
		);
		expect(res.errors).toEqual([]);
		const names = [...doc.querySelectorAll("aw-render aw-localparam")].map(
			(l) => l.getAttribute("name"),
		);
		expect(names).toContain("m__u__Width");
		expect(names).toContain("m__u__Sticky");
		const p = mustQuery(doc, 'aw-render aw-inst aw-param[name="Width"]');
		expect(p.getAttribute("value")).toBe("m__u__Width");
	});

	test("auto-export: input-only nets become input ports; output-only nets become output ports; driven+loaded nets stay internal", () => {
		const doc = docOf(
			`<aw-mod name="m"><aw-content><aw-insts>
				<aw-inst id="u" mod="leaf"><aw-template>
					<aw-connect port="clk_i" to="ext_clk"></aw-connect>
					<aw-connect port="q_o" to="int_q" packed="auto"></aw-connect>
				</aw-template></aw-inst>
				<aw-inst id="v" mod="leaf"><aw-template>
					<aw-connect port="clk_i" to="ext_clk"></aw-connect>
					<aw-connect port="q_o" to="shared" packed="auto"></aw-connect>
				</aw-template></aw-inst>
				<aw-inst id="w" mod="leaf"><aw-template>
					<aw-connect port="clk_i" to="ext_clk"></aw-connect>
					<aw-connect port="d_i" to="shared" packed="auto"></aw-connect>
				</aw-template></aw-inst>
			</aw-insts></aw-content></aw-mod>`,
		);
		const res = elaborate(doc, ctxWith({ leaf: counterLeaf }));
		expect(res.errors).toEqual([]);
		const ports = [...doc.querySelectorAll("aw-render aw-port")].map((p) => [
			p.getAttribute("name"),
			p.getAttribute("dir"),
		]);
		expect(ports).toContainEqual(["ext_clk", "input"]);
		// driven by u.q_o, consumed nowhere → exports upward as output
		expect(ports).toContainEqual(["int_q", "output"]);
		// driven by v.q_o AND consumed by w.d_i → internal signal, not a port
		expect(ports.some(([n]) => n === "shared")).toBe(false);
		expect(
			doc.querySelector('aw-signals aw-signal[name="shared"]'),
		).not.toBeNull();
	});

	test("dimension conflict on one net is an error (after constant folding)", () => {
		const doc = docOf(
			`<aw-mod name="m"><aw-content><aw-insts>
				<aw-inst id="u" mod="leaf"><aw-template>
					<aw-connect port="d_i" to="x" width="7:0"></aw-connect>
					<aw-connect port="q_o" to="x" width="15:0"></aw-connect>
				</aw-template></aw-inst>
			</aw-insts></aw-content></aw-mod>`,
		);
		const res = elaborate(doc, ctxWith({ leaf: counterLeaf }));
		expect(res.errors.some((e) => e.includes("dimension conflict"))).toBe(true);
	});

	// biome-ignore lint/suspicious/noTemplateCurlyInString: dialect variable syntax, not JS
	test("inst_name default and ${id}_${idx}; duplicate expanded names error", () => {
		const okDoc = docOf(
			`<aw-mod name="m"><aw-content><aw-insts>
				<aw-inst id="u" mod="leaf" idx="0"><aw-template inst_name="\${id}_\${idx}"></aw-template></aw-inst>
			</aw-insts></aw-content></aw-mod>`,
		);
		elaborate(okDoc, ctxWith({ leaf: counterLeaf }));
		expect(mustQuery(okDoc, "aw-render aw-inst").getAttribute("id")).toBe(
			"u_0",
		);
		const dupDoc = docOf(
			`<aw-mod name="m"><aw-content><aw-insts>
				<aw-inst id="u" mod="leaf"><aw-template></aw-template></aw-inst>
				<aw-inst id="u" mod="leaf"><aw-template></aw-template></aw-inst>
			</aw-insts></aw-content></aw-mod>`,
		);
		const res = elaborate(dupDoc, ctxWith({ leaf: counterLeaf }));
		expect(res.errors.some((e) => e.includes("not unique"))).toBe(true);
	});

	test("nested submod wrapper instantiates with its render port table", () => {
		const doc = docOf(
			`<aw-mod name="top"><aw-content><aw-insts>
				<aw-inst id="u" mod="kid"><aw-template>
					<aw-connect port="kp" to="outside"></aw-connect>
				</aw-template></aw-inst>
			</aw-insts></aw-content><aw-submods>
				<aw-mod name="kid"><aw-content>
					<aw-ports><aw-port dir="input" name="kp"></aw-port></aw-ports>
					<aw-insts>
						<aw-inst id="i" mod="leaf"><aw-template>
							<aw-connect port="clk_i" to="kp"></aw-connect>
						</aw-template></aw-inst>
					</aw-insts>
				</aw-content></aw-mod>
			</aw-submods></aw-mod>`,
		);
		const res = elaborate(doc, ctxWith({ leaf: counterLeaf }));
		expect(res.errors).toEqual([]);
		const top = mustQuery(doc, 'aw-mod[name="top"]');
		const ports = [
			...mustQuery(top, ":scope > aw-render").querySelectorAll("aw-port"),
		].map((p) => p.getAttribute("name"));
		expect(ports).toContain("outside");
	});

	test("on-init creates instances after children exist", () => {
		const doc = docOf(
			`<aw-mod name="top"><aw-content on-init="build"><aw-insts></aw-insts></aw-content>
			<aw-submods><aw-mod name="kid"><aw-content>
				<aw-ports><aw-port dir="output" name="q"></aw-port></aw-ports>
				<aw-insts><aw-inst id="i" mod="leaf"><aw-template>
					<aw-connect port="clk_i" to="c"></aw-connect>
				</aw-template></aw-inst></aw-insts>
			</aw-content></aw-mod></aw-submods></aw-mod>`,
		);
		const view = doc.defaultView as unknown as Record<string, unknown>;
		view.build = (content: Element, mods: AuthorMods) => {
			const kid = mods("kid");
			if (!kid?.ports.some((p) => p.name === "q"))
				throw new Error("child facts missing");
			const insts = mustQuery(content, ":scope > aw-insts");
			const inst = content.ownerDocument.createElement("aw-inst");
			inst.setAttribute("id", "gen");
			inst.setAttribute("mod", "kid");
			const tpl = content.ownerDocument.createElement("aw-template");
			const c = content.ownerDocument.createElement("aw-connect");
			c.setAttribute("port", "q");
			c.setAttribute("to", "gen_q");
			tpl.appendChild(c);
			inst.appendChild(tpl);
			insts.appendChild(inst);
		};
		const res = elaborate(doc, ctxWith({ leaf: counterLeaf }));
		expect(res.errors).toEqual([]);
		const snap = serializeSnapshot(doc);
		expect(snap).toContain('id="gen"');
		expect(snap).not.toContain("aw-template");
	});

	test("on-template edits this instance from its attributes and the target module", () => {
		const doc = docOf(
			`<aw-mod name="m"><aw-content><aw-insts>
				<aw-inst id="u" mod="leaf" idx="3" on-template="wire"></aw-inst>
			</aw-insts></aw-content></aw-mod>`,
		);
		const view = doc.defaultView as unknown as Record<string, unknown>;
		view.wire = (inst: Element, mod: AuthorMod) => {
			if (mod.params[0]?.name !== "Width") throw new Error("params missing");
			if (!mod.ports.some((p) => p.name === "clk_i"))
				throw new Error("ports missing");
			const tpl = inst.ownerDocument.createElement("aw-template");
			const c = inst.ownerDocument.createElement("aw-connect");
			c.setAttribute("port", "clk_i");
			c.setAttribute(
				"to",
				`${inst.getAttribute("id")}_${inst.getAttribute("idx")}`,
			);
			tpl.appendChild(c);
			inst.appendChild(tpl);
		};
		const res = elaborate(doc, ctxWith({ leaf: counterLeaf }));
		expect(res.errors).toEqual([]);
		expect(serializeSnapshot(doc)).toContain('to="u_3"');
	});

	test("a missing on-init function is an error and does not freeze a render", () => {
		const doc = docOf(
			`<aw-mod name="m"><aw-content on-init="missing"><aw-insts></aw-insts></aw-content></aw-mod>`,
		);
		const res = elaborate(doc, ctxWith({ leaf: counterLeaf }));
		expect(res.errors.some((e) => e.includes("not a function on window"))).toBe(
			true,
		);
		expect(serializeSnapshot(doc)).not.toContain("aw-render");
	});

	test("aw.inst and aw.connect build rules, then on-template runs", () => {
		const doc = docOf(
			`<aw-mod name="m"><aw-content on-init="build"></aw-content></aw-mod>`,
		);
		const view = doc.defaultView as unknown as {
			aw: {
				inst: (el: Element, attrs: Record<string, string>) => Element;
				connect: (el: Element, attrs: Record<string, string>) => Element;
				port: (el: Element, attrs: Record<string, string>) => Element;
				rewrite: (el: Element, attrs: Record<string, string>) => Element;
			};
			build?: (content: Element) => void;
			wire?: (inst: Element, mod: AuthorMod) => void;
		};
		installGlobal(view as never);
		view.wire = (el, mod) => {
			if (!mod.ports.some((port) => port.name === "clk_i"))
				throw new Error("target module missing");
			view.aw.rewrite(el, { match: "clk_i", to: "clk_renamed" });
		};
		view.build = (content) => {
			view.aw.port(content, { name: "probe", dir: "output" });
			const created = view.aw.inst(content, {
				id: "u",
				mod: "leaf",
				onTemplate: "wire",
			});
			view.aw.connect(created, { port: "d_i", to: "data" });
		};
		const res = elaborate(doc, ctxWith({ leaf: counterLeaf }));
		expect(res.errors).toEqual([]);
		const snap = serializeSnapshot(doc);
		expect(snap).toContain('name="probe"');
		expect(snap).toContain('to="data"');
		expect(snap).toContain('to="clk_renamed"');
		expect(
			mustQuery(doc, "aw-content aw-inst").getAttribute("on-template"),
		).toBe("wire");
	});
});

describe("constant tie-off (connect-to-rules)", () => {
	const leaf = leafOf(
		[
			{ name: "clk_i", dir: "input" },
			{ name: "en_i", dir: "input" },
			{ name: "mode_i", dir: "input", packed: "[1:0]" },
			{ name: "init_i", dir: "input", packed: "[7:0]" },
			{ name: "test_a_i", dir: "input" },
			{ name: "test_b_i", dir: "input" },
			{ name: "q_o", dir: "output" },
		],
		[],
	);
	const scopeHead =
		`<aw-mod name="m"><aw-content>` +
		`<aw-params><aw-param name="W" expr="8"></aw-param></aw-params>` +
		`<aw-localparams><aw-localparam name="INIT" expr="8'hA5"></aw-localparam></aw-localparams>`;
	const mkInst = (rules: string) =>
		docOf(
			`${scopeHead}<aw-insts><aw-inst id="u" mod="leaf" idx="2"><aw-template>${rules}</aw-template></aw-inst></aw-insts></aw-content></aw-mod>`,
		);

	// biome-ignore lint/suspicious/noTemplateCurlyInString: test title documents the ${idx} dialect syntax
	test("literal / replication / ${idx} constants create no net and no export", () => {
		const doc = mkInst(
			`<aw-connect port="en_i" to="1'b0" type="const"></aw-connect>
			 <aw-connect port="init_i" to="{48{1'b1}}" type="const"></aw-connect>
			 <aw-connect port="mode_i" to="{\${idx}{1'b1}}" type="const"></aw-connect>`,
		);
		expect(check(doc, ctxWith({ leaf })).errors).toEqual([]);
		expect(elaborate(doc, ctxWith({ leaf })).errors).toEqual([]);
		const connects = [...doc.querySelectorAll("aw-render aw-connect")].map(
			(c) => [c.getAttribute("port"), c.getAttribute("to")],
		);
		expect(connects).toContainEqual(["en_i", "1'b0"]);
		expect(connects).toContainEqual(["init_i", "{48{1'b1}}"]);
		// ${idx} substitutes before classification
		expect(connects).toContainEqual(["mode_i", "{2{1'b1}}"]);
		// no nets were created for the constants; only inferred identity nets exist
		expect(
			[...doc.querySelectorAll("aw-render aw-signal")].map((s) =>
				s.getAttribute("name"),
			),
		).toEqual(["clk_i", "test_a_i", "test_b_i", "q_o"]);
	});

	test("param/localparam reference is a constant; expression with all-known identifiers too", () => {
		const doc = mkInst(
			`<aw-connect port="en_i" to="W" type="const"></aw-connect>
				 <aw-connect port="init_i" to="INIT" type="const"></aw-connect>
				 <aw-connect port="mode_i" to="W+1" type="const"></aw-connect>`,
		);
		expect(check(doc, ctxWith({ leaf })).errors).toEqual([]);
		expect(elaborate(doc, ctxWith({ leaf })).errors).toEqual([]);
		// no signal named W / INIT / "W+1" may appear; only inferred identity nets
		expect(
			[...doc.querySelectorAll("aw-render aw-signal")].map((s) =>
				s.getAttribute("name"),
			),
		).toEqual(["clk_i", "test_a_i", "test_b_i", "q_o"]);
	});

	test("unknown identifier in a constant expression is an error", () => {
		const doc = mkInst(`<aw-connect port="mode_i" to="NOPE+1"></aw-connect>`);
		expect(
			check(doc, ctxWith({ leaf })).errors.some((e) =>
				e.includes("neither a net name nor a constant"),
			),
		).toBe(true);
	});

	test("part/dims on a constant are rejected; type assertion mismatch errors", () => {
		const bad1 = mkInst(
			`<aw-connect port="en_i" to="1'b0" type="const" part="0"></aw-connect>`,
		);
		expect(
			check(bad1, ctxWith({ leaf })).errors.some((e) =>
				e.includes("part-select"),
			),
		).toBe(true);
		const bad2 = mkInst(
			`<aw-connect port="en_i" to="1'b0" type="net"></aw-connect>`,
		);
		expect(
			check(bad2, ctxWith({ leaf })).errors.some((e) =>
				e.includes('type="net"'),
			),
		).toBe(true);
		const okAssert = mkInst(
			`<aw-connect port="en_i" to="1'b0" type="const"></aw-connect>`,
		);
		expect(check(okAssert, ctxWith({ leaf })).errors).toEqual([]);
	});

	test("constant rewrite = batch tie-off; captures in const rewrite rejected", () => {
		// full-name match: String.replace replaces only the matched span
		const doc = mkInst(
			`<aw-rewrite match="^test_.*$" to="1'b0" type="const"></aw-rewrite>`,
		);
		expect(check(doc, ctxWith({ leaf })).errors).toEqual([]);
		expect(elaborate(doc, ctxWith({ leaf })).errors).toEqual([]);
		const connects = [...doc.querySelectorAll("aw-render aw-connect")].map(
			(c) => [c.getAttribute("port"), c.getAttribute("to")],
		);
		expect(connects).toContainEqual(["test_a_i", "1'b0"]);
		expect(connects).toContainEqual(["test_b_i", "1'b0"]);
		const badCap = mkInst(
			`<aw-rewrite match="^test_(.+)$" to="48'h0$1" type="const"></aw-rewrite>`,
		);
		// to after replace starts with a digit → const; captures present → error
		expect(
			check(badCap, ctxWith({ leaf })).errors.some((e) =>
				e.includes("captures"),
			),
		).toBe(true);
	});

	test("constant cannot drive an output port", () => {
		const doc = mkInst(
			`<aw-connect port="q_o" to="1'b1" type="const"></aw-connect>`,
		);
		expect(
			elaborate(doc, ctxWith({ leaf })).errors.some((e) =>
				e.includes("inputs only"),
			),
		).toBe(true);
	});
});

describe("open pins (connect-to-rules §2.3)", () => {
	const leaf = leafOf(
		[
			{ name: "clk_i", dir: "input" },
			{ name: "en_i", dir: "input" },
			{ name: "dbg_a_o", dir: "output" },
			{ name: "dbg_b_o", dir: "output" },
			{ name: "q_o", dir: "output" },
		],
		[],
	);
	const mkInst = (rules: string) =>
		docOf(
			`<aw-mod name="m"><aw-content><aw-insts><aw-inst id="u" mod="leaf"><aw-template>${rules}</aw-template></aw-inst></aw-insts></aw-content></aw-mod>`,
		);

	test("explicit open on an output: render records type=open, no net", () => {
		const doc = mkInst(
			`<aw-connect port="clk_i" to="clk"></aw-connect>
			 <aw-connect port="q_o" type="open"></aw-connect>`,
		);
		expect(check(doc, ctxWith({ leaf })).errors).toEqual([]);
		expect(elaborate(doc, ctxWith({ leaf })).errors).toEqual([]);
		const c = mustQuery(doc, 'aw-render aw-connect[port="q_o"]');
		expect(c.getAttribute("type")).toBe("open");
		expect(c.getAttribute("to")).toBeNull();
		expect(doc.querySelector('aw-signals aw-signal[name="q_o"]')).toBeNull();
	});

	test("batch open via rewrite; open can be overridden by a later net rule", () => {
		const doc = mkInst(
			`<aw-rewrite match="^dbg_.*_o$" type="open"></aw-rewrite>
			 <aw-connect port="dbg_a_o" to="dbg_a" type="net"></aw-connect>`,
		);
		expect(check(doc, ctxWith({ leaf })).errors).toEqual([]);
		expect(elaborate(doc, ctxWith({ leaf })).errors).toEqual([]);
		const open = mustQuery(doc, 'aw-render aw-connect[port="dbg_b_o"]');
		expect(open.getAttribute("type")).toBe("open");
		// later rule wins: dbg_a_o is a net again
		const net = mustQuery(doc, 'aw-render aw-connect[port="dbg_a_o"]');
		expect(net.getAttribute("to")).toBe("dbg_a");
		expect(net.getAttribute("type")).toBeNull();
	});

	test("open on input errors; open with to errors; missing to without type errors", () => {
		const onInput = mkInst(`<aw-connect port="en_i" type="open"></aw-connect>`);
		expect(
			elaborate(onInput, ctxWith({ leaf })).errors.some((e) =>
				e.includes("only allowed on output/inout"),
			),
		).toBe(true);
		const withTo = mkInst(
			`<aw-connect port="q_o" type="open" to="x"></aw-connect>`,
		);
		expect(
			check(withTo, ctxWith({ leaf })).errors.some((e) =>
				e.includes('type="open" takes no'),
			),
		).toBe(true);
		const noTo = mkInst(`<aw-connect port="q_o"></aw-connect>`);
		expect(
			check(noTo, ctxWith({ leaf })).errors.some((e) =>
				e.includes('declare type="open"'),
			),
		).toBe(true);
	});

	test("uncovered ports auto-connect same-name nets (identity inference), explicit rules win", () => {
		const doc = mkInst(`<aw-connect port="en_i" to="shared_en"></aw-connect>`);
		const res = elaborate(doc, ctxWith({ leaf }));
		expect(res.errors).toEqual([]);
		// clk_i / d_i / q_o uncovered → same-named nets, no warnings
		expect(res.warnings.filter((w) => w.includes("not covered"))).toEqual([]);
		expect(
			doc
				.querySelector('aw-render aw-connect[port="clk_i"]')
				?.getAttribute("to"),
		).toBe("clk_i");
		expect(
			doc.querySelector('aw-render aw-connect[port="q_o"]')?.getAttribute("to"),
		).toBe("q_o");
		// explicit rule for en_i wins over inference
		expect(
			doc
				.querySelector('aw-render aw-connect[port="en_i"]')
				?.getAttribute("to"),
		).toBe("shared_en");
		// inferred nets export upward: clk_i input-only, q_o output-only
		const ports = [...doc.querySelectorAll("aw-render aw-port")].map((p) => [
			p.getAttribute("name"),
			p.getAttribute("dir"),
		]);
		expect(ports).toContainEqual(["clk_i", "input"]);
		expect(ports).toContainEqual(["q_o", "output"]);
	});

	test("two full-net output drivers on one net is a short-circuit error", () => {
		const doc = docOf(
			`<aw-mod name="m"><aw-content><aw-insts>
				<aw-inst id="u" mod="leaf"><aw-template>
					<aw-connect port="q_o" to="x" packed="auto"></aw-connect>
				</aw-template></aw-inst>
				<aw-inst id="v" mod="leaf"><aw-template>
					<aw-connect port="q_o" to="x" packed="auto"></aw-connect>
				</aw-template></aw-inst>
			</aw-insts></aw-content></aw-mod>`,
		);
		const res = elaborate(doc, ctxWith({ leaf: counterLeaf }));
		expect(res.errors.some((e) => e.includes("output drivers"))).toBe(true);
		// Failed elaborate must not commit aw-render (no frozen partial netlist).
		expect(doc.querySelector("aw-render aw-inst")).toBeNull();
		expect(doc.querySelector("aw-render aw-connect")).toBeNull();
	});
});

describe("aw-tb-mod / raw / includes", () => {
	test("sim unit requires aw-tb-mod; connect forbids it", () => {
		const tb = docOf(
			`<aw-mod name="m"><aw-content><aw-insts></aw-insts></aw-content></aw-mod>`,
		);
		expect(
			check(tb, { unitKind: "sim" }).errors.some((e) =>
				e.includes("aw-tb-mod"),
			),
		).toBe(true);
		const ok = docOf(
			`<aw-tb-mod name="tb"><aw-content><aw-insts></aw-insts></aw-content></aw-tb-mod>`,
		);
		expect(check(ok, { unitKind: "sim" }).errors).toEqual([]);
		const badConnect = docOf(
			`<aw-tb-mod name="tb"><aw-content><aw-insts></aw-insts></aw-content></aw-tb-mod>`,
		);
		expect(
			check(badConnect, { unitKind: "connect" }).errors.some((e) =>
				e.includes("must not contain <aw-tb-mod>"),
			),
		).toBe(true);
	});

	test("aw-tb-mod forbids params/ports/submods/deps; include only on tb", () => {
		const doc = docOf(
			`<aw-tb-mod name="tb" deps="x"><aw-content>
				<aw-params><aw-param name="W" expr="8"></aw-param></aw-params>
				<aw-ports><aw-port name="clk" dir="input"></aw-port></aw-ports>
				<aw-insts></aw-insts>
			</aw-content>
			<aw-submods><aw-mod name="kid"><aw-content><aw-insts></aw-insts></aw-content></aw-mod></aw-submods>
			</aw-tb-mod>`,
		);
		const errs = check(doc, { unitKind: "sim" }).errors.join("\n");
		expect(errs).toContain("aw-tb-mod@deps");
		expect(errs).toContain("forbids aw-params");
		expect(errs).toContain("forbids aw-ports");
		expect(errs).toContain("must not contain aw-submods");
		const withInc = docOf(
			`<aw-mod name="m" body-pre-include="x.svh"><aw-content><aw-insts></aw-insts></aw-content></aw-mod>`,
		);
		expect(
			check(withInc, { unitKind: "connect" }).errors.some((e) =>
				e.includes("body-*-include"),
			),
		).toBe(true);
	});

	test("type=raw only in aw-tb-mod; no net; snapshot carries raw", () => {
		const leaf = leafOf([{ name: "probe", dir: "input" }]);
		const inMod = docOf(
			`<aw-mod name="m"><aw-content><aw-insts>
				<aw-inst id="u" mod="leaf"><aw-template>
					<aw-connect port="probe" type="raw" to="tb.u.path"></aw-connect>
				</aw-template></aw-inst>
			</aw-insts></aw-content></aw-mod>`,
		);
		expect(
			check(inMod, ctxWith({ leaf }, { unitKind: "connect" })).errors.some(
				(e) => e.includes('type="raw"'),
			),
		).toBe(true);
		const tb = docOf(
			`<aw-tb-mod name="tb" body-pre-include="env.svh" body-post-include="stim.svh">
				<aw-content><aw-insts>
					<aw-inst id="u" mod="leaf"><aw-template>
						<aw-connect port="probe" type="raw" to="\${id}.deep"></aw-connect>
					</aw-template></aw-inst>
				</aw-insts></aw-content>
				<aw-render></aw-render>
			</aw-tb-mod>`,
		);
		const chk = check(tb, ctxWith({ leaf }, { unitKind: "sim" }));
		expect(chk.errors).toEqual([]);
		const res = elaborate(tb, ctxWith({ leaf }, { unitKind: "sim" }));
		expect(res.errors).toEqual([]);
		expect(tb.querySelector("aw-render aw-signal")).toBeNull();
		expect(
			tb
				.querySelector('aw-render aw-connect[port="probe"]')
				?.getAttribute("type"),
		).toBe("raw");
		expect(
			tb
				.querySelector('aw-render aw-connect[port="probe"]')
				?.getAttribute("to"),
		).toBe("u.deep");
		const snap = serializeSnapshot(tb);
		expect(snap).toContain("aw-tb-mod");
		expect(snap).toContain('body-pre-include="env.svh"');
		expect(snap).toContain('body-post-include="stim.svh"');
		expect(snap).toContain('type="raw"');
		expect(tb.querySelector("aw-render aw-port")).toBeNull();
	});
});
