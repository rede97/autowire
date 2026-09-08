import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DOMParser } from "linkedom";
import { check, elaborate, serializeSnapshot } from "../src/core/aw.ts";

// The docs examples (docs/examples/connect/) are executable author faces.
// These tests elaborate each with a fictional leaf ctx matching the example's
// intent and lock the documented render shape (signals / ports / parts).

const EX = join(import.meta.dir, "..", "docs", "examples", "connect");

async function authorDoc(name: string): Promise<Document> {
	const text = await readFile(join(EX, name), "utf8");
	return new DOMParser().parseFromString(
		text,
		"text/xml",
	) as unknown as Document;
}

interface LeafSpec {
	params?: { name: string; defaultText?: string }[];
	ports: { name: string; dir: string; packed?: string; unpacked?: string }[];
}

function ctxWith(leaves: Record<string, LeafSpec>) {
	return {
		leaf: (m: string) => {
			const l = leaves[m];
			if (!l) return null;
			return {
				params: (l.params ?? []).map((p) => ({
					name: p.name,
					kind: "parameter",
					defaultText: p.defaultText ?? null,
				})),
				ports: l.ports.map((p) => ({
					name: p.name,
					dir: p.dir,
					dataType: "logic",
					packed: p.packed ?? null,
					unpacked: p.unpacked ?? null,
				})),
				imports: [],
			};
		},
	};
}
describe("docs examples elaborate (locked golden shape)", () => {
	test("02-author-nested: submod renders independently", async () => {
		const doc = await authorDoc("02-author-nested.html");
		const ctx = ctxWith({
			leaf_x: {
				ports: [
					{ name: "clk", dir: "input" },
					{ name: "data_i", dir: "input", packed: "[7:0]" },
				],
			},
			leaf_y: {
				ports: [
					{ name: "clk", dir: "input" },
					{ name: "data_i", dir: "input", packed: "[7:0]" },
				],
			},
		});
		expect(check(doc, ctx).errors).toEqual([]);
		expect(elaborate(doc, ctx).errors).toEqual([]);
		const blk = doc.querySelector('aw-mod[name="blk_a"]');
		expect(blk?.querySelector("aw-render aw-inst")?.getAttribute("id")).toBe(
			"u0",
		);
	});

	test("03-author-template-reuse: overwrite wins; shared bus parts; inout auto-export", async () => {
		const doc = await authorDoc("03-author-template-reuse.html");
		const ctx = ctxWith({
			lane_slice: {
				ports: [
					{ name: "clk", dir: "input" },
					{ name: "data", dir: "inout", packed: "[7:0]" },
					{ name: "dbg", dir: "output" },
				],
			},
		});
		expect(check(doc, ctx).errors).toEqual([]);
		expect(elaborate(doc, ctx).errors).toEqual([]);
		const insts = [...doc.querySelectorAll("aw-render aw-inst")];
		expect(insts.map((i) => i.getAttribute("id"))).toEqual([
			"u_lane0",
			"u_lane1",
		]);
		const conn = (id: string, port: string) =>
			insts
				.find((i) => i.getAttribute("id") === id)
				?.querySelector(`aw-connect[port="${port}"]`);
		expect(conn("u_lane0", "data")?.getAttribute("part")).toBe("7:0");
		expect(conn("u_lane1", "data")?.getAttribute("part")).toBe("15:8");
		expect(conn("u_lane1", "dbg")?.getAttribute("to")).toBe("lane_1_dbg");
		// base wildcard rewrite ^(.+)$ also maps dbg → lane_dbg on idx 0
		expect(conn("u_lane0", "dbg")?.getAttribute("to")).toBe("lane_dbg");
		// inout net auto-exports as inout port with the bus width
		const bus = doc.querySelector('aw-render aw-port[name="lane_data_bus"]');
		expect(bus?.getAttribute("dir")).toBe("inout");
		expect(bus?.getAttribute("packed")).toBe("[15:0]");
		const snap = serializeSnapshot(doc);
		expect(snap).not.toContain("aw-rewrite");
		expect(snap).not.toContain("aw-template");
	});

	test("04-author-multidim: packed+unpacked dims and part selects survive", async () => {
		const doc = await authorDoc("04-author-multidim.html");
		const ctx = ctxWith({
			mem_bank: {
				ports: [
					{ name: "rdata", dir: "output", packed: "[63:0]" },
					{ name: "lane", dir: "output", packed: "[3:0]" },
					{ name: "word", dir: "output", packed: "[31:0]" },
				],
			},
		});
		expect(check(doc, ctx).errors).toEqual([]);
		expect(elaborate(doc, ctx).errors).toEqual([]);
		const sig = (n: string) =>
			doc.querySelector(`aw-render aw-signal[name="${n}"]`);
		expect(sig("bank_0_rdata")?.getAttribute("packed")).toBe("[63:0]");
		expect(sig("lane_matrix")?.getAttribute("packed")).toBe("[7:0][3:0]");
		expect(sig("scratch_mem")?.getAttribute("packed")).toBe("[31:0]");
		expect(sig("scratch_mem")?.getAttribute("unpacked")).toBe("[0:255]");
		const parts = [...doc.querySelectorAll("aw-render aw-connect[part]")].map(
			(c) => `${c.getAttribute("port")}=${c.getAttribute("part")}`,
		);
		expect(parts).toContain("lane=[0]");
		expect(parts).toContain("lane=[1]");
		expect(parts).toContain("word=[0]");
	});

	test("05-author-const: constants inline, only real nets become signals", async () => {
		const doc = await authorDoc("05-author-const.html");
		const ctx = ctxWith({
			cfg_reg: {
				ports: [
					{ name: "clk", dir: "input" },
					{ name: "en_i", dir: "input" },
					{ name: "mode_i", dir: "input", packed: "[1:0]" },
					{ name: "init_i", dir: "input", packed: "[7:0]" },
					{ name: "test_mode_i", dir: "input" },
					{ name: "test_scan_i", dir: "input" },
					{ name: "dout_o", dir: "output", packed: "[7:0]" },
				],
			},
		});
		expect(check(doc, ctx).errors).toEqual([]);
		expect(elaborate(doc, ctx).errors).toEqual([]);
		// only "clk" is a real net; constants never enter aw-signals
		const sigs = [...doc.querySelectorAll("aw-render aw-signal")].map((s) =>
			s.getAttribute("name"),
		);
		expect(sigs).toEqual(["clk"]);
		const inst1 = [...doc.querySelectorAll("aw-render aw-inst")].find(
			(i) => i.getAttribute("id") === "u_cfg_1",
		);
		const conn = (port: string) =>
			inst1?.querySelector(`aw-connect[port="${port}"]`)?.getAttribute("to");
		expect(conn("en_i")).toBe("`CFG_EN");
		expect(conn("mode_i")).toBe("MODE");
		expect(conn("init_i")).toBe("{1{INIT_VAL}}");
		expect(conn("test_mode_i")).toBe("1'b0");
	});

	test("06-author-open: open pins never enter signals; override back to net", async () => {
		const doc = await authorDoc("06-author-open.html");
		const ctx = ctxWith({
			dbg_core: {
				ports: [
					{ name: "clk", dir: "input" },
					{ name: "dbg_main_o", dir: "output" },
					{ name: "dbg_aux_o", dir: "output", packed: "[3:0]" },
					{ name: "stat_o", dir: "output", packed: "[1:0]" },
				],
			},
		});
		expect(check(doc, ctx).errors).toEqual([]);
		expect(elaborate(doc, ctx).errors).toEqual([]);
		const sigs = [...doc.querySelectorAll("aw-render aw-signal")].map((s) =>
			s.getAttribute("name"),
		);
		expect(sigs).toEqual(["clk", "stat_0", "dbg_aux_1", "stat_1"]);
		const core0 = [...doc.querySelectorAll("aw-render aw-inst")].find(
			(i) => i.getAttribute("id") === "u_core_0",
		);
		const core1 = [...doc.querySelectorAll("aw-render aw-inst")].find(
			(i) => i.getAttribute("id") === "u_core_1",
		);
		expect(
			core0
				?.querySelector('aw-connect[port="dbg_aux_o"]')
				?.getAttribute("type"),
		).toBe("open");
		// later rule wins: dbg_aux_o is a net again on idx 1
		expect(
			core1?.querySelector('aw-connect[port="dbg_aux_o"]')?.getAttribute("to"),
		).toBe("dbg_aux_1");
	});
});
