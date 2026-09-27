// HBM software-map check.
// Reads the generated C map, RALF, and uvm_reg block and checks them against
// the address the fabric actually decodes: channel = ADR[15:12], pstate =
// ADR[31:30] (top of the 32-bit address). A pass-through child is not split
// again. Broadcast windows are real addresses. No UVM simulator is required.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const c = readFileSync(resolve(root, "fw/gen/wishbone/hbm_map.h"), "utf8");
const ralf = readFileSync(resolve(root, "dv/ral/hbm.ralf"), "utf8");
const uvm = readFileSync(resolve(root, "dv/ral/ral_block_hbm.sv"), "utf8");
const ch = readFileSync(resolve(root, "dv/ral/ral_block_hbm_ch.sv"), "utf8");

const CH = 0x1000;
const PSTATE = 1 << 30;
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
		need(ralf, `block hbm_ch ${tag} @0x${base.toString(16)};`, "RALF");
		need(uvm, `add_submap(this.${tag}.default_map, 32'h${base.toString(16).padStart(8, "0")})`, "uvm");
	}
}

const bcast = 16 * CH;
need(c, `#define HBM_CH_BCAST_BASE 0x${bcast.toString(16).padStart(8, "0")}u`, "C");
need(c, "broadcast ch_all", "C");
need(ralf, `# ch_bcast @0x${bcast.toString(16)} broadcast ch_all`, "RALF");
if (ralf.includes("ch_bcast_pstate")) fail("broadcast window was split per pstate");

// The child only passes pstate through, so its own block is not copied.
const childCopies = ch.match(/_pstate/g);
if (childCopies) fail(`hbm_ch uvm block was split per pstate (${childCopies.length})`);
need(ch, "add_reg(this.aword_TIMING, 32'h00000008", "child uvm");
need(ch, "add_reg(this.dword0_VREF, 32'h00000108", "child uvm");
need(ch, "broadcast dword_all", "child uvm");

// One register type, many instances. pstate1 reuses the same aword_TIMING.
const defs = ralf.match(/^register aword_TIMING \{/gm) ?? [];
if (defs.length !== 1) fail(`aword_TIMING defined ${defs.length} times`);
const uses = ralf.match(/register aword_TIMING /g) ?? [];
if (uses.length < 2) fail("aword_TIMING was not instantiated");

if (!c.includes("cell shadow pstate")) fail("C lost the cell shadow note");

if (errors.length > 0) {
	console.error(errors.join("\n"));
	process.exit(1);
}
console.log("hbm map: 16 channels x 4 pstates, broadcast, and shared child block");
