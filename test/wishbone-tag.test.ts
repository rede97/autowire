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
		expect(plan.addrMask).toBe(0x0060_0000);
		expect(plan.inherited).toHaveLength(0);
		const sv = emitBusSv(hbm);
		expect(sv).toContain("assign g_tga_pstate = m_adr_i[22:21];");
		expect(sv).toContain("assign g_adr_dec = g_adr & ~32'h00600000;");
		// Tag bits are stripped before compare and before forwarding.
		expect(sv).toContain("if ((g_adr_dec & 32'hfffff000) == 32'h00000000)");
		expect(sv).toContain("ch0_i_wb_adr  = slot_sel[SLOT_CH0]  ? g_adr_dec");
		expect(sv).not.toContain("m_tga_pstate");
	});

	test("pass-through level inherits the tag and never re-derives it", () => {
		const plan = tagPlan(hbm_ch);
		expect(plan.inherited).toHaveLength(1);
		expect(plan.addrMask).toBe(0);
		const sv = emitBusSv(hbm_ch);
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
			tags: [TagFromAddr(pstate, "13:12")],
			masters: [Master("uplink", "from parent")],
			slaves: [SlaveRegfile(aword, 0x000, { size: Size(0x100) })],
		});
		expect(() =>
			Bus("parent_dup", "also produces pstate", {
				tags: [TagFromAddr(pstate, "22:21")],
				masters: [Master("cfg", "cfg")],
				slaves: [SlaveBus(child, 0, { size: Size(0x1000) })],
			}),
		).toThrow(/produced by bus "parent_dup" and again by "child_dup"/);
	});

	test("tag address bits may not land inside a slave window", () => {
		expect(() =>
			Bus("clash", "tag bit inside the window", {
				tags: [TagFromAddr(pstate, "5:4")],
				masters: [Master("cfg", "cfg")],
				slaves: [SlaveRegion("blk", "block", 0x0, Size(0x1000))],
			}),
		).toThrow(/fall inside slave "blk" window/);
	});

	test("one bus cannot declare the same domain twice", () => {
		expect(() =>
			Bus("twice", "duplicate domain", {
				tags: [TagFromAddr(pstate, "22:21"), TagFromPin(pstate)],
				masters: [Master("cfg", "cfg")],
				slaves: [SlaveRegion("blk", "block", 0x0, Size(0x100))],
			}),
		).toThrow(/declares tag domain "pstate" twice/);
	});

	test("TagFromPin adds a fabric input port for the domain", () => {
		const pinned = Bus("pinned", "pstate from a controller pin", {
			tags: [TagFromPin(pstate)],
			masters: [Master("cfg", "cfg")],
			slaves: [SlaveRegfile(aword, 0x000, { size: Size(0x100) })],
		});
		const sv = emitBusSv(pinned);
		expect(sv).toContain("pstate_tag_i");
		expect(sv).toContain("assign g_tga_pstate = pstate_tag_i;");
		expect(sv).not.toContain("m_tga_pstate");
	});
});
