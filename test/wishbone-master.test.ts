import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Bus,
	isBridgedMaster,
	Master,
	Slave,
	SlaveBus,
} from "../src/plugins/wishbone-bus/dsl.ts";
import { busModuleName, emitBusSv } from "../src/plugins/wishbone-bus/emit.ts";
import {
	emitBusSystemSv,
	type WrapperStyle,
} from "../src/plugins/wishbone-bus/emit-attach.ts";
import {
	emitBusIcl,
	emitBusPdl,
	jtagDrWidth,
	MASTER_MODULES,
} from "../src/plugins/wishbone-bus/emit-master.ts";
import {
	generateMasterModules,
	generatePipeModule,
} from "../src/plugins/wishbone-bus/generate.ts";
import { ShadowDomain } from "../src/plugins/wishbone-regfile/dsl.ts";
import { verilatorSim, verilatorTest } from "./fixtures/verilator.ts";

const ALIGNED: WrapperStyle = {
	portAlign: true,
	signalAlign: true,
	instPortAlign: true,
	instParamAlign: true,
	netType: "logic",
};

function mb(tagWidth?: number, pipe = 0) {
	return Bus("mb", "master bridge demo", {
		masters: [
			Master("cpu", "fabric-clock WB", { pipe }),
			Master("host", "SoC APB", {
				apb: { pprot: { value: 0, mask: 0b001 } },
				cdc: true,
				timeout: 64,
			}),
			Master("dbg", "DFT JTAG", { jtag: true }),
			Master("wbx", "async WB", { cdc: true, timeout: 64, pipe }),
		],
		slaves: [Slave("mem", "TB memory", 0x0000, 0xf000, tagWidth)],
		addrWidth: 16,
		...(tagWidth ? { tagWidth } : {}),
	});
}

