import { describe, expect, test } from "bun:test";
import { hbm, hbm_ch } from "../demo/hbm/sot/wb_bus_hbm.ts";
import { aword } from "../demo/hbm/sot/wb_reg_aword.ts";
import { dword } from "../demo/hbm/sot/wb_reg_dword.ts";
import { pstate } from "../demo/hbm/sot/wb_tag_pstate.ts";
import {
	Bus,
	Master,
	Size,
	SlaveBus,
	SlaveRegfile,
	SlaveRegion,
	TagFromAddr,
	TagFromPin,
} from "../src/plugins/wishbone-bus/dsl.ts";
import { emitBusSv } from "../src/plugins/wishbone-bus/emit.ts";
import { tagPlan } from "../src/plugins/wishbone-bus/tag.ts";
import { ShadowDomain } from "../src/plugins/wishbone-regfile/dsl.ts";

// Contract: docs/plugins/wishbone-bus.md 2.1 (tag domain: share / source / strip).

describe("wishbone tag domains", () => {
	test("one ShadowDomain is shared by both tables", () => {
		expect(pstate.copies).toBe(4);
		for (const def of [aword, dword]) {
			expect(def.shadows).toHaveLength(1);
			expect(def.shadows[0]?.name).toBe("pstate");
			expect(def.shadows[0]?.copies).toBe(pstate.copies);
			expect(def.shadows[0]?.tag_width).toBe(pstate.tag_width);
		}
	});

	test("domain remap is shared by every regfile", () => {
		const domain = ShadowDomain("pstate", 4, 2).remap({ 3: 0b1111 });
		expect(domain.remapMap?.[3]).toBe(0b1111);
		expect(() => ShadowDomain("pstate", 4, 2).remap({ 4: 0b0001 })).toThrow(
			/exceeds width/,
		);
	});

	test("producing level: tag comes from ADR and leaves the master face bare", () => {
		const plan = tagPlan(hbm);
		expect(plan.width).toBe(2);
		expect(plan.addrMask).toBe(0x0006_0000);
		expect(plan.inherited).toHaveLength(0);
		const sv = emitBusSv(hbm);
		expect(sv).toContain("assign g_tga_pstate = g_adr[18:17];");
		expect(sv).toContain("assign g_adr_dec = g_adr & 19'h1ffff;");
		// Tag bits are stripped before compare and before forwarding.
		expect(sv).toContain("if ((g_adr_dec & 19'h7f000) == 19'h01000)");
		expect(sv).toContain(
			"ch0_i_wb_adr    = (slot_sel[SLOT_CH0] || broadcast_ch_all)",
		);
		expect(sv).not.toContain("m_tga_pstate");
		expect(sv).not.toContain("cfg_o_wb_tga");
	});

	test("pass-through level inherits the tag and never re-derives it", () => {
		const plan = tagPlan(hbm_ch);
		expect(plan.inherited).toHaveLength(1);
		expect(plan.addrMask).toBe(0);
		const sv = emitBusSv(hbm_ch);
		// Decoder body declares its request bundle (no implicit nets) and the
		// inherited tag arrives on the flat master port.
		expect(sv).toContain("logic [11:0] g_adr;");
		expect(sv).toContain("assign g_up_pstate = m_tga_pstate;");
		expect(sv).toContain("assign g_tga_pstate = g_up_pstate;");
		expect(sv).not.toContain("g_adr_dec");
		expect(sv).toContain("assign aword_i_wb_tga_pstate");
	});

	test("SlaveBus tag is derived from the child, and a wrong one is rejected", () => {
		const hang = hbm.slaves.find((s) => s.name === "ch0");
		expect(hang?.tag).toBe(hbm_ch.tag_width);
		expect(() =>
			SlaveBus(hbm_ch, 0, { id: "bad", size: Size(0x1000), tag: 1 }),
		).toThrow(/tag 1 != child/);
	});

	test("a domain may be produced only once along a path", () => {
		const child = Bus("child_dup", "re-derives pstate", {
			addrWidth: 12,
			tags: [TagFromAddr(pstate, "9:8")],
			masters: [Master("uplink", "from parent")],
			slaves: [SlaveRegfile(aword, 0x000, { size: Size(0x100) })],
		});
		expect(() =>
			Bus("parent_dup", "also produces pstate", {
				addrWidth: 16,
				tags: [TagFromAddr(pstate, "13:12")],
				masters: [Master("cfg", "cfg")],
				slaves: [SlaveBus(child, 0, { size: Size(0x1000) })],
			}),
		).toThrow(/produced by bus "parent_dup" and again by "child_dup"/);
	});

	test("a tag that does not sit on the window cut is rejected", () => {
		expect(() =>
			Bus("high", "tag leaves unused bits below it", {
				addrWidth: 32,
				tags: [TagFromAddr(pstate, "31:30")],
				masters: [Master("cfg", "cfg")],
				slaves: [SlaveRegion("blk", "block", 0x0, Size(0x1000))],
			}),
		).toThrow(/must start at bit 12/);
	});

	test("tag address bits may not land inside a slave window", () => {
		expect(() =>
			Bus("clash", "tag bit inside the window", {
				addrWidth: 16,
				tags: [TagFromAddr(pstate, "5:4")],
				masters: [Master("cfg", "cfg")],
				slaves: [SlaveRegion("blk", "block", 0x0, Size(0x1000))],
			}),
		).toThrow(/must start at bit/);
	});

	test("one bus cannot declare the same domain twice", () => {
		expect(() =>
			Bus("twice", "duplicate domain", {
				addrWidth: 20,
				tags: [TagFromAddr(pstate, "18:17"), TagFromPin(pstate)],
				masters: [Master("cfg", "cfg")],
				slaves: [SlaveRegion("blk", "block", 0x0, Size(0x100))],
			}),
		).toThrow(/declares tag domain "pstate" twice/);
	});

	test("a tag bit past addrWidth is rejected", () => {
		// Window span 0x1000 cuts at bit 12, so [13:12] is on the cut.
		// addrWidth 13 only reaches bit 12, so the tag's high bit is out of range.
		expect(() =>
			Bus("wide", "tag past the allocated space", {
				addrWidth: 13,
				tags: [TagFromAddr(pstate, "13:12")],
				masters: [Master("cfg", "cfg")],
				slaves: [SlaveRegion("blk", "block", 0x0, Size(0x1000))],
			}),
		).toThrow(/exceeds addrWidth 13/);
	});

	test("TagFromPin adds a fabric input port for the domain", () => {
		const pinned = Bus("pinned", "pstate from a controller pin", {
			addrWidth: 12,
			tags: [TagFromPin(pstate)],
			masters: [Master("cfg", "cfg")],
			slaves: [SlaveRegfile(aword, 0x000, { size: Size(0x100) })],
		});
		const sv = emitBusSv(pinned);
		expect(sv).toContain("pstate_tag_i");
		expect(sv).toContain("assign g_tga_pstate = pstate_tag_i;");
		expect(sv).not.toContain("m_tga_pstate");
	});

	test("HBM region broadcast: write fan-out, read OR, no data port", () => {
		expect(hbm.slaves.find((s) => s.name === "ch_bcast")?.broadcast).toBe(
			"ch_all",
		);
		expect(hbm.slaves.find((s) => s.name === "ch0")?.broadcastBy).toEqual([
			"ch_all",
		]);
		expect(
			hbm_ch.slaves.find((s) => s.name === "aword")?.broadcastBy,
		).toBeUndefined();
		const parent = emitBusSv(hbm);
		const child = emitBusSv(hbm_ch);
		expect(parent).toContain(
			"assign broadcast_ch_all = (g_adr_dec & 19'h7f000) == 19'h11000;",
		);
		expect(parent).toContain("assign ch_all_off = g_adr_dec - 19'h11000;");
		expect(parent).toContain(
			"ch15_i_wb_cyc   = (slot_sel[SLOT_CH15] || broadcast_ch_all)",
		);
		expect(parent).toContain("broadcast_ch_all & ch0_o_wb_ack & ch1_o_wb_ack");
		expect(parent).toContain(
			"(({19{slot_sel[SLOT_CH0]}} & g_adr_dec) | ({19{broadcast_ch_all}} & ch_all_off)) & ~19'h7f000",
		);
		// Broadcast read ORs every subscriber's DAT; the window itself is not unmapped.
		expect(parent).toContain(
			"({32{broadcast_ch_all}} & (ch0_o_wb_dat | ch1_o_wb_dat",
		);
		expect(parent).toContain("(unmapped & g_stb & !(broadcast_ch_all))");
		expect(parent).not.toContain("ch_bcast_i_wb_");
		expect(parent).not.toContain("ch_bcast_o_wb_");
		expect(parent).not.toContain("SLOT_CH_BCAST");
		expect(child).toContain(
			"assign broadcast_dword_all = (g_adr & 12'hf00) == 12'h300;",
		);
		expect(child).toContain("assign dword_all_off = g_adr - 12'h300;");
		expect(child).toContain(
			"dword0_i_wb_cyc = (slot_sel[SLOT_DWORD0] || broadcast_dword_all)",
		);
		expect(child).toContain("aword_i_wb_cyc  = slot_sel[SLOT_AWORD]");
		expect(child).toContain(
			"(({12{slot_sel[SLOT_DWORD0]}} & g_adr) | ({12{broadcast_dword_all}} & dword_all_off)) & ~12'hf00",
		);
		expect(child).toContain(
			"({32{broadcast_dword_all}} & (dword0_o_wb_dat | dword1_o_wb_dat))",
		);
		expect(child).not.toContain("dword_bcast_i_wb_");
		expect(child).not.toContain("dword_bcast_o_wb_");
		expect(child).not.toContain("SLOT_DWORD_BCAST");
	});
});
