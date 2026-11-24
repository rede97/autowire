// fsm checker: author mistakes are compile errors with file:line:col.
import { describe, expect, test } from "bun:test";
import { compileBody } from "./fixtures/fsm/compile.ts";

/** Port pattern, one port per line: P("a = Input(1)", "b = Output(1)"). */
const P = (...ports: string[]) =>
	`{\n${ports.map((p) => `  ${p},`).join("\n")}\n}`;
const ports = P("go = Input(1)", "b = Input(1)", "x = Output(1)", "d = Dff(4)");
const ports1 = P(
	"go = Input(1)",
	"b = Input(1)",
	"x = Output(1)",
	"d = Dff(1)",
);
const fsm = (body: string, p = ports) => `@Fsm\nasync f(${p}) {\n${body}\n}`;
const sub = `async s(${P("a = Input(1)")}) { W: await a.wait(1); return a; }`;
const caller = (body: string) =>
	`${fsm(`let r;\nwhile (true) { S: await go.wait(1); ${body} }`, ports1)}\n${sub}`;

const cases: [string, string, string][] = [
	[
		"return in @Fsm",
		fsm("while (true) { S: await go.wait(1); x.pulse(); d.set(b); return; }"),
		"never returns",
	],
	[
		"action before the first await",
		fsm("while (true) { x.pulse(); S: await (go & b).wait(1); d.set(1); }"),
		"no action before the first await",
	],
	[
		"loop without await",
		fsm(
			"while (true) { S: await go.wait(1); d.set(1); while (b) { x.pulse(); } }",
		),
		"combinational loop",
	],
	[
		"let with a value",
		fsm("let v = go; while (true) { S: await v.wait(1); }"),
		"needs a Dff",
	],
	[
		"==",
		fsm("while (true) { S: await (go == b).wait(1); x.pulse(); d.set(1); }"),
		"use ===",
	],
	[
		"width",
		fsm(
			"while (true) { S: await (d.val === go).wait(1); x.pulse(); d.set(b); }",
		),
		"width mismatch: expected 4, got 1",
	],
	[
		"?: arm widths",
		fsm(
			"while (true) { S: await go.wait(1); x.pulse(); d.set(b ? d.val : b); }",
		),
		"width mismatch: 4 vs 1",
	],
	[
		"unused input",
		fsm("while (true) { S: await go.wait(1); x.pulse(); d.set(1); }"),
		"input b is never read",
	],
	[
		"double write",
		fsm(
			"while (true) { S: await (go & b).wait(1); x.pulse(); d.set(1); d.set(2); }",
		),
		"written twice in one segment",
	],
	[
		"unreachable",
		fsm(
			"while (true) { S: await (go & b).wait(1); x.pulse(); d.set(1); T: await ALWAYS_0.wait(1); U: await go.wait(1); }",
		),
		"state U is unreachable",
	],
	[
		"await outside a state",
		fsm(
			"while (true) { S: await go.wait(1); x.pulse(); if (await b) d.set(1); }",
		),
		"await marks a state",
	],
	[
		"await as a bare statement that is not a state",
		fsm(
			"while (true) { S: await (go & b).wait(1); x.pulse(); d.set(1); await b; }",
		),
		"await marks a state",
	],
	[
		"multi-bit pulse needs a value",
		fsm(
			"while (true) { S: await (go & b).wait(1); m.pulse(); d.set(1); }",
			P("go = Input(1)", "b = Input(1)", "m = Output(8)", "d = Dff(4)"),
		),
		"write m.pulse(value)",
	],
	[
		"upper-case collision",
		fsm(
			"while (true) { SendMsg: await go.wait(1); x.pulse(); SEND_MSG: await b.wait(1); d.set(1); }",
		),
		"both become SEND_MSG",
	],
	[
		"result read outside its done cycle",
		caller(
			"Call: r = await this.s({ a: b }); T: await go.wait(1); d.set(r); x.pulse();",
		),
		"valid only when leaving state Call",
	],
	[
		"result latched in its done cycle compiles",
		caller("Call: r = await this.s({ a: b }); d.set(r); x.pulse();"),
		"",
	],
	[
		"unconnected sub-FSM port",
		caller("Call: r = await this.s({}); d.set(r); x.pulse();"),
		"port a of s is not connected",
	],
	[
		"calling an @Fsm method",
		`${fsm("while (true) { S: await go.wait(1); x.pulse(); d.set(b ? 1 : 2); }")}\n@Fsm\nasync g(${P("c = Input(1)")}) { while (true) { T: await this.f({}); W: await c.wait(1); } }`,
		"only sub-FSMs can be called",
	],
	[
		"sub-FSM never called",
		`${fsm("while (true) { S: await (go & b).wait(1); x.pulse(); d.set(1); }")}\n${sub}`,
		"sub-FSM s is never called",
	],
	[
		"IDLE label in a sub-FSM",
		`${fsm("while (true) { S: await (go & b).wait(1); await this.s({ a: go }); x.pulse(); d.set(1); }")}\nasync s(${P("a = Input(1)")}) { Idle: await a.wait(1); }`,
		"implicit entry of a sub-FSM",
	],
	[
		"sub-FSM that can finish in its start cycle",
		`${fsm("let r;\nwhile (true) { S: await go.wait(1); C: r = await this.s({ a: b }); d.set(r); x.pulse(); }", ports1)}\nasync s(${P("a = Input(1)")}) { if (a) return a; W: await a.wait(1); return a; }`,
		"ends the sub-FSM in its start cycle",
	],
	[
		"two ports on one line",
		fsm(
			"while (true) { S: await (go & b).wait(1); x.pulse(); d.set(1); }",
			"{\n  go = Input(1), b = Input(1),\n  x = Output(1),\n  d = Dff(4),\n}",
		),
		"one port per line",
	],
];

describe("checker errors carry file:line:col", () => {
	for (const [what, body, msg] of cases)
		test(what, async () => {
			const err = await compileBody(body).then(
				() => "",
				(e: Error) => e.message,
			);
			if (msg === "") return expect(err).toBe("");
			expect(err).toMatch(/^x\.mjs:\d+:\d+: /);
			expect(err).toContain(msg);
		});
});
