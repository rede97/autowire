// HBM software-map check.
// Reads the generated C map and uvm_reg block and checks them against the
// address the fabric actually decodes: channel = ADR[15:12], pstate =
// ADR[18:17], directly above the windows. Bits above the tag are discarded.
// Broadcast windows are real addresses. No UVM simulator is required.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const c = readFileSync(resolve(root, "fw/gen/wishbone/hbm_map.h"), "utf8");
const uvm = readFileSync(resolve(root, "dv/ral/ral_block_hbm.sv"), "utf8");
const ch = readFileSync(resolve(root, "dv/ral/ral_block_hbm_ch.sv"), "utf8");

const CH = 0x1000;
const PSTATE = 1 << 17;
const errors: string[] = [];

function fail(msg: string): void {
	errors.push(msg);
}

function need(hay: string, needle: string, where: string): void {
	if (!hay.includes(needle)) fail(`${where} missing ${needle}`);
}

for (let chn = 0; chn < 16; chn++) {
	for (let ps = 0; ps < 4; ps++) {
		const base = chn * CH + ps * PSTATE;
		const tag = `ch${chn}_pstate${ps}`;
		need(c, `#define HBM_${tag.toUpperCase()}_AWORD_BASE 0x${base.toString(16).padStart(8, "0")}u`, "C");
		need(
			c,
			`#define HBM_${tag.toUpperCase()}_DWORD0_BASE 0x${(base + 0x100).toString(16).padStart(8, "0")}u`,
			"C",
		);
		need(
			c,
			`#define HBM_${tag.toUpperCase()}_DWORD_BCAST_BASE 0x${(base + 0x300).toString(16).padStart(8, "0")}u`,
			"C",
		);
		need(uvm, `add_submap(this.${tag}.default_map, 32'h${base.toString(16).padStart(8, "0")})`, "uvm");
	}
}

const bcast = 16 * CH;
need(c, `#define HBM_CH_BCAST_BASE 0x${bcast.toString(16).padStart(8, "0")}u`, "C");
need(c, "broadcast ch_all", "C");

// The child only passes pstate through, so its own block is not copied;
// regfile leaves hang as shared leaf blocks (one class per sheet).
const childCopies = ch.match(/_pstate/g);
if (childCopies) fail(`hbm_ch uvm block was split per pstate (${childCopies.length})`);
need(ch, "add_submap(this.aword.default_map, 32'h00000000", "child uvm");
need(ch, "add_submap(this.dword0.default_map, 32'h00000100", "child uvm");
need(ch, "broadcast dword_all", "child uvm");
// One leaf block class per sheet, shared by both dword hangs.
const leaf = readFileSync(resolve(root, "dv/ral/ral_DWORD.sv"), "utf8");
const leafDefs = leaf.match(/^class ral_block_dword /gm) ?? [];
if (leafDefs.length !== 1) fail(`ral_block_dword defined ${leafDefs.length} times`);
if (!c.includes("cell shadow pstate")) fail("C lost the cell shadow note");

if (errors.length > 0) {
	console.error(errors.join("\n"));
	process.exit(1);
}
console.log("hbm map: 16 channels x 4 pstates, broadcast, and shared child block");