describe("wishbone master bridges", () => {
	test("Master options: defaults and validation", () => {
		expect(Master("cpu", "x")).toEqual({ name: "cpu", desc: "x", pipe: 0 });
		expect(isBridgedMaster(Master("cpu", "x"))).toBe(false);
		const j = Master("dbg", "x", { jtag: true });
		expect(j).toMatchObject({ bridge: "jtag", cdc: true, idle: 16 });
		const a = Master("host", "x", { apb: true });
		expect(a).toMatchObject({ bridge: "apb", cdc: false });
		expect(isBridgedMaster(a)).toBe(true);
		expect(
			Master("host", "x", { apb: { pprot: { value: 0b010, mask: 0b010 } } })
				.pprot,
		).toEqual({ value: 0b010, mask: 0b010 });
		expect(() => Master("m", "x", { apb: true, jtag: true })).toThrow(
			/both apb and jtag/,
		);
		expect(() => Master("m", "x", { jtag: true, cdc: false })).toThrow(
			/always crosses/,
		);
		expect(() => Master("m", "x", { timeout: 8 })).toThrow(/needs cdc/);
		expect(() =>
			Master("m", "x", { apb: { pprot: { value: 0b100, mask: 0b001 } } }),
		).toThrow(/outside mask/);
		expect(() => Master("m", "x", { jtag: { idle: 0 } })).toThrow(/idle/);
	});

	test("Bus rejects duplicate masters and a bridged cascade face", () => {
		const slaves = [Slave("s", "s", 0, 0xf000)];
		expect(() =>
			Bus("b", "b", {
				addrWidth: 16,
				masters: [Master("a", "a"), Master("a", "a")],
				slaves,
			}),
		).toThrow(/duplicate master/);
		// A bridged master cannot serve as the cascade face.
		const bridged = Bus("b", "b", {
			addrWidth: 16,
			masters: [Master("cfg", "u", { cdc: true })],
			slaves,
		});
		expect(() => bridged.uplink("cfg")).toThrow(/cascade face/);
		const child = Bus("child", "c", {
			addrWidth: 16,
			masters: [Master("up2", "u", { apb: true })],
			slaves,
		});
		expect(() => SlaveBus(child.uplink("up2"), 0)).toThrow(/cascade face/);
	});

	test("wrapper hides bridged fabric ports and exposes native faces", () => {
		const def = mb();
		const sv = emitBusSystemSv(def, ALIGNED) ?? "";
		expect(sv).toContain("module mb_bus_cfg (");
		expect(sv).toMatch(/^\tinput\s+logic\s+host_pclk/m);
		expect(sv).toMatch(/^\toutput\s+logic\s+host_pslverr/m);
		expect(sv).toMatch(/^\toutput\s+logic\s+dbg_tdo/m);
		expect(sv).toMatch(/^\tinput\s+logic\s+dbg_en/m);
		expect(sv).toMatch(/^\toutput\s+logic\s+wbx_i_wb_err/m);
		expect(sv).toMatch(/^\tinput\s+logic\s+\[15:0\]\s*cpu_o_wb_adr/m);
		expect(sv).not.toContain("input  logic [15:0] host_o_wb_adr");
	});

	test("named inherited tags remain separate public inputs on async WB masters", () => {
		const bank = ShadowDomain("bank", 4, 2);
		const way = ShadowDomain("way", 2, 1);
		const slaves = [Slave("s", "s", 0, 0xf000, { tag: 3 })];
		const dec = emitBusSystemSv(
			Bus("td", "decoder tags", {
				addrWidth: 16,
				tags: [bank, way],
				masters: [Master("cfg", "async wb", { cdc: true })],
				slaves,
			}),
			ALIGNED,
		);
		expect(dec ?? "").not.toContain("cfg_o_wb_tga_tag");
		expect(dec).toMatch(/^\s*input\s+logic\s+\[1:0\]\s+cfg_o_wb_tga_bank\b/m);
		expect(dec).toMatch(/^\s*input\s+logic\s+cfg_o_wb_tga_way\b/m);
		const ic = emitBusSystemSv(
			Bus("ti", "interconnect tags", {
				addrWidth: 16,
				tags: [bank, way],
				masters: [
					Master("cpu", "local"),
					Master("cfg", "async wb", { cdc: true }),
				],
				slaves,
			}),
			ALIGNED,
		);
		expect(ic ?? "").not.toContain("cfg_o_wb_tga_tag");
		expect(ic).toMatch(/^\s*input\s+logic\s+\[1:0\]\s+cfg_o_wb_tga_bank\b/m);
		expect(ic).toMatch(/^\s*input\s+logic\s+cfg_o_wb_tga_way\b/m);
	});

	test("only native WB masters expose inherited tag inputs", () => {
		const sv = emitBusSystemSv(mb(4), ALIGNED) ?? "";
		expect(sv).toMatch(/^\tinput\s+logic\s+\[3:0\]\s*wbx_o_wb_tga_tag/m);
		expect(sv).not.toMatch(/^\s*input\s+.*\b(?:host|dbg)_o_wb_tga_tag\b/m);
	});

	test("APB without cdc exposes no additional clock or WB face", () => {
		const def = Bus("one", "single apb master", {
			addrWidth: 16,
			masters: [Master("host", "APB", { apb: true })],
			slaves: [Slave("s", "s", 0, 0xf000)],
		});
		const sv = emitBusSystemSv(def, ALIGNED) ?? "";
		expect(sv).not.toContain("host_pclk");
		expect(sv).toMatch(/^\s*input\s+logic\s+host_psel\b/m);
		expect(sv).toMatch(/^\s*output\s+logic\s+host_pslverr\b/m);
		expect(sv).not.toMatch(/^\s*input\s+.*\bhost_o_wb_adr\b/m);
	});

	test("ICL / PDL for JTAG masters only", () => {
		const def = mb();
		const icl = emitBusIcl(def) ?? "";
		expect(jtagDrWidth(def)).toBe(50);
		expect(icl).toContain("Module mb_bus_cfg {");
		expect(icl).toContain("ScanInterface dbg {");
		expect(icl).toContain("ScanRegister dbg_dr[49:0] {");
		expect(icl).not.toContain("host_");
		const pdl = emitBusPdl(def) ?? "";
		expect(pdl).toContain("iProcsForModule mb_bus_cfg");
		expect(pdl).toContain("iRunLoop 16 -tck");
		const plain = Bus("p", "p", {
			addrWidth: 16,
			masters: [Master("host", "APB", { apb: true, cdc: true })],
			slaves: [Slave("s", "s", 0, 0xf000)],
		});
		expect(emitBusIcl(plain)).toBeNull();
		expect(emitBusPdl(plain)).toBeNull();
	});

	for (const half of [3, 11]) {
		verilatorTest(
			`CDC recovery: late ACK, stopped clock and resets (${half})`,
			() => {
				const dir = mkdtempSync(join(tmpdir(), "aw-cdc-recovery-"));
				const tb = join(dir, "tb.sv");
				writeFileSync(
					tb,
					`
module tb;
logic s_clk=0, clk=0, running=1, s_rst_n=0, rst_n=0;
always #5 s_clk=~s_clk;
always #${half} if(running) clk=~clk;
logic cyc=0, ack, err, mc, ms, mw, ma=0;
logic [7:0] adr=0, maddr;
logic [31:0] rd, md, response=0;
logic [3:0] sel;
logic tag;
logic reject_response=0;
always @(posedge s_clk) begin
 if(reject_response && ack) $fatal(1,"stale ACK completed retry");
end
wb_cdc #(.AW(8), .TIMEOUT(32)) dut(
.s_clk(s_clk), .s_rst_n(s_rst_n), .s_cyc(cyc), .s_stb(cyc),
.s_we(1'b0), .s_adr(adr), .s_dat(32'd0), .s_sel(4'hf), .s_tga(1'b0),
.s_ack(ack), .s_err(err), .s_rdat(rd), .clk(clk), .rst_n(rst_n),
.m_cyc(mc), .m_stb(ms), .m_we(mw), .m_adr(maddr), .m_dat(md),
.m_sel(sel), .m_tga(tag), .m_ack(ma), .m_rdat(response));
task settle; repeat(40) @(negedge s_clk); endtask
task launch(input logic [7:0] a);
 @(negedge s_clk); adr=a; cyc=1;
endtask
task drop; @(negedge s_clk); cyc=0; endtask
task finish_old;
 @(negedge clk); response=32'haaaa; ma=1;
 @(negedge clk); ma=0;
endtask
task good;
 launch(8'hb0);
 wait(mc);
 if(maddr!==8'hb0) $fatal(1,"wrong new address");
 @(negedge clk); response=32'hbbbb; ma=1;
 @(negedge clk); ma=0;
 wait(ack || err);
 if(err || rd!==32'hbbbb) $fatal(1,"new transaction got old response");
 drop(); settle();
endtask
initial begin
 #1; s_rst_n=0; rst_n=0;
 #20; s_rst_n=1; rst_n=1; settle();
 // Immediate retry must never turn the old response into a successful new beat.
 launch(8'ha0); wait(mc); wait(err); drop(); reject_response=1; launch(8'hb0);
 repeat(8) @(negedge s_clk);
 finish_old();
 repeat(8) begin @(negedge s_clk); if(ack) $fatal(1,"stale ACK completed retry"); end
 drop(); settle(); reject_response=0; good();
 // Timeout before capture: no old ACK will ever arrive.
 @(negedge clk); running=0;
 launch(8'ha0); wait(err); drop();
 running=1; settle(); good();
 // Source-only reset preserves a captured target request until its ACK.
 launch(8'ha0); wait(mc);
 @(negedge s_clk); s_rst_n=0; cyc=0;
 repeat(3) @(negedge s_clk); s_rst_n=1;
 reject_response=1; launch(8'hb0); repeat(8) @(negedge s_clk);
 finish_old();
 repeat(8) begin @(negedge s_clk); if(ack) $fatal(1,"reset stale ACK"); end
 drop(); settle(); reject_response=0; good();
 // Target-only reset invalidates the old request and establishes recovery.
 launch(8'ha0); wait(mc);
 @(negedge s_clk); #1; rst_n=0;
 #2; rst_n=1;
 wait(err); drop(); settle(); good();
 // A held target reset must not hold the source ERR register in reset.
 @(negedge s_clk); rst_n=0;
 launch(8'ha0);
 repeat(4) @(negedge s_clk);
 if(ack || mc) $fatal(1,"transaction during target reset");
 wait(err); drop();
 if(rst_n) $fatal(1,"test released reset too early");
 @(negedge s_clk); rst_n=1;
 settle(); good();
 $display("PASS"); $finish;
end
initial begin #100000; $fatal(1,"watchdog"); end
endmodule
`,
				);
				const cdc = join(
					import.meta.dir,
					"../docs/plugins/rtl/wb_cdc_template.sv",
				);
				const r = verilatorSim({
					dir: join(dir, "obj"),
					top: "tb",
					sources: [
						tb,
						cdc,
						join(
							import.meta.dir,
							"../docs/plugins/rtl/wb_sync_cell_template.sv",
						),
					],
				});
				expect(r.buildOk, r.buildLog).toBe(true);
				expect(r.exitCode, r.stdout + r.stderr).toBe(0);
				expect(r.stdout).toContain("PASS");
			},
			180_000,
		);
	}

	for (const change of ["none", "cyc", "stb", "we", "adr", "sel", "tga"]) {
		verilatorTest(
			`PIPE read contract: ${change}`,
			() => {
				const dir = mkdtempSync(join(tmpdir(), "aw-pipe-contract-"));
				const tb = join(dir, "tb.sv");
				const mutation: Record<string, string> = {
					none: "",
					cyc: "cyc=0;",
					stb: "stb=0;",
					we: "we=1;",
					adr: "adr=8'h44;",
					sel: "sel=0;",
					tga: "tag=1;",
				};
				writeFileSync(
					tb,
					`
module tb;
logic clk=0, rst_n=0;
always #5 clk=~clk;
logic cyc=0, stb=0, we=0, ack, sc, ss, sw, tag=0, st;
logic [7:0] adr=0, sa;
logic [3:0] sel=15, sl;
logic [31:0] rd, sd;
logic leaf_ack=0;
wb_cfg_pipe #(.AW(8), .PIPE(2)) dut(
.clk(clk), .rst_n(rst_n), .m_cyc(cyc), .m_stb(stb), .m_we(we),
.m_adr(adr), .m_dat(32'd0), .m_sel(sel), .m_tga(tag),
.m_ack(ack), .m_rdat(rd), .s_cyc(sc), .s_stb(ss), .s_we(sw),
.s_adr(sa), .s_dat(sd), .s_sel(sl), .s_tga(st),
.s_ack(leaf_ack && ss), .s_rdat(32'h1234));
initial begin
 #1; rst_n=0; #19; rst_n=1;
 @(negedge clk); cyc=1; stb=1;
 repeat(4) @(negedge clk);
 ${mutation[change]}
 repeat(2) @(negedge clk);
 leaf_ack=1;
 do @(posedge clk); while(!ack);
 @(negedge clk); cyc=0; stb=0;
 repeat(8) @(negedge clk);
 // Posted write can drop the request immediately after its ACK.
 we=1; cyc=1; stb=1; adr=8'h20;
 do @(posedge clk); while(!ack);
 @(negedge clk); cyc=0; stb=0;
 repeat(8) @(negedge clk);
 // Reset releases the read-hold obligation.
 leaf_ack=0; we=0; cyc=1; stb=1;
 repeat(4) @(negedge clk);
 rst_n=0; cyc=0; stb=0; adr=0;
 repeat(2) @(negedge clk); rst_n=1;
 repeat(4) @(negedge clk);
 $display("PASS"); $finish;
end
initial begin #10000; $fatal(1,"watchdog"); end
endmodule
`,
				);
				const r = verilatorSim({
					dir: join(dir, "obj"),
					top: "tb",
					sources: [
						tb,
						join(
							import.meta.dir,
							"../docs/plugins/rtl/wb_cfg_pipe_template.sv",
						),
					],
				});
				expect(r.buildOk, r.buildLog).toBe(true);
				if (change === "none") {
					expect(r.exitCode, r.stdout + r.stderr).toBe(0);
					expect(r.stdout).toContain("PASS");
				} else {
					expect(r.exitCode).not.toBe(0);
					expect(r.stdout + r.stderr).toContain(
						"read request changed before ACK",
					);
				}
			},
			180_000,
		);
	}

	verilatorTest(
		"verilator: APB / JTAG / async WB masters through wb_cdc",
		async () => {
			const def = mb(3, 1).uplink("cpu");
			const dir = mkdtempSync(join(tmpdir(), "aw-wbm-"));
			const fabric = join(dir, `${busModuleName(def)}.sv`);
			const system = join(dir, "mb_bus_cfg.sv");
			writeFileSync(fabric, emitBusSv(def));
			writeFileSync(system, emitBusSystemSv(def, ALIGNED) ?? "");
			const mods = await generateMasterModules(dir);
			expect(mods.length).toBe(MASTER_MODULES.length);
			const pipe = await generatePipeModule(dir);
			if (!pipe) throw new Error("wb_cfg_pipe was not written");
			const tb = join(import.meta.dir, "fixtures/wb_master_tb.sv");
			const r = verilatorSim({
				dir: join(dir, "obj"),
				top: "tb",
				sources: [tb, system, fabric, pipe, ...mods],
			});
			expect(r.buildLog).not.toContain("%Error");
			expect(r.buildOk).toBe(true);
			expect(r.stdout).not.toContain("FAIL");
			expect(r.stdout).toContain("PASS");
			expect(r.exitCode).toBe(0);
		},
		180_000,
	);
});
