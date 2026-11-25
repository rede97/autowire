// fsm checker: author mistakes are compile errors with file:line:col.
import { describe, expect, test } from "bun:test";
import { compileBody, compileText } from "./fixtures/fsm/compile.ts";

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
const callSub = `async s(${P("a = Input(1)", "y = Output(1)")}) { y.pulse(); W: await a.wait(1); return a; }`;
const caller = (body: string) =>
	`${fsm(`let r;\nwhile (true) { S: await go.wait(1); ${body} }`, ports1)}\n${sub}`;

const cases: [string, string, string][] = [
	[
		"throw Raise() outside a try",
		fsm(
			"while (true) { S: await go.wait(1); if (b) throw Raise(); x.pulse(); }",
		),
		"needs an enclosing try block",
	],
	[
		"throw of something else",
		fsm(
			"while (true) { try { S: await go.wait(1); if (b) throw 1; x.pulse(); } catch { T: await b.wait(1); } }",
		),
		"throw takes Raise()",
	],
	[
		"Escape after a statement",
		fsm(
			"while (true) { try { S: await go.wait(1); Escape(b); x.pulse(); } catch { T: await b.wait(1); } }",
		),
		"belongs at the start of a try block",
	],
	[
		"catch binds a value",
		fsm(
			"while (true) { try { Escape(b); S: await go.wait(1); x.pulse(); } catch (e) { T: await b.wait(1); } }",
		),
		"there is no exception value",
	],
	[
		"finally",
		fsm(
			"while (true) { try { Escape(b); S: await go.wait(1); x.pulse(); } catch { T: await b.wait(1); } finally { U: await go.wait(1); } }",
		),
		"finally is not supported",
	],
	[
		"constant Escape condition",
		fsm(
			"while (true) { try { Escape(ALWAYS_1); S: await go.wait(1); x.pulse(); } catch { T: await b.wait(1); } }",
		),
		"Escape condition is a constant",
	],
	[
		"Caller call inside a try",
		`${fsm("const reg = Caller(this.s, {});\nlet r;\nwhile (true) { S: await go.wait(1); try { Escape(b); C: r = await reg.call({ a: go }); x.pulse(); } catch { T: await b.wait(1); } }", ports1)}\n${sub}`,
		"cannot sit in a try block",
	],
	[
		"stateValues misses a state",
		`@Fsm({ stateValues: { S: 0 } })\nasync f(${ports}) {\nwhile (true) { S: await go.wait(1); x.pulse(); T: await b.wait(1); }\n}`,
		"stateValues misses T",
	],
	[
		"stateValues with stateEncoding",
		`@Fsm({ stateEncoding: "binary", stateValues: { S: 0, T: 1 } })\nasync f(${ports}) {\nwhile (true) { S: await go.wait(1); x.pulse(); T: await b.wait(1); }\n}`,
		"exclude each other",
	],
	[
		"stateValues too wide",
		`@Fsm({ stateValues: { S: 0, T: 2 } })\nasync f(${ports}) {\nwhile (true) { S: await go.wait(1); x.pulse(); T: await b.wait(1); }\n}`,
		"does not fit 1 bits",
	],
	[
		"stateValues repeats a value",
		`@Fsm({ stateValues: { S: 1, T: 1 } })\nasync f(${ports}) {\nwhile (true) { S: await go.wait(1); x.pulse(); T: await b.wait(1); }\n}`,
		"are both 1",
	],
	[
		"return in @Fsm",
		fsm(
			"while (true) { S: await (go & b).wait(1); x.pulse(); d.set(1); return; }",
		),
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
		fsm("while (true) { S: await go.wait(1); x.pulse(); d.set(b); }"),
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
		"outside the segment that follows it",
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
		"instantiate it with Instance",
	],
	[
		"sub-FSM never called",
		`${fsm("while (true) { S: await (go & b).wait(1); x.pulse(); d.set(1); }")}\n${sub}`,
		"sub-FSM s is never called",
	],
	[
		"sub-FSM call without a label",
		`${fsm("while (true) { S: await (go & b).wait(1); await this.s({ a: go }); x.pulse(); d.set(1); }")}\nasync s(${P("a = Input(1)")}) { W: await a.wait(1); }`,
		"label the call",
	],
	[
		"sub-FSM returns differ",
		`${fsm("let r;\nwhile (true) { S: await go.wait(1); C: r = await this.s({ a: b }); d.set(r); x.pulse(); }", ports1)}\nasync s(${P("a = Input(1)")}) { W: await a.wait(1); if (a) return a; return ALWAYS_0; }`,
		"give different values",
	],
	[
		"sub-FSM with a valueless path",
		`${fsm("let r;\nwhile (true) { S: await go.wait(1); C: r = await this.s({ a: b }); d.set(r); x.pulse(); }", ports1)}\nasync s(${P("a = Input(1)")}) { W: await a.wait(1); if (a) return a; }`,
		"without return <value>",
	],
	[
		"recursive sub-FSM",
		`${fsm("while (true) { S: await go.wait(1); C: await this.s({ a: b }); x.pulse(); d.set(1); }")}\nasync s(${P("a = Input(1)")}) { W: await a.wait(1); R: await this.s({ a }); }`,
		"recursive sub-FSM call",
	],
	[
		"let read before it is assigned",
		fsm(
			"let r;\nwhile (true) { S: await (go & b).wait(1); x.pulse(); d.set(r); }",
		),
		"read before it is assigned",
	],
	[
		"push on a PopPort",
		fsm(
			"while (true) { S: await (go & b).wait(1); x.pulse(); d.set(1); T: await p.push(1); }",
			P(
				"go = Input(1)",
				"b = Input(1)",
				"x = Output(1)",
				"d = Dff(4)",
				"p = PopPort(1)",
			),
		),
		"push needs a PushPort or a Chan",
	],
	[
		"popped data never read",
		fsm(
			"while (true) { S: await (go & b).wait(1); x.pulse(); d.set(1); T: await p.pop(); }",
			P(
				"go = Input(1)",
				"b = Input(1)",
				"x = Output(1)",
				"d = Dff(4)",
				"p = PopPort(1)",
			),
		),
		"the data popped from p is never read",
	],
	[
		"push data reads a let",
		fsm(
			"let r;\nwhile (true) { S: await (go & b).wait(1); x.pulse(); d.set(1); T: r = await p.pop(); U: await q.push(r); }",
			P(
				"go = Input(1)",
				"b = Input(1)",
				"x = Output(1)",
				"d = Dff(4)",
				"p = PopPort(1)",
				"q = PushPort(1)",
			),
		),
		"valid only in the segment",
	],
	[
		"Chan pushed and popped by one module",
		fsm(
			"const c = Chan(1);\nlet r;\nwhile (true) { S: await (go & b).wait(1); x.pulse(); T: await c.push(go); U: r = await c.pop(); d.set(r); }",
			ports1,
		),
		"pushes and pops on one channel",
	],
	[
		"Chan end without an owner",
		fsm(
			"const c = Chan(1);\nwhile (true) { S: await (go & b).wait(1); x.pulse(); d.set(1); T: await c.push(go); }",
		),
		"nobody pops from channel c",
	],
	[
		"Instance of a sub-FSM",
		`${fsm("Instance(this.s, { a: go });\nwhile (true) { S: await (go & b).wait(1); x.pulse(); d.set(1); }")}\n${sub}`,
		"Instance takes an @Fsm method",
	],
	[
		"Instance port not connected",
		`${fsm("Instance(this.g, {});\nwhile (true) { S: await (go & b).wait(1); x.pulse(); d.set(1); }")}\n@Fsm\nasync g(${P("c = Input(1)", "y = Output(1)")}) { while (true) { W: await c.wait(1); y.pulse(); } }`,
		"port c of g is not connected",
	],
	[
		"Output driven by an instance and pulsed",
		`${fsm("Instance(this.g, { c: go, y: x });\nwhile (true) { S: await (go & b).wait(1); x.pulse(); d.set(1); }")}\n@Fsm\nasync g(${P("c = Input(1)", "y = Output(1)")}) { while (true) { W: await c.wait(1); y.pulse(); } }`,
		"x is driven by u_g",
	],
	[
		"Instance inside the loop",
		`${fsm("while (true) { S: await (go & b).wait(1); x.pulse(); d.set(1); Instance(this.g, { c: go, y: x }); }")}\n@Fsm\nasync g(${P("c = Input(1)", "y = Output(1)")}) { while (true) { W: await c.wait(1); y.pulse(); } }`,
		"belongs before while (true)",
	],
	[
		"Caller of an @Fsm method",
		`${fsm("const c = Caller(this.g, {});\nwhile (true) { S: await (go & b).wait(1); x.pulse(); d.set(1); }")}\n@Fsm\nasync g(${P("c = Input(1)", "y = Output(1)")}) { while (true) { W: await c.wait(1); y.pulse(); } }`,
		"Caller takes a sub-FSM",
	],
	[
		"Caller leaves an Output unbound",
		`${fsm("const c = Caller(this.s, {});\nwhile (true) { S: await (go & b).wait(1); x.pulse(); d.set(1); }")}\n${callSub}`,
		"y of s is not an Input: bind it",
	],
	[
		"Caller call without a label",
		`${fsm("const c = Caller(this.s, { y: x });\nwhile (true) { S: await (go & b).wait(1); d.set(1); await c.call({ a: go }); }")}\n${callSub}`,
		"label the call",
	],
	[
		"Caller call misses an argument",
		`${fsm("const c = Caller(this.s, { y: x });\nwhile (true) { S: await (go & b).wait(1); d.set(1); C: await c.call({}); }")}\n${callSub}`,
		"port a of the message is not connected",
	],
	[
		"Caller called twice, result ignored, compiles",
		`${fsm("const c = Caller(this.s, { y: x });\nwhile (true) { S: await (go & b).wait(1); d.set(1); C: await c.call({ a: go }); D: await c.call({ a: b }); }")}\n${callSub}`,
		"",
	],
	[
		"Caller port name reserved",
		`${fsm("const c = Caller(this.t, { y: x });\nwhile (true) { S: await (go & b).wait(1); d.set(1); C: await c.call({ req: go }); }")}\nasync t(${P("req = Input(1)", "y = Output(1)")}) { y.pulse(); W: await req.wait(1); }`,
		"reserved for the Caller server",
	],
	[
		"record field never read",
		fsm(
			"let r;\nwhile (true) { S: await (go & b).wait(1); x.pulse(); T: r = await p.pop(); d.set(r.a ? 1 : 2); }",
			P(
				"go = Input(1)",
				"b = Input(1)",
				"x = Output(1)",
				"d = Dff(4)",
				"p = PopPort({ a: 1, z: 1 })",
			),
		),
		"never read (z)",
	],
	[
		"record message read whole",
		fsm(
			"let r;\nwhile (true) { S: await (go & b).wait(1); x.pulse(); T: r = await p.pop(); d.set(r); }",
			P(
				"go = Input(1)",
				"b = Input(1)",
				"x = Output(1)",
				"d = Dff(4)",
				"p = PopPort({ a: 4 })",
			),
		),
		"r is a message: read one of its fields (r.a)",
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

/** @SvEnum sources for the enum checks (§2.8). */
const OP =
	'@SvEnum({ pkg: "e_pkg" })\nclass Op { static A = 0; static B = 1; }\n';
const EP = P("go = Input(1)", "i = Input(Op)", "o = Output(Op)");
const eg = (body: string, head = OP) =>
	`${head}@FsmGroup\nclass G {\n${fsm(body, EP)}\n}\n`;
/** Whole sources (x.mjs plus imported files) for front-end errors. */
const files: [string, string, Record<string, string>, string][] = [
	[
		"number into an enum output",
		eg("while (true) { S: await go.wait(1); o.pulse(1); }"),
		{},
		"expected a Op value (Op.<MEMBER>), not a number",
	],
	[
		"bit operator on an enum",
		eg("while (true) { S: await (i | go).wait(1); o.pulse(Op.A); }"),
		{},
		"only compares",
	],
	[
		"enum compared with a number",
		eg("while (true) { S: await (i === 1).wait(1); o.pulse(Op.A); }"),
		{},
		"compare a Op value with another one",
	],
	[
		"wait on an enum",
		eg("while (true) { S: await i.wait(1); o.pulse(Op.A); }"),
		{},
		"compare an enum with a member",
	],
	[
		"unknown enum member",
		eg("while (true) { S: await (i === Op.C).wait(1); o.pulse(Op.A); }"),
		{},
		"Op has no member C",
	],
	[
		"enum values repeat",
		eg(
			"while (true) { S: await go.wait(1); o.pulse(Op.A); }",
			'@SvEnum({ pkg: "e_pkg" })\nclass Op { static A = 0; static B = 0; }\n',
		),
		{},
		"Op.A and Op.B are both 0",
	],
	[
		"enum without a package",
		eg(
			"while (true) { S: await go.wait(1); o.pulse(Op.A); }",
			"@SvEnum({})\nclass Op { static A = 0; static B = 1; }\n",
		),
		{},
		"names its SV package",
	],
	[
		"enum width too small",
		eg(
			"while (true) { S: await go.wait(1); o.pulse(Op.A); }",
			'@SvEnum({ pkg: "e_pkg", width: 1 })\nclass Op { static A = 0; static B = 2; }\n',
		),
		{},
		"Op needs 2 bits for value 2, width is 1",
	],
	[
		"two enums share an SV member",
		eg(
			"while (true) { S: await go.wait(1); o.pulse(Op.A); }",
			`${OP}@SvEnum({ pkg: "e_pkg", prefix: "OP" })\nclass Op2 { static A = 0; }\n`,
		),
		{},
		"e_pkg::OP_A is a member of Op too",
	],
	[
		"sync interface method declares a const",
		`@FsmPort\nclass Rd {\n  constructor() { this.req = Output(1); }\n  kick(a) { const z = a; this.req.pulse(z); }\n}\n@FsmGroup\nclass G {\n${fsm("while (true) { S: await (go & b).wait(1); rd.kick(go); x.pulse(); d.set(1); }", P("go = Input(1)", "b = Input(1)", "x = Output(1)", "d = Dff(4)", "rd = new Rd()"))}\n}\n`,
		{},
		"holds actions only",
	],
	[
		"interface constructor arguments",
		`@FsmPort\nclass Rd {\n  constructor(w) { this.req = Output(w); }\n}\n@FsmGroup\nclass G {\n${fsm("while (true) { S: await (go & b).wait(1); x.pulse(); d.set(1); }", P("go = Input(1)", "b = Input(1)", "x = Output(1)", "d = Dff(4)", "rd = new Rd()"))}\n}\n`,
		{},
		"Rd takes 1 argument(s)",
	],
	[
		"import of a name the file does not export",
		`import { Nope } from "./lib.mjs";\n@FsmGroup\nclass G {\n${fsm("while (true) { S: await (go & b).wait(1); x.pulse(); d.set(1); }")}\n}\n`,
		{ "lib.mjs": 'export const pkg = SvPackage("p", {});\n' },
		"exports no @FsmGroup, @FsmPort, @SvEnum or SvPackage named Nope",
	],
	[
		"import cycle",
		`import { L } from "./lib.mjs";\n@FsmGroup\nexport class G {\n${fsm("while (true) { S: await (go & b).wait(1); x.pulse(); d.set(1); }")}\n}\n`,
		{
			"lib.mjs": 'import { G } from "./x.mjs";\n@FsmGroup\nexport class L {}\n',
		},
		"import cycle",
	],
];

describe("source-level errors", () => {
	for (const [what, text, more, msg] of files)
		test(what, async () => {
			const err = await compileText(text, more).then(
				() => "",
				(e: Error) => e.message,
			);
			expect(err).toMatch(/^\w+\.mjs:\d+:\d+: /);
			expect(err).toContain(msg);
		});
});

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
