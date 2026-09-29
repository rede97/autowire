import { describe, expect, test } from "bun:test";
import {
	connectJson,
	connectXml,
	parseConnectJson,
	parseConnectXml,
} from "../src/core/connectxml.ts";
import { parseSnapshot } from "../src/core/printer.ts";

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
		// direction via the dir attribute; ports stay in declaration order
		expect(xml).toContain(
			'<port name="data_o" dir="output" packed="[W-1:0]" nettype="logic"/>',
		);
		expect(xml).toContain(
			'<port name="s_axi" dir="interface" interface="axi_if" modport="slave"/>',
		);
		expect(xml).toContain('<param name="W" value="8"/>');
		expect(xml).toContain('<import package="cc_pkg" symbol="*"/>');
		// no provenance fields (deterministic, diff-friendly)
		expect(xml).not.toMatch(/generated|Hash|Fp|mtime/);
	});

	test("JSON mirror roundtrips to the same facts as XML", () => {
		const mods = parseSnapshot(SNAP);
		const viaXml = parseConnectXml(connectXml("u1", mods));
		const viaJson = parseConnectJson(connectJson("u1", mods));
		expect(viaJson).toEqual(viaXml);
		// no provenance fields, deterministic
		const again = connectJson("u1", parseSnapshot(SNAP));
		expect(connectJson("u1", mods)).toBe(again);
		expect(again).not.toMatch(/generated|Hash|Fp|mtime/);
	});

	test("roundtrip preserves the abstract module info", () => {
		const mods = parseConnectXml(connectXml("u1", parseSnapshot(SNAP)));
		expect(mods.map((m) => m.name)).toEqual(["alpha", "zeta"]);
		const alpha = mods[0];
		expect(alpha?.params).toEqual([{ name: "W", value: "8" }]);
		// port order is semantic (it keys the connect sort in writeRender), so
		// the roundtrip must keep declaration order
		expect(alpha?.ports.map((p) => p.name)).toEqual([
			"data_o",
			"clk_i",
			"s_axi",
		]);
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
