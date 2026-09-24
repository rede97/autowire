import { describe, expect, test } from "bun:test";
import type { RenderModule } from "../src/core/printer.ts";
import {
	assertPrintable,
	flattenModules,
	parseSnapshot,
	printSv,
} from "../src/core/printer.ts";

// Printer contract: snapshot XML → SV text (docs/connect/html.md §4, help dump).

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

const TWO_INSTS = `<autowire>
  <aw-mod name="pair">
    <aw-render>
      <aw-insts>
        <aw-inst id="u_a" mod="a">
          <aw-connect port="clk" to="clk_i"></aw-connect>
          <aw-connect port="data_valid" to="v"></aw-connect>
        </aw-inst>
        <aw-inst id="u_b" mod="b">
          <aw-connect port="rst" to="rst_n_sync_long"></aw-connect>
          <aw-connect port="q" type="open"></aw-connect>
        </aw-inst>
      </aw-insts>
    </aw-render>
  </aw-mod>
</autowire>`;

const MIXED = `<autowire>
  <aw-mod name="mix">
    <aw-render>
      <aw-insts>
        <aw-inst id="u_a" mod="a">
          <aw-param name="W" value="8"></aw-param>
          <aw-param name="DEPTH_LOG2" value="4"></aw-param>
          <aw-connect port="clk" to="clk_i"></aw-connect>
        </aw-inst>
        <aw-inst id="u_b" mod="b">
          <aw-param name="N" value="MIX_N_DEFAULT"></aw-param>
          <aw-connect port="data_valid_in" to="v"></aw-connect>
        </aw-inst>
      </aw-insts>
    </aw-render>
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

	test("printSv instPortAlign aligns both ( and ) of inst port maps", () => {
		const sv = printSv(parseSnapshot(SNAP)[0] as RenderModule, "u1", {
			instPortAlign: true,
		});
		// longest port name is 4 ("w_in"), longest connection 10 ("{48{1'b1}}")
		expect(sv).toContain(".d   (arr[2]    ),");
		expect(sv).toContain(".en  (32'h0     ),");
		expect(sv).toContain(".clk (clk_i     ),");
		expect(sv).toContain(".w_in(W         ),");
		expect(sv).toContain(".init({48{1'b1}}),");
		expect(sv).toContain(".dbg (          )");
		// default (off) keeps the compact form
		const plain = printSv(parseSnapshot(SNAP)[0] as RenderModule, "u1");
		expect(plain).toContain(".clk(clk_i),");
	});

	test("printSv instPortAlign columns are shared by every instance in the file", () => {
		const sv = printSv(parseSnapshot(TWO_INSTS)[0] as RenderModule, "u1", {
			instPortAlign: true,
		});
		const conns = sv.split("\n").filter((l) => l.startsWith("\t\t."));
		expect(conns).toHaveLength(4);
		expect(new Set(conns.map((l) => l.indexOf("("))).size).toBe(1);
		expect(new Set(conns.map((l) => l.lastIndexOf(")"))).size).toBe(1);
		// u_a is padded to u_b's longer connection and vice versa
		expect(sv).toContain(`.clk${" ".repeat(7)}(clk_i${" ".repeat(10)}),`);
		expect(sv).toContain(`.data_valid(v${" ".repeat(14)})`);
		expect(sv).toContain(`.rst${" ".repeat(7)}(rst_n_sync_long),`);
		expect(sv).toContain(`.q${" ".repeat(9)}(${" ".repeat(15)})`);
	});

	test("printSv instParamAlign aligns ( and ) of param overrides file-wide", () => {
		const sv = printSv(parseSnapshot(MIXED)[0] as RenderModule, "u1", {
			instParamAlign: true,
		});
		// longest param name 10 ("DEPTH_LOG2"), longest value 13 ("MIX_N_DEFAULT")
		expect(sv).toContain(`.W${" ".repeat(9)}(8${" ".repeat(12)}),`);
		expect(sv).toContain(`.DEPTH_LOG2(4${" ".repeat(12)})`);
		expect(sv).toContain(`.N${" ".repeat(9)}(MIX_N_DEFAULT)`);
		// port maps stay compact when only params align
		expect(sv).toContain(".clk(clk_i)");
		expect(sv).toContain(".data_valid_in(v)");
		const plain = printSv(parseSnapshot(SNAP)[0] as RenderModule, "u1");
		expect(plain).toContain(".Width(top__u0__Width)");
	});

	test("printSv inst port + param align share one column pair", () => {
		const sv = printSv(parseSnapshot(MIXED)[0] as RenderModule, "u1", {
			instPortAlign: true,
			instParamAlign: true,
		});
		const rows = sv.split("\n").filter((l) => l.startsWith("\t\t."));
		expect(rows).toHaveLength(5);
		expect(new Set(rows.map((l) => l.indexOf("("))).size).toBe(1);
		expect(new Set(rows.map((l) => l.lastIndexOf(")"))).size).toBe(1);
		// name column from port "data_valid_in" (13), value column from param
		// "MIX_N_DEFAULT" (13)
		expect(sv).toContain(`.W${" ".repeat(12)}(8${" ".repeat(12)}),`);
		expect(sv).toContain(`.data_valid_in(v${" ".repeat(12)})`);
		expect(sv).toContain(`.clk${" ".repeat(10)}(clk_i${" ".repeat(8)})`);
	});

	test("printSv portAlign aligns declaration port columns", () => {
		const sv = printSv(parseSnapshot(SNAP)[0] as RenderModule, "u1", {
			portAlign: true,
		});
		// dir padded to 6 ("output"), type to 5 ("logic"), packed column
		// padded to 7 ("[W-1:0]"); names left-aligned at one column
		expect(sv).toContain("input  wire          clk_i,");
		expect(sv).toContain("output wire  [W-1:0] data_o");
	});

	test("printSv signalAlign aligns signal declaration columns", () => {
		const sv = printSv(parseSnapshot(SNAP)[0] as RenderModule, "u1", {
			signalAlign: true,
		});
		// packed column width = "[W-1:0]" (7)
		expect(sv).toContain("logic [W-1:0] mid;");
		expect(sv).toContain("wire  [7:0]   arr [0:3];");
	});

	test("printSv paramAlign aligns declaration parameter = column", () => {
		const sv = printSv(parseSnapshot(SNAP)[0] as RenderModule, "u1", {
			paramAlign: true,
		});
		expect(sv).toContain("parameter W = 8");
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

	test("aw-tb-mod: portless module, logic nets, includes, raw RHS", () => {
		const snap = `<autowire>
  <aw-tb-mod name="tb_top" body-pre-include="env.svh" body-post-include="stim.svh">
    <aw-render tb="1" body-pre-include="env.svh" body-post-include="stim.svh">
      <aw-localparams>
        <aw-localparam name="IDLE" value="1'b1"></aw-localparam>
      </aw-localparams>
      <aw-signals>
        <aw-signal name="clk"></aw-signal>
        <aw-signal name="bus" packed="[31:0]"></aw-signal>
      </aw-signals>
      <aw-insts>
        <aw-inst id="u0" mod="dut">
          <aw-connect port="clk" to="clk"></aw-connect>
          <aw-connect port="probe" to="tb_top.u0.irq" type="raw"></aw-connect>
          <aw-connect port="dbg" type="open"></aw-connect>
        </aw-inst>
      </aw-insts>
    </aw-render>
  </aw-tb-mod>
</autowire>`;
		const m = parseSnapshot(snap)[0];
		if (!m) throw new Error("no tb module");
		expect(m.isTb).toBe(true);
		expect(m.bodyPreInclude).toEqual(["env.svh"]);
		expect(m.bodyPostInclude).toEqual(["stim.svh"]);
		const sv = printSv(m, "soc_tb");
		expect(sv).toContain("sim HTML");
		expect(sv).toContain("module tb_top;");
		expect(sv).toContain('`include "env.svh"');
		expect(sv).toContain('`include "stim.svh"');
		expect(sv).toContain("logic clk;");
		expect(sv).toContain("logic [31:0] bus;");
		expect(sv).toContain(".probe(tb_top.u0.irq)");
		expect(sv).toContain(".dbg()");
		expect(sv).not.toContain("module tb_top (");
		expect(sv).not.toContain("input ");
	});
});
