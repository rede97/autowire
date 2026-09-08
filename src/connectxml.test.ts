import { describe, expect, test } from "bun:test";
import { connectXml, parseConnectXml } from "./connectxml.ts";
import { parseSnapshot } from "./printer.ts";

// The connect XML sidecar mirrors hdxml conventions minus timestamps/hashes.

const SNAP = `<autowire>
  <aw-mod name="zeta">
    <aw-render>
      <aw-ports><aw-port dir="input" name="z_i"></aw-port></aw-ports>
    </aw-render>
  </aw-mod>
  <aw-mod name="alpha">
    <aw-render>
      <aw-params><aw-param name="W" value="8"></aw-param></aw-params>
      <aw-imports><aw-import package="cc_pkg" symbol="*"></aw-import></aw-imports>
      <aw-ports>
        <aw-port dir="output" name="data_o" packed="[W-1:0]" nettype="logic"></aw-port>
        <aw-port dir="input" name="clk_i"></aw-port>
        <aw-port dir="interface" name="s_axi" interface="axi_if" modport="slave"></aw-port>
      </aw-ports>
    </aw-render>
  </aw-mod>
</autowire>`;

describe("connect XML sidecar", () => {
	test("sorted modules, hdxml-style tags, no timestamps or hashes", () => {
		const xml = connectXml("u1", parseSnapshot(SNAP));
		// modules sorted by name (alpha before zeta)
		expect(xml.indexOf('name="alpha"')).toBeLessThan(
			xml.indexOf('name="zeta"'),
		);
		// direction via tag name, not a dir attribute
		expect(xml).toContain(
			'<output name="data_o" packed="[W-1:0]" nettype="logic"/>',
		);
		expect(xml).toContain(
			'<interface name="s_axi" interface="axi_if" modport="slave"/>',
		);
		expect(xml).toContain('<param name="W" value="8"/>');
		expect(xml).toContain('<import package="cc_pkg" symbol="*"/>');
		// no provenance fields (deterministic, diff-friendly)
		expect(xml).not.toMatch(/generated|Hash|Fp|mtime/);
	});

	test("roundtrip preserves the abstract module info", () => {
		const mods = parseConnectXml(connectXml("u1", parseSnapshot(SNAP)));
		expect(mods.map((m) => m.name)).toEqual(["alpha", "zeta"]);
		const alpha = mods[0];
		expect(alpha?.params).toEqual([{ name: "W", value: "8" }]);
		// the parser regroups by direction tag (named connects make port order
		// non-semantic); the XML document itself keeps declaration order
		expect(alpha?.ports.find((p) => p.name === "data_o")).toMatchObject({
			dir: "output",
			packed: "[W-1:0]",
			nettype: "logic",
		});
		expect(alpha?.ports.find((p) => p.name === "s_axi")).toMatchObject({
			dir: "interface",
			interface: "axi_if",
			modport: "slave",
		});
		expect(alpha?.imports).toEqual([{ package: "cc_pkg", symbol: "*" }]);
	});
});
