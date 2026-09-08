import { describe, expect, test } from "bun:test";
import type { RenderModule } from "../src/core/printer.ts";
import {
	assertPrintable,
	flattenModules,
	parseSnapshot,
	printSv,
} from "../src/core/printer.ts";

// Printer contract: snapshot XML → SV text (docs/connect-html.md §4, help dump).

const SNAP = `<autowire>
  <aw-mod name="top">
    <aw-render>
      <aw-params>
        <aw-param name="W" value="8"></aw-param>
      </aw-params>
      <aw-imports>
        <aw-import package="cc_pkg" symbol="*"></aw-import>
      </aw-imports>
      <aw-localparams>
        <aw-localparam name="top__u0__Width" value="W" folded="false" for-inst="u0" for-param="Width"></aw-localparam>
      </aw-localparams>
      <aw-ports>
        <aw-port dir="input" name="clk_i"></aw-port>
        <aw-port dir="output" name="data_o" packed="[W-1:0]"></aw-port>
      </aw-ports>
      <aw-signals>
        <aw-signal name="clk_i"></aw-signal>
        <aw-signal name="mid" packed="[W-1:0]" nettype="logic"></aw-signal>
        <aw-signal name="arr" packed="[7:0]" unpacked="[0:3]"></aw-signal>
      </aw-signals>
      <aw-insts>
        <aw-inst id="u0" mod="leaf">
          <aw-param name="Width" value="top__u0__Width"></aw-param>
          <aw-connect port="clk" to="clk_i"></aw-connect>
          <aw-connect port="d" to="arr" part="[2]"></aw-connect>
          <aw-connect port="q" to="mid"></aw-connect>
          <aw-connect port="en" to="32'h0"></aw-connect>
          <aw-connect port="w_in" to="W"></aw-connect>
          <aw-connect port="init" to="{48{1'b1}}"></aw-connect>
          <aw-connect port="dbg" type="open"></aw-connect>
        </aw-inst>
      </aw-insts>
    </aw-render>
    <aw-mod name="kid">
      <aw-render>
        <aw-ports>
          <aw-port dir="interface" name="s_axi" interface="axi_if" modport="slave"></aw-port>
        </aw-ports>
      </aw-render>
    </aw-mod>
  </aw-mod>
</autowire>`;

describe("printer", () => {
	test("parseSnapshot reads all render groups", () => {
		const mods = parseSnapshot(SNAP);
		expect(mods).toHaveLength(1);
		const m = mods[0];
		if (!m) throw new Error("snapshot has no module");
		expect(m.name).toBe("top");
		expect(m.params).toEqual([{ name: "W", value: "8" }]);
		expect(m.imports).toEqual([{ package: "cc_pkg", symbol: "*" }]);
		expect(m.ports).toHaveLength(2);
		expect(m.signals).toHaveLength(3);
		const first = m.insts[0]?.connects[1];
		expect(first).toEqual({
			port: "d",
			to: "arr",
			part: "[2]",
			type: "",
		});
		expect(m.children[0]?.name).toBe("kid");
		expect(flattenModules(mods).map((x) => x.name)).toEqual(["top", "kid"]);
	});

	test("printSv emits module with params, imports, localparams, signals, insts", () => {
		const sv = printSv(parseSnapshot(SNAP)[0] as RenderModule, "u1");
		expect(sv).toContain("module top #(");
		expect(sv).toContain("parameter W = 8");
		expect(sv).toContain("input wire clk_i,");
		expect(sv).toContain("output wire [W-1:0] data_o");
		// import at module head, inside the module
		expect(sv).toMatch(/\);\n\timport cc_pkg::\*;/);
		expect(sv).toContain("localparam top__u0__Width = W;");
		// a net that is also a port is declared only once (by the port)
		expect(sv).not.toContain("wire clk_i;");
		expect(sv).toContain("logic [W-1:0] mid;");
		expect(sv).toContain("wire [7:0] arr [0:3];");
		expect(sv).toContain("leaf #(");
		expect(sv).toContain(".Width(top__u0__Width)");
		expect(sv).toContain(") u0 (");
		expect(sv).toContain(".clk(clk_i),");
		expect(sv).toContain(".d(arr[2]),");
		// constant tie-offs inline verbatim (no part-select wrapping)
		expect(sv).toContain(".en(32'h0),");
		expect(sv).toContain(".w_in(W),");
		expect(sv).toContain(".init({48{1'b1}})");
		// explicit dangling pin prints as an empty connection
		expect(sv).toContain(".dbg()");
	});

	test("interface ports print as type.modport", () => {
		const kid = parseSnapshot(SNAP)[0]?.children[0];
		if (!kid) throw new Error("snapshot has no child module");
		const sv = printSv(kid, "u1");
		expect(sv).toContain("axi_if.slave s_axi");
	});

	test("dump gate rejects leftover template/rewrite and missing render", () => {
		expect(() => assertPrintable(SNAP)).not.toThrow();
		expect(() =>
			assertPrintable("<autowire><aw-template></aw-template></autowire>"),
		).toThrow(/unclean render/);
		expect(() =>
			assertPrintable("<autowire><aw-rewrite></aw-rewrite></autowire>"),
		).toThrow(/unclean render/);
		expect(() => assertPrintable("<autowire></autowire>")).toThrow(
			/render first/,
		);
	});
});
