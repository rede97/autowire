import { describe, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
import {
	busModuleName,
	emitBusSv,
	listFabricPorts,
} from "../src/plugins/wishbone-bus/emit.ts";
import { generatePipeModule } from "../src/plugins/wishbone-bus/generate.ts";
import { verilatorSim, verilatorTest } from "./fixtures/verilator.ts";

type Fabric = "decoder" | "interconnect" | "crossbar";

function topology(kind: Fabric, depth: number, masterPipe: number) {
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
				masters: kind === "decoder" ? masters.slice(0, 1) : masters,
				slaves: [...subscribers, other],
			});
}

// Bind public fabric ports only; the scoreboard never reads DUT internals.
function instance(def: ReturnType<typeof topology>, kind: Fabric) {
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
		else if (kind === "decoder" && name.startsWith("m_")) {
			signal =
				name === "m_dat_o"
					? "rdata"
					: name === "m_ack_o"
						? "ack"
						: signals[name.slice(2).replace(/_i$/, "")];
		} else if (name.startsWith("host_")) {
			signal =
				name === "host_i_wb_dat"
					? "rdata"
					: name === "host_i_wb_ack"
						? "ack"
						: signals[name.replace("host_o_wb_", "")];
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
	return `${busModuleName(def)} dut (\n${connections.join(",\n")}\n);`;
}

describe("wishbone broadcast behavior", () => {
	const cases: [Fabric, number, number][] = [];
	for (const kind of ["decoder", "interconnect", "crossbar"] as const) {
		for (const depth of [0, 1, 2]) cases.push([kind, depth, 0]);
	}
	// Exercise inherited tags through the grouped master arbiter and its pipe.
	cases.push(
		["crossbar", 0, 1],
		["crossbar", 0, 2],
		["crossbar", 1, 1],
		["crossbar", 2, 2],
	);
	for (const [kind, depth, masterPipe] of cases) {
		verilatorTest(
			`${kind}: subscriber pipe=${depth}, master pipe=${masterPipe}`,
			async () => {
				const def = topology(kind, depth, masterPipe);
				const dir = mkdtempSync(join(tmpdir(), "aw-broadcast-"));
				const fabric = join(dir, "fabric.sv");
				// Capture this emitter revision before awaiting pipe generation.
				writeFileSync(fabric, emitBusSv(def));
				const fixture = readFileSync(
					join(import.meta.dir, "fixtures/wb_broadcast_tb.sv"),
					"utf8",
				)
					.replace("__DEPTH__", String(depth))
					.replace("__MASTER_PIPE__", String(masterPipe))
					.replace("__DUT__", instance(def, kind));
				const tb = join(dir, "tb.sv");
				writeFileSync(tb, fixture);
				const pipe = await generatePipeModule(dir);
				expect(pipe).not.toBeNull();
				const result = verilatorSim({
					dir: join(dir, "obj"),
					top: "tb",
					sources: [tb, fabric, pipe ?? ""],
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
