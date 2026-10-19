import { describe, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Bus,
	type BusDef,
	Crossbar,
	Master,
	MasterGroup,
	Size,
	SlaveGroup,
	SlaveRegion,
} from "../src/plugins/wishbone-bus/dsl.ts";
import {
	emitBusSv,
	listFabricPorts,
} from "../src/plugins/wishbone-bus/emit.ts";
import { emitBusSystemSv } from "../src/plugins/wishbone-bus/emit-attach.ts";
import { generatePipeModule } from "../src/plugins/wishbone-bus/generate.ts";
import { verilatorSim, verilatorTest } from "./fixtures/verilator.ts";

type Fabric = "decoder" | "interconnect" | "crossbar";

function topology(
	kind: Fabric,
	depth: number,
	masterPipe: number,
	defaultMaster?: "omitted" | "empty",
) {
	const masters = [
		Master("host", "Classic test driver", { pipe: masterPipe }),
		Master("idle", "Second master"),
	];
	const subscribers = [
		SlaveRegion("a", "Slow subscriber", 0, Size(0x100), {
			pipe: depth,
			tag: 2,
			broadcastBy: ["all"],
		}),
		SlaveRegion("b", "Fast subscriber", 0x100, Size(0x100), {
			pipe: depth,
			tag: 2,
			broadcastBy: ["all"],
		}),
		SlaveRegion("all", "Broadcast window", 0x200, Size(0x100), {
			broadcast: "all",
		}),
	];
	const other = SlaveRegion(
		"other",
		"Independent target",
		0x1000,
		Size(0x100),
		{
			tag: 2,
		},
	);
	return kind === "crossbar"
		? Crossbar("broadcast_test", "Broadcast behavior", {
				addrWidth: 16,
				tagWidth: 2,
				masters: [
					MasterGroup("cpu", masters),
					MasterGroup("dma", [Master("dma", "Independent master group")]),
				],
				slaves: [
					SlaveGroup("control", subscribers),
					SlaveGroup("memory", [other]),
				],
			})
		: Bus("broadcast_test", "Broadcast behavior", {
				addrWidth: 16,
				tagWidth: 2,
				...(defaultMaster === "omitted"
					? {}
					: {
							masters:
								defaultMaster === "empty"
									? []
									: kind === "decoder"
										? masters.slice(0, 1)
										: masters,
						}),
				slaves: [...subscribers, other],
			});
}

// Bind public wrapper ports only; the scoreboard never reads DUT internals.
function instance(def: BusDef) {
	const master = def.masters[0]?.name;
	const signals: Record<string, string> = {
		adr: "adr",
		dat: "wdata",
		sel: "4'hf",
		cyc: "cyc",
		stb: "stb",
		we: "we",
		tga_tag: "tag",
	};
	const connections = listFabricPorts(def).map((port) => {
		const name = port.name;
		let signal: string | undefined;
		if (name === "clk" || name === "rst_n") signal = name;
		else if (name === "rb_grant_en") signal = "1'b1";
		else if (name.startsWith(`${master}_`)) {
			signal =
				name === `${master}_i_wb_dat`
					? "rdata"
					: name === `${master}_i_wb_ack`
						? "ack"
						: signals[name.replace(`${master}_o_wb_`, "")];
		} else if (/^(idle|dma)_/.test(name)) {
			signal = port.dir === "input" ? "'0" : "";
		} else {
			const match = /^(a|b|other)_(i|o)_wb_(.*)$/.exec(name);
			if (match) {
				const index = ["a", "b", "other"].indexOf(match[1] ?? "");
				const suffix = match[3];
				const field =
					match[2] === "o"
						? suffix === "dat"
							? "rdata"
							: "ack"
						: suffix === "dat"
							? "wdata"
							: suffix === "tga_tag"
								? "tag"
								: suffix;
				signal = `s_${field}[${index}]`;
			}
		}
		if (signal === undefined) throw new Error(`Unbound fabric port: ${name}`);
		return `.${name}(${signal})`;
	});
	return `${def.name}_bus_cfg dut (\n${connections.join(",\n")}\n);`;
}

describe("wishbone broadcast behavior", () => {
	const cases: [Fabric, number, number, ("omitted" | "empty")?][] = [];
	for (const kind of ["decoder", "interconnect", "crossbar"] as const) {
		for (const depth of [0, 1, 2]) cases.push([kind, depth, 0]);
	}
	// Exercise tags through master pipes and each named cascade wrapper.
	for (const kind of ["decoder", "interconnect", "crossbar"] as const) {
		cases.push([kind, 0, 1], [kind, 0, 2], [kind, 1, 1], [kind, 2, 2]);
	}
	cases.push(["decoder", 0, 0, "omitted"], ["decoder", 1, 0, "empty"]);
	for (const [kind, depth, masterPipe, defaultMaster] of cases) {
		verilatorTest(
			`${kind} wrapper: subscriber pipe=${depth}, master pipe=${masterPipe}, master=${defaultMaster ?? "host"}`,
			async () => {
				const def = topology(kind, depth, masterPipe, defaultMaster).uplink(
					defaultMaster ? "m" : "host",
				);
				const dir = mkdtempSync(join(tmpdir(), "aw-broadcast-"));
				const fabric = join(dir, "fabric.sv");
				// Capture this emitter revision before awaiting pipe generation.
				writeFileSync(fabric, emitBusSv(def));
				const system = join(dir, "system.sv");
				const wrapper = emitBusSystemSv(def, {
					portAlign: true,
					signalAlign: true,
					instPortAlign: true,
					instParamAlign: true,
					netType: "logic",
				});
				if (!wrapper) throw new Error("Cascade wrapper was not emitted");
				writeFileSync(system, wrapper);
				const fixture = readFileSync(
					join(import.meta.dir, "fixtures/wb_broadcast_tb.sv"),
					"utf8",
				)
					.replace("__DEPTH__", String(depth))
					.replace("__MASTER_PIPE__", String(masterPipe))
					.replace("__DUT__", instance(def));
				const tb = join(dir, "tb.sv");
				writeFileSync(tb, fixture);
				const pipe = await generatePipeModule(dir);
				expect(pipe).not.toBeNull();
				const result = verilatorSim({
					dir: join(dir, "obj"),
					top: "tb",
					sources: [tb, system, fabric, pipe ?? ""],
				});
				if (!result.buildOk) throw new Error(result.buildLog);
				expect(result.stdout + result.stderr).not.toContain("FAIL");
				expect(result.stdout).toContain("PASS broadcast behavior");
				expect(result.exitCode).toBe(0);
			},
			180_000,
		);
	}
});
