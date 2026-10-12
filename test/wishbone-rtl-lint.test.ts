// Generated Wishbone RTL must be clean under `verilator --lint-only -Wall`.
// Skipped when verilator (and make, via verilatorTest) is not on PATH.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Bus,
	Crossbar,
	Master,
	MasterGroup,
	Size,
	SlaveGroup,
	SlaveRegion,
} from "../src/plugins/wishbone-bus/dsl.ts";
import { busModuleName, emitBusSv } from "../src/plugins/wishbone-bus/emit.ts";
import { generatePipeModule } from "../src/plugins/wishbone-bus/generate.ts";
import { verilatorLint, verilatorTest } from "./fixtures/verilator.ts";

const root = join(import.meta.dir, "..");
const soc = join(root, "demo/soc/rtl/gen/plugins/wishbone");
const hbm = join(root, "demo/hbm/rtl/gen/plugins/wishbone");

verilatorTest(
	"broadcast collectors are -Wall clean at every fabric shape",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "aw_bcast_lint_"));
		try {
			const pipeOut = await generatePipeModule(dir, true);
			if (!pipeOut) throw new Error("wb_cfg_pipe was not written");
			for (const depth of [0, 1, 2]) {
				const slaves = [
					SlaveRegion("a", "a", 0, Size(0x100), {
						pipe: depth,
						broadcastBy: ["all"],
					}),
					SlaveRegion("b", "b", 0x100, Size(0x100), {
						pipe: depth,
						broadcastBy: ["all"],
					}),
					SlaveRegion("win", "win", 0x200, Size(0x100), { broadcast: "all" }),
				];
				const masters = [Master("m", "m")];
				const opts = { addrWidth: 16, masters, slaves };
				const defs = [
					Bus("dec", "decoder", opts),
					Bus("ic", "interconnect", {
						...opts,
						masters: [...masters, Master("n", "n")],
					}),
					Crossbar("xb", "singleton crossbar", {
						...opts,
						slaves: [SlaveGroup("ctrl", slaves)],
					}),
				];
				for (const def of defs) {
					const top = busModuleName(def);
					const sv = join(dir, `${top}.sv`);
					writeFileSync(sv, emitBusSv(def));
					lint(top, [sv, pipeOut]);
				}
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
	120_000,
);

function lint(top: string, sources: string[], args?: string[]): void {
	const r = verilatorLint({ top, sources, args });
	if (r.exitCode !== 0 || /%(Warning|Error)/.test(r.log)) {
		throw new Error(`${top} is not -Wall clean:\n${r.log}`);
	}
}

verilatorTest(
	"demo and crossbar Wishbone RTL is -Wall clean",
	async () => {
		const socBus = join(soc, "bus");
		const hbmBus = join(hbm, "bus");
		const pipe = join(socBus, "wb_cfg_pipe.sv");
		const cdc = [join(socBus, "wb_cdc.sv"), join(socBus, "wb_sync_cell.sv")];
		lint("soc_wb_bus_cfg", [
			join(socBus, "soc_wb_bus_cfg.sv"),
			join(socBus, "soc_wb_interconnect.sv"),
			pipe,
			...cdc,
			join(socBus, "wb_jtag_tdr.sv"),
			join(soc, "regfile/smoke_regfile.sv"),
		]);
		// The leaf ADR port is the regfile's own addr_width. The fabric drives the
		// window offset, which is narrower, so the stitch zero-extends.
		const stitch = ["-Wno-WIDTHEXPAND"];
		lint(
			"sd_sha_bus_cfg",
			[
				join(socBus, "sd_sha_bus_cfg.sv"),
				join(socBus, "sd_sha_interconnect.sv"),
				pipe,
				join(soc, "regfile/sha256_regfile.sv"),
			],
			stitch,
		);
		lint("hbm_bus_cfg", [
			join(hbmBus, "hbm_bus_cfg.sv"),
			join(hbmBus, "hbm_interconnect.sv"),
			join(hbmBus, "wb_cdc.sv"),
			join(hbmBus, "wb_sync_cell.sv"),
			join(hbmBus, "wb_apb2wb.sv"),
			join(hbm, "regfile/center_regfile.sv"),
		]);
		lint(
			"hbm_ch_bus_cfg",
			[
				join(hbmBus, "hbm_ch_bus_cfg.sv"),
				join(hbmBus, "hbm_ch_decoder.sv"),
				join(hbm, "regfile/aword_regfile.sv"),
				join(hbm, "regfile/dword_regfile.sv"),
			],
			stitch,
		);
		lint("wb_cfg_pipe", [pipe]);
		lint("wb_cdc", cdc);

		const dir = mkdtempSync(join(tmpdir(), "aw_wb_lint_"));
		const xb = Crossbar("xb", "grouped crossbar", {
			addrWidth: 16,
			masters: [
				MasterGroup("cpu", [
					Master("cpu_i", "ifetch"),
					Master("cpu_d", "data"),
				]),
				Master("dma", "dma engine"),
			],
			slaves: [
				SlaveGroup("ctrl", [
					SlaveRegion("gpio", "gpio", 0x0000, Size(0x100)),
					SlaveRegion("uart", "uart", 0x0100, Size(0x100)),
				]),
				SlaveRegion("mem", "scratch", 0x8000, Size(0x8000), { pipe: 1 }),
			],
		});
		const sv = join(dir, "xb_crossbar.sv");
		writeFileSync(sv, emitBusSv(xb));
		const pipeOut = await generatePipeModule(dir, true);
		if (!pipeOut) throw new Error("wb_cfg_pipe was not written");
		lint("xb_crossbar", [sv, pipeOut]);
	},
	120_000,
);
