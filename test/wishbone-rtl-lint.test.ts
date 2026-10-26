// Generated Wishbone RTL must be clean under `verilator --lint-only -Wall`.
// Skipped when verilator (and make, via verilatorTest) is not on PATH.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../demo/soc/sot/wb_reg_sha256.ts";
import {
	Bus,
	Crossbar,
	Master,
	MasterGroup,
	Size,
	SlaveGroup,
	SlaveRegfile,
	SlaveRegion,
} from "../src/plugins/wishbone-bus/dsl.ts";
import { busModuleName, emitBusSv } from "../src/plugins/wishbone-bus/emit.ts";
import {
	emitBusSystemSv,
	type WrapperStyle,
} from "../src/plugins/wishbone-bus/emit-attach.ts";
import { generatePipeModule } from "../src/plugins/wishbone-bus/generate.ts";
import { emitRegfileSv } from "../src/plugins/wishbone-regfile/emit.ts";
import { layoutRegfile } from "../src/plugins/wishbone-regfile/layout.ts";
import { verilatorLint, verilatorTest } from "./fixtures/verilator.ts";
import { smoke_rw } from "./fixtures/wb_reg_access.ts";

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
		const cdc = [
			join(socBus, "wb_cdc.sv"),
			join(socBus, "wb_async_fifo.sv"),
			join(socBus, "wb_sync_cell.sv"),
		];
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
			join(hbmBus, "wb_async_fifo.sv"),
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

const LINT_STYLE: WrapperStyle = { netType: "logic" };

verilatorTest(
	"external regfile hang stitches back above the wrapper and is -Wall clean",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "aw_ext_lint_"));
		try {
			const pipeOut = await generatePipeModule(dir, true);
			if (!pipeOut) throw new Error("wb_cfg_pipe was not written");
			// One inline leaf (stays in the wrapper) + one external leaf (exported WB).
			const bus = Bus("ext_mix", "inline + external regfiles", {
				addrWidth: 12,
				masters: [Master("cfg", "config")],
				slaves: [
					SlaveRegfile(smoke_rw, 0x000, { id: "inline" }),
					SlaveRegfile(sha256, 0x040, { external: true, pipe: 1 }),
				],
			});
			const fabric = join(dir, `${busModuleName(bus)}.sv`);
			writeFileSync(fabric, emitBusSv(bus));
			const wrapper = join(dir, "ext_mix_bus_cfg.sv");
			writeFileSync(wrapper, emitBusSystemSv(bus, LINT_STYLE) ?? "");
			const leaf = join(dir, "sha256_regfile.sv");
			writeFileSync(leaf, emitRegfileSv(layoutRegfile(sha256)));
			const inlineLeaf = join(dir, "smoke_rw_regfile.sv");
			writeFileSync(inlineLeaf, emitRegfileSv(layoutRegfile(smoke_rw)));
			// A tiny top wires the exported WB back to the external leaf, proving
			// the wrapper's sha256_i/o_wb_* ports connect to a real leaf instance.
			const top = join(dir, "ext_mix_top.sv");
			writeFileSync(
				top,
				`module ext_mix_top (
	input  logic        clk,
	input  logic        rst_n,
	input  logic [11:0] cfg_o_wb_adr,
	input  logic [31:0] cfg_o_wb_dat,
	input  logic [3:0]  cfg_o_wb_sel,
	input  logic        cfg_o_wb_cyc,
	input  logic        cfg_o_wb_stb,
	input  logic        cfg_o_wb_we,
	output logic [31:0] cfg_i_wb_dat,
	output logic        cfg_i_wb_ack,
	output logic        inline_rg_enable,
	output logic [2:0]  inline_rg_mode,
	output logic        sha_rg_soft_reset,
	output logic        sha_p_rg_done_clear,
	input  logic        sha_ro_busy,
	input  logic        sha_ro_done,
	input  logic [31:0] sha_ro_hash0,
	input  logic [31:0] sha_ro_hash1,
	input  logic [31:0] sha_ro_hash2,
	input  logic [31:0] sha_ro_hash3,
	input  logic [31:0] sha_ro_hash4,
	input  logic [31:0] sha_ro_hash5,
	input  logic [31:0] sha_ro_hash6,
	input  logic [31:0] sha_ro_hash7
);
	logic [11:0] sha256_i_wb_adr;
	logic [31:0] sha256_i_wb_dat;
	logic [3:0]  sha256_i_wb_sel;
	logic        sha256_i_wb_cyc;
	logic        sha256_i_wb_stb;
	logic        sha256_i_wb_we;
	logic [31:0] sha256_o_wb_dat;
	logic        sha256_o_wb_ack;
	ext_mix_bus_cfg u_cfg (
		.clk(clk), .rst_n(rst_n),
		.cfg_o_wb_adr(cfg_o_wb_adr), .cfg_o_wb_dat(cfg_o_wb_dat),
		.cfg_o_wb_sel(cfg_o_wb_sel), .cfg_o_wb_cyc(cfg_o_wb_cyc),
		.cfg_o_wb_stb(cfg_o_wb_stb), .cfg_o_wb_we(cfg_o_wb_we),
		.cfg_i_wb_dat(cfg_i_wb_dat), .cfg_i_wb_ack(cfg_i_wb_ack),
		.inline_rg_enable(inline_rg_enable), .inline_rg_mode(inline_rg_mode),
		.sha256_i_wb_adr(sha256_i_wb_adr), .sha256_i_wb_dat(sha256_i_wb_dat),
		.sha256_i_wb_sel(sha256_i_wb_sel), .sha256_i_wb_cyc(sha256_i_wb_cyc),
		.sha256_i_wb_stb(sha256_i_wb_stb), .sha256_i_wb_we(sha256_i_wb_we),
		.sha256_o_wb_dat(sha256_o_wb_dat), .sha256_o_wb_ack(sha256_o_wb_ack)
	);
	sha256_regfile u_sha (
		.i_clk(clk), .i_rst_n(rst_n),
		.sha256_i_wb_cyc(sha256_i_wb_cyc), .sha256_i_wb_stb(sha256_i_wb_stb),
		.sha256_i_wb_we(sha256_i_wb_we), .sha256_i_wb_adr({20'd0, sha256_i_wb_adr}),
		.sha256_i_wb_dat(sha256_i_wb_dat), .sha256_i_wb_sel(sha256_i_wb_sel),
		.sha256_o_wb_ack(sha256_o_wb_ack), .sha256_o_wb_dat(sha256_o_wb_dat),
		.rg_soft_reset(sha_rg_soft_reset), .p_rg_done_clear(sha_p_rg_done_clear),
		.ro_busy(sha_ro_busy), .ro_done(sha_ro_done),
		.ro_hash0(sha_ro_hash0), .ro_hash1(sha_ro_hash1),
		.ro_hash2(sha_ro_hash2), .ro_hash3(sha_ro_hash3),
		.ro_hash4(sha_ro_hash4), .ro_hash5(sha_ro_hash5),
		.ro_hash6(sha_ro_hash6), .ro_hash7(sha_ro_hash7)
	);
endmodule
`,
			);
			lint(
				"ext_mix_top",
				[top, wrapper, fabric, leaf, inlineLeaf, pipeOut],
				["-Wno-WIDTHEXPAND"],
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
	120_000,
);
